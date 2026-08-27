// /api/data-svar — Web mode: agentic discovery + generation (admin-only).
// Spec: docs/superpowers/specs/2026-07-03-web-data-svar-design.md
import { adminGate, extractByokKey, type IpContext } from "./_lib/auth.ts";
import { resolveLlm } from "./_lib/llm-choice.ts";
import { runProviderAgenticStream } from "./_lib/providers/agentic.ts";
import { makeOpenAiCompatTurn } from "./_lib/providers/openai-compat.ts";
import { makeOpenAiResponsesTurn } from "./_lib/providers/openai-responses.ts";
import { type AgenticResumeState, runAgenticStream } from "./_lib/anthropic.ts";
import { loadRegistry, renderRegistryBlock } from "./_lib/registry.ts";
import { searchCatalog } from "./_lib/tools/search-catalog.ts";
import { tableMetadata } from "./_lib/tools/table-metadata.ts";
import { probeUrl } from "./_lib/tools/probe.ts";
import { injectBeforeDone } from "./_lib/sse-util.ts";
import {
  buildDataSvarSystem, coerceDataMode, progressLabel, questionTurn, repairTurn, TOOL_DEFS,
} from "./_lib/data-svar-prompt.ts";

interface RepairBody { script: string; error: string; round: number; }
interface ResumeBody { state?: AgenticResumeState; probed?: unknown; }
interface RequestBody {
  // multi-provider-runden 2026-08-27: valgfri egen leverandør + kvalitetsnivå.
  provider?: unknown;
  quality?: unknown;
  question?: string;
  mode?: string;
  script?: string;
  repair?: RepairBody;
  resume?: ResumeBody;
}

// Continuation protocol (see runAgenticStream): each invocation runs one API
// turn and, if not finished, ends with {type:"continue", state, probed}; the
// client re-POSTs the same body plus `resume: {state, probed}`. The loop
// state that made 120k too small: tool results and hosted web_search blocks
// ride along in `state.messages`, so resume bodies run to a few hundred kB.
const MAX_BODY_BYTES = 2_000_000;

function validResumeState(s: AgenticResumeState | undefined): s is AgenticResumeState {
  return !!s && Array.isArray(s.messages) && s.messages.length >= 1 && s.messages.length <= 400 &&
    Number.isInteger(s.turn) && s.turn >= 1 && s.turn <= 64 &&
    Number.isInteger(s.clientCalls) && s.clientCalls >= 0 && s.clientCalls <= 200 &&
    typeof s.usage === "object" && s.usage !== null;
}

export default async (request: Request, context: IpContext): Promise<Response> => {
  const gateResp = await adminGate(request, { endpoint: "data-svar", maxBodyBytes: MAX_BODY_BYTES, allowByok: true, allowLlmKey: true }, context);
  if (gateResp) return gateResp;

  let body: RequestBody;
  try { body = await request.json(); } catch { return new Response("Invalid JSON", { status: 400 }); }
  const question = (body.question ?? "").trim();
  if (!question) return new Response("Missing question", { status: 400 });
  const repair = body.repair;
  if (repair && (!repair.script || !repair.error || !(repair.round >= 1 && repair.round <= 3))) {
    return new Response("Invalid repair payload", { status: 400 });
  }
  let resumeState: AgenticResumeState | undefined;
  if (body.resume) {
    if (!validResumeState(body.resume.state)) {
      return new Response("Invalid resume payload", { status: 400 });
    }
    const u = body.resume.state.usage as Record<string, unknown>;
    resumeState = {
      messages: body.resume.state.messages,
      turn: body.resume.state.turn,
      clientCalls: body.resume.state.clientCalls,
      usage: {
        inputTokens: Number(u.inputTokens) || 0,
        outputTokens: Number(u.outputTokens) || 0,
        cacheReadTokens: Number(u.cacheReadTokens) || 0,
        cacheCreationTokens: Number(u.cacheCreationTokens) || 0,
      },
    };
  }

  const byokKey = extractByokKey(request);
  const choice = resolveLlm(request, body, "data-svar");
  if (choice instanceof Response) return choice;

  const origin = new URL(request.url).origin;
  let registry;
  try { registry = await loadRegistry(origin); } catch (e) {
    console.error("data-svar: registry load failed:", e);
    return new Response("Kilderegister utilgjengelig", { status: 502 });
  }

  const mode = coerceDataMode(body.mode);
  const system = buildDataSvarSystem(mode, renderRegistryBlock(registry));

  // Deterministic source manifest: collected from probe calls, not model text.
  // On resume, re-seeded from the previous invocations' manifest so the final
  // sources event covers the whole run.
  const probed: { url: string; ok: boolean; cors: boolean; viaProxy: boolean }[] = [];
  if (body.resume && Array.isArray(body.resume.probed)) {
    for (const p of (body.resume.probed as Record<string, unknown>[]).slice(0, 60)) {
      if (p && typeof p.url === "string") {
        probed.push({ url: p.url, ok: !!p.ok, cors: !!p.cors, viaProxy: !!p.viaProxy });
      }
    }
  }

  const executeTool = async (name: string, input: Record<string, unknown>): Promise<string> => {
    if (name === "search_catalog") {
      return JSON.stringify(await searchCatalog(String(input.source ?? ""), String(input.query ?? ""), { registry }));
    }
    if (name === "table_metadata") {
      return JSON.stringify(await tableMetadata(String(input.source ?? ""), String(input.table_id ?? ""), { registry }));
    }
    if (name === "probe") {
      const url = String(input.url ?? "");
      const r = await probeUrl(url);
      probed.push({ url, ok: r.ok, cors: r.cors, viaProxy: r.ok && !r.cors });
      return JSON.stringify(r);
    }
    throw new Error(`ukjent verktøy: ${name}`);
  };

  const userContent = repair
    ? repairTurn(question, repair.script, repair.error, repair.round)
    : questionTurn(question, body.script);

  // Leverandør-dispatch (multi-provider-runden 2026-08-27). Samme form som
  // askstats svar.ts: de to OpenAI-typene går gjennom det ORDRETT kopierte
  // runProviderAgenticStream med sin egen runTurn, anthropic-compat blir i
  // den native løkka med apiBase satt.
  const commonOpts = {
    system,
    userContent,
    tools: TOOL_DEFS,
    executeTool,
    progressLabel,
    maxTokens: 8192,
    maxClientToolCalls: 12,
    resume: resumeState,
    continueExtra: () => ({ probed }),
  };
  const providerDeps = { timeoutMs: 180_000, retries: 1 };
  let inner: ReadableStream<Uint8Array>;
  if (choice.provider?.type === "openai-compat") {
    inner = runProviderAgenticStream({
      ...commonOpts,
      deps: providerDeps,
      runTurn: makeOpenAiCompatTurn(choice.provider),
    });
  } else if (choice.provider?.type === "openai-responses") {
    inner = runProviderAgenticStream({
      ...commonOpts,
      deps: providerDeps,
      runTurn: makeOpenAiResponsesTurn(choice.provider),
    });
  } else {
    inner = runAgenticStream({
      ...commonOpts,
      apiKey: choice.apiKey,
      model: choice.provider ? choice.provider.model : choice.model,
      cacheTtl: "1h",
      effort: choice.effort,
      apiBase: choice.provider?.type === "anthropic-compat" ? choice.provider.baseUrl : undefined,
    });
  }

  const stream = injectBeforeDone(inner, () =>
    probed.length ? { type: "sources", sources: probed } : null);

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
};
