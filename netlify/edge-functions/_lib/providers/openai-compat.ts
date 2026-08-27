// OpenAI chat-completions adapter (spec A3, tier 2). Translates between the
// Anthropic-format resume state and the chat.completions wire format; one
// non-streaming turn per call. The lowest-common-denominator API most
// providers implement (Mistral/Groq/DeepSeek/Ollama/vLLM/gateways).
import { type AgenticResumeState, fetchWithRetry, type RetryDeps } from "../anthropic.ts";
import { type ProviderConfig, scrubKey } from "./config.ts";
import type { ProviderTurnResult, RunTurn, TurnOpts } from "./agentic.ts";

export function toOpenAiTools(anthropicTools: unknown[]): unknown[] {
  return (anthropicTools as Record<string, unknown>[]).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.input_schema ?? { type: "object", properties: {} },
    },
  }));
}

export function toOpenAiMessages(
  system: string,
  messages: Record<string, unknown>[],
): unknown[] {
  const out: unknown[] = [{ role: "system", content: system }];
  for (const m of messages) {
    const content = m.content;
    if (typeof content === "string") {
      out.push({ role: m.role, content });
      continue;
    }
    const blocks = (Array.isArray(content) ? content : []) as Record<string, unknown>[];
    if (m.role === "assistant") {
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      const toolCalls = blocks.filter((b) => b.type === "tool_use").map((b) => ({
        id: b.id,
        type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
      const msg: Record<string, unknown> = { role: "assistant", content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    } else {
      for (const b of blocks) {
        if (b.type === "tool_result") {
          out.push({ role: "tool", tool_call_id: b.tool_use_id, content: String(b.content ?? "") });
        } else if (b.type === "text") {
          out.push({ role: "user", content: b.text ?? "" });
        }
      }
    }
  }
  return out;
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

function throwClassified(status: number, detail: string, cfg: ProviderConfig, hadTools: boolean): never {
  console.error(`LLM provider error ${status}: ${scrubKey(detail, cfg.key)}`);
  if (status === 400 && hadTools && /tool/i.test(detail)) {
    throw new Error("svar krever en modell med verktøystøtte (tool-calling) — leverandøren avviste tools-parameteren");
  }
  throw new Error(`Leverandørfeil ${status}`);
}

/**
 * POST to /chat/completions. Newer OpenAI chat models reject `max_tokens`
 * (they want `max_completion_tokens`); most third-party compat providers
 * still expect `max_tokens`. So send `max_tokens` first, and if that's
 * rejected with a 400 whose detail mentions max_tokens, retry ONCE with
 * `max_completion_tokens` in its place. Any other failure (including a
 * failure of the retry) is classified/thrown as before. Reads each
 * response body exactly once.
 */
// deno-lint-ignore no-explicit-any
async function postChatCompletion(
  cfg: ProviderConfig,
  body: Record<string, unknown>,
  hadTools: boolean,
  deps: RetryDeps | undefined,
): Promise<any> {
  const post = (b: Record<string, unknown>) =>
    fetchWithRetry(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.key}` },
      body: JSON.stringify(b),
    }, deps);

  let resp = await post(body);
  if (resp.ok) return await resp.json();
  let detail = await resp.text().catch(() => "");
  if (resp.status === 400 && "max_tokens" in body && /max_tokens/i.test(detail)) {
    const retryBody: Record<string, unknown> = { ...body };
    delete retryBody.max_tokens;
    retryBody.max_completion_tokens = body.max_tokens;
    resp = await post(retryBody);
    if (resp.ok) return await resp.json();
    detail = await resp.text().catch(() => "");
  }
  throwClassified(resp.status, detail, cfg, hadTools);
}

export function makeOpenAiCompatTurn(cfg: ProviderConfig): RunTurn {
  return async (state: AgenticResumeState, opts: TurnOpts): Promise<ProviderTurnResult> => {
    const body: Record<string, unknown> = {
      model: cfg.model,
      max_tokens: opts.maxTokens,
      stream: false,
      messages: toOpenAiMessages(opts.system, state.messages),
    };
    if (opts.tools.length) body.tools = toOpenAiTools(opts.tools);
    const json = await postChatCompletion(cfg, body, opts.tools.length > 0, opts.deps);
    const msg = (json?.choices?.[0]?.message ?? {}) as Record<string, unknown>;
    const toolUses = (Array.isArray(msg.tool_calls) ? msg.tool_calls : [])
      .map((tc: Record<string, Record<string, unknown>>) => ({
        id: String(tc.id ?? ""),
        name: String(tc.function?.name ?? ""),
        input: safeParseJson(tc.function?.arguments),
      }));
    return {
      text: typeof msg.content === "string" ? msg.content : "",
      toolUses,
      searchNotes: [],
      stop: toolUses.length ? "tool_use" : "end",
      usage: {
        inputTokens: json?.usage?.prompt_tokens ?? 0,
        outputTokens: json?.usage?.completion_tokens ?? 0,
      },
    };
  };
}

/** Single text turn without tools — tolk-resultat (spec A5). */
export async function messageOpenAiCompat(
  cfg: ProviderConfig,
  o: { system: string; prompt: string; maxTokens: number },
  deps?: RetryDeps,
): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
  const json = await postChatCompletion(cfg, {
    model: cfg.model,
    max_tokens: o.maxTokens,
    stream: false,
    messages: [{ role: "system", content: o.system }, { role: "user", content: o.prompt }],
  }, false, deps);
  return {
    text: String(json?.choices?.[0]?.message?.content ?? ""),
    usage: {
      inputTokens: json?.usage?.prompt_tokens ?? 0,
      outputTokens: json?.usage?.completion_tokens ?? 0,
    },
  };
}
