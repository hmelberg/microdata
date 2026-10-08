// OpenAI Responses API adapter (spec A6): native hosted web_search + server-
// side conversation state. Non-streaming per hop by design — the hop model and
// the edge-generated SSE progress are reused unchanged; provider-side
// streaming is a later optimization, not a capability gap. State contract:
// prevResponseId carries the stored-conversation id through the client resume
// round-trip; each follow-up sends ONLY the pending function_call_output items.
import { type AgenticResumeState, fetchWithRetry, type RetryDeps } from "../anthropic.ts";
import { type ProviderConfig, scrubKey } from "./config.ts";
import type { ProviderTurnResult, RunTurn, TurnOpts } from "./agentic.ts";
import { erTokenTakFeil, senketTak } from "./fallback.ts";

function toResponsesTools(anthropicTools: unknown[]): unknown[] {
  const fns = (anthropicTools as Record<string, unknown>[]).map((t) => ({
    type: "function",
    name: t.name,
    description: t.description ?? "",
    parameters: t.input_schema ?? { type: "object", properties: {} },
  }));
  return [...fns, { type: "web_search" }];
}

/** null = uparsbare argumenter (typisk et avkortet verktøykall). */
function safeParseJson(raw: unknown): Record<string, unknown> | null {
  if (raw === undefined || raw === null || raw === "") return {};
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch (_) {
    return null;
  }
}

/** POST /responses; en 400 om for høyt output-tak får ÉTT nytt forsøk med
 *  taket feilmeldingen oppgir (gpt-4o: 16384), ellers uten parameteren. */
async function postResponses(
  cfg: ProviderConfig,
  body: Record<string, unknown>,
  hadTools: boolean,
  deps: RetryDeps | undefined,
  // deno-lint-ignore no-explicit-any
): Promise<any> {
  const post = (b: Record<string, unknown>) =>
    fetchWithRetry(`${cfg.baseUrl}/responses`, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.key}` },
      body: JSON.stringify(b),
    }, deps);
  const resp = await post(body);
  if (resp.ok) return await resp.json();
  const detail = await resp.text().catch(() => "");
  const ny = resp.status === 400 && erTokenTakFeil(detail)
    ? senketTak(body, "max_output_tokens", detail)
    : null;
  if (!ny) return throwUpstream(resp.status, detail, cfg, hadTools);
  const igjen = await post(ny);
  if (igjen.ok) return await igjen.json();
  return throwUpstream(igjen.status, await igjen.text().catch(() => ""), cfg, hadTools);
}

function throwUpstream(status: number, detail: string, cfg: ProviderConfig, hadTools: boolean): never {
  console.error(`LLM provider error ${status}: ${scrubKey(detail, cfg.key)}`);
  if (status === 400 && /store|previous_response/i.test(detail)) {
    throw new Error("leverandøren støtter ikke lagret samtaletilstand (store) — bruk typen openai-kompatibel i stedet");
  }
  if (status === 400 && hadTools && /tool/i.test(detail)) {
    throw new Error("svar krever en modell med verktøystøtte (tool-calling) — leverandøren avviste tools-parameteren");
  }
  throw new Error(`Leverandørfeil ${status}`);
}

function parseOutput(json: Record<string, unknown>): ProviderTurnResult {
  const outItems = (Array.isArray(json?.output) ? json.output : []) as Record<string, unknown>[];
  const searchNotes = outItems
    .filter((o) => o.type === "web_search_call")
    .map((o) => {
      const action = (o.action ?? {}) as Record<string, unknown>;
      return `🔎 Websøk: ${String(action.query ?? "").slice(0, 120)}`;
    });
  // status "incomplete" er en avkortet tur, ikke et svar (review-runden
  // 2026-10-08: den ble meldt som `done`, og et avkortet function_call ga
  // run_code med tomt script). Bare max_output_tokens er en avkorting; andre
  // grunner (content_filter) og "failed" er feil.
  if (json?.status === "failed") {
    const err = (json.error ?? {}) as Record<string, unknown>;
    throw new Error(`Leverandøren avbrøt svaret (${String(err.code ?? err.message ?? "failed").slice(0, 100)})`);
  }
  const ufullstendig = json?.status === "incomplete";
  const grunn = String((json?.incomplete_details as Record<string, unknown> | undefined)?.reason ?? "");
  if (ufullstendig && grunn && grunn !== "max_output_tokens") {
    throw new Error(`Leverandøren avbrøt svaret (${grunn.slice(0, 100)})`);
  }
  const parsed = outItems
    .filter((o) => o.type === "function_call")
    .map((o) => ({
      id: String(o.call_id ?? ""),
      name: String(o.name ?? ""),
      input: safeParseJson(o.arguments),
    }));
  const avkortet = ufullstendig || parsed.some((t) => t.input === null);
  const toolUses = parsed.map((t) => ({ ...t, input: t.input ?? {} }));
  const text = outItems
    .filter((o) => o.type === "message")
    .flatMap((o) => (Array.isArray(o.content) ? o.content : []) as Record<string, unknown>[])
    .filter((c) => c.type === "output_text")
    .map((c) => String(c.text ?? ""))
    .join("");
  const usage = (json?.usage ?? {}) as Record<string, number>;
  return {
    text,
    toolUses,
    searchNotes,
    stop: avkortet ? "max_tokens" : toolUses.length ? "tool_use" : "end",
    usage: { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 },
    responseId: String(json?.id ?? ""),
  };
}

export function makeOpenAiResponsesTurn(cfg: ProviderConfig): RunTurn {
  return async (state: AgenticResumeState, opts: TurnOpts): Promise<ProviderTurnResult> => {
    const body: Record<string, unknown> = {
      model: cfg.model,
      max_output_tokens: opts.maxTokens,
      stream: false,
      store: true,
      tools: toResponsesTools(opts.tools),
    };
    if (state.prevResponseId) {
      body.previous_response_id = state.prevResponseId;
      const last = state.messages[state.messages.length - 1] as Record<string, unknown>;
      const blocks = (Array.isArray(last?.content) ? last.content : []) as Record<string, unknown>[];
      body.input = blocks
        .filter((b) => b.type === "tool_result")
        .map((b) => ({ type: "function_call_output", call_id: b.tool_use_id, output: String(b.content ?? "") }));
    } else {
      body.instructions = opts.system;
      // Første tur: forhistorikken (agentic.ts seeder den foran dagens
      // spørsmål) går med som rolle-meldinger, dagens spørsmål SIST. Før ble
      // messages[0] sendt alene — med historikk var det den ELDSTE turen.
      const turer = (state.messages as Record<string, unknown>[])
        .filter((m) => typeof m.content === "string");
      body.input = turer.length === 1
        ? turer[0].content
        : turer.map((m) => ({ role: m.role, content: m.content }));
    }
    return parseOutput(await postResponses(cfg, body, true, opts.deps));
  };
}

/** Single text turn without tools — tolk-resultat (spec A5). store:false: no
 *  follow-up will reference this response, so nothing needs persisting. */
export async function messageOpenAiResponses(
  cfg: ProviderConfig,
  o: { system: string; prompt: string; maxTokens: number },
  deps?: RetryDeps,
): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
  const parsed = parseOutput(await postResponses(cfg, {
    model: cfg.model,
    max_output_tokens: o.maxTokens,
    stream: false,
    store: false,
    instructions: o.system,
    input: o.prompt,
  }, false, deps));
  return { text: parsed.text, usage: parsed.usage };
}
