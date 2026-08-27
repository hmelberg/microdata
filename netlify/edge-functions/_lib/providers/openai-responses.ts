// OpenAI Responses API adapter (spec A6): native hosted web_search + server-
// side conversation state. Non-streaming per hop by design — the hop model and
// the edge-generated SSE progress are reused unchanged; provider-side
// streaming is a later optimization, not a capability gap. State contract:
// prevResponseId carries the stored-conversation id through the client resume
// round-trip; each follow-up sends ONLY the pending function_call_output items.
import { type AgenticResumeState, fetchWithRetry, type RetryDeps } from "../anthropic.ts";
import { type ProviderConfig, scrubKey } from "./config.ts";
import type { ProviderTurnResult, RunTurn, TurnOpts } from "./agentic.ts";

function toResponsesTools(anthropicTools: unknown[]): unknown[] {
  const fns = (anthropicTools as Record<string, unknown>[]).map((t) => ({
    type: "function",
    name: t.name,
    description: t.description ?? "",
    parameters: t.input_schema ?? { type: "object", properties: {} },
  }));
  return [...fns, { type: "web_search" }];
}

function safeParseJson(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v as Record<string, unknown> : {};
  } catch (_) {
    return {};
  }
}

async function throwUpstream(resp: Response, cfg: ProviderConfig, hadTools: boolean): Promise<never> {
  const detail = await resp.text().catch(() => "");
  console.error(`LLM provider error ${resp.status}: ${scrubKey(detail, cfg.key)}`);
  if (resp.status === 400 && /store|previous_response/i.test(detail)) {
    throw new Error("leverandøren støtter ikke lagret samtaletilstand (store) — bruk typen openai-kompatibel i stedet");
  }
  if (resp.status === 400 && hadTools && /tool/i.test(detail)) {
    throw new Error("svar krever en modell med verktøystøtte (tool-calling) — leverandøren avviste tools-parameteren");
  }
  throw new Error(`Leverandørfeil ${resp.status}`);
}

function parseOutput(json: Record<string, unknown>): ProviderTurnResult {
  const outItems = (Array.isArray(json?.output) ? json.output : []) as Record<string, unknown>[];
  const searchNotes = outItems
    .filter((o) => o.type === "web_search_call")
    .map((o) => {
      const action = (o.action ?? {}) as Record<string, unknown>;
      return `🔎 Websøk: ${String(action.query ?? "").slice(0, 120)}`;
    });
  const toolUses = outItems
    .filter((o) => o.type === "function_call")
    .map((o) => ({
      id: String(o.call_id ?? ""),
      name: String(o.name ?? ""),
      input: safeParseJson(o.arguments),
    }));
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
    stop: toolUses.length ? "tool_use" : "end",
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
      const first = state.messages[0] as Record<string, unknown>;
      body.input = typeof first?.content === "string" ? first.content : "";
    }
    const resp = await fetchWithRetry(`${cfg.baseUrl}/responses`, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.key}` },
      body: JSON.stringify(body),
    }, opts.deps);
    if (!resp.ok) await throwUpstream(resp, cfg, true);
    return parseOutput(await resp.json());
  };
}

/** Single text turn without tools — tolk-resultat (spec A5). store:false: no
 *  follow-up will reference this response, so nothing needs persisting. */
export async function messageOpenAiResponses(
  cfg: ProviderConfig,
  o: { system: string; prompt: string; maxTokens: number },
  deps?: RetryDeps,
): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
  const resp = await fetchWithRetry(`${cfg.baseUrl}/responses`, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.key}` },
    body: JSON.stringify({
      model: cfg.model,
      max_output_tokens: o.maxTokens,
      stream: false,
      store: false,
      instructions: o.system,
      input: o.prompt,
    }),
  }, deps);
  if (!resp.ok) await throwUpstream(resp, cfg, false);
  const parsed = parseOutput(await resp.json());
  return { text: parsed.text, usage: parsed.usage };
}
