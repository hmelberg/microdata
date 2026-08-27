// Single-shot leverandørlag (spec 2026-08-27-multi-provider-byok §3).
//
// askstat bygget BARE leverandørstøtte for den agentiske veien — men fire av
// microdatas fem endepunkter er single-shot (ett system-prompt, ett
// bruker-prompt, strømmet tilbake). Dette laget er derfor ny kode, ikke en
// kopi, og speiler streamAnthropic/messageAnthropic én-til-én slik at hvert
// endepunkt bare bytter ut ETT uttrykk.
//
// KONTRAKTEN UTAD ER UENDRET: vi sender nøyaktig de samme SSE-hendelsene som
// transformAnthropicStream ({type:"text"} … {type:"done"} / {type:"error"}),
// så js/ai-chat.js sin strømleser trenger ingen endring. Cache-tellerne er
// alltid 0 for de to OpenAI-formene — de har ikke prompt-caching, og klienten
// bare viser tallene.
//
// MODELLEN KOMMER ALLTID FRA cfg.model. `choice` bidrar KUN med effort her:
// på leverandørveien er det brukerens eget modellfelt som gjelder, ikke
// kvalitetsnivåets anthropic-modell.
import {
  type AnthropicMessageResult,
  type AnthropicStreamOptions,
  fetchWithRetry,
  messageAnthropic,
  type RetryDeps,
  type StreamEvent,
  streamAnthropic,
} from "../anthropic.ts";
import { flushSseBuffer, parseSseFrames } from "../sse-frames.ts";
import { type ProviderConfig, scrubKey } from "./config.ts";

export interface SingleChoice {
  effort?: string;
}

function authHeaders(cfg: ProviderConfig): Record<string, string> {
  return { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.key}` };
}

/** Feil fra leverandøren: logg detaljen nøkkel-skrubbet, kast noe generisk. */
async function fail(resp: Response, cfg: ProviderConfig): Promise<never> {
  const detail = await resp.text().catch(() => "");
  console.error(`LLM provider error ${resp.status}: ${scrubKey(detail, cfg.key)}`);
  throw new Error(`Leverandørfeil ${resp.status}`);
}

function bodyFor(
  cfg: ProviderConfig,
  opts: AnthropicStreamOptions,
  choice: SingleChoice,
  stream: boolean,
): Record<string, unknown> {
  if (cfg.type === "openai-responses") {
    const body: Record<string, unknown> = { model: cfg.model, input: opts.prompt, stream };
    if (opts.system) body.instructions = opts.system;
    if (opts.maxTokens) body.max_output_tokens = opts.maxTokens;
    if (choice.effort) body.reasoning = { effort: choice.effort };
    return body;
  }
  const messages: Record<string, string>[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: opts.prompt });
  const body: Record<string, unknown> = { model: cfg.model, messages, stream };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (choice.effort) body.reasoning_effort = choice.effort;
  // Uten dette sender chat.completions ingen usage på strømmede kall, og
  // «done»-hendelsen ville rapportert 0 tokens for hver eneste kjøring.
  if (stream) body.stream_options = { include_usage: true };
  return body;
}

function endpointFor(cfg: ProviderConfig): string {
  return cfg.type === "openai-responses"
    ? `${cfg.baseUrl}/responses`
    : `${cfg.baseUrl}/chat/completions`;
}

/**
 * Oversett leverandørens strøm til appens egen. Én payload-håndterer, samme
 * mønster som transformAnthropicStream — rammingen kommer fra sse-frames.ts.
 */
function transformProviderStream(
  upstream: ReadableStream<Uint8Array>,
  cfg: ProviderConfig,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let inputTokens = 0;
  let outputTokens = 0;

  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader();
      const emit = (e: StreamEvent) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));

      const handlePayload = (payload: string) => {
        try {
          const obj = JSON.parse(payload);
          if (cfg.type === "openai-responses") {
            if (obj.type === "response.output_text.delta" && typeof obj.delta === "string") {
              emit({ type: "text", text: obj.delta });
            } else if (obj.type === "response.completed" && obj.response?.usage) {
              inputTokens = obj.response.usage.input_tokens ?? 0;
              outputTokens = obj.response.usage.output_tokens ?? 0;
            }
            return;
          }
          const delta = obj.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) emit({ type: "text", text: delta });
          // Usage-chunken kommer til slutt og har tom choices-liste.
          if (obj.usage) {
            inputTokens = obj.usage.prompt_tokens ?? inputTokens;
            outputTokens = obj.usage.completion_tokens ?? outputTokens;
          }
        } catch (_e) {
          // ignorer ikke-JSON hendelsesdata
        }
      };

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const parsed = parseSseFrames(decoder.decode(value, { stream: true }), buffer);
          buffer = parsed.buffer;
          parsed.payloads.forEach(handlePayload);
        }
        flushSseBuffer(buffer).forEach(handlePayload);
        emit({
          type: "done",
          inputTokens,
          outputTokens,
          // Ingen av OpenAI-formene har prompt-caching — 0, ikke gjettet.
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        });
      } catch (e) {
        emit({ type: "error", message: scrubKey(String(e), cfg.key) });
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });
}

/** Strømmende single-shot mot en valgfri leverandør. Speiler streamAnthropic. */
export async function streamProvider(
  cfg: ProviderConfig,
  opts: AnthropicStreamOptions,
  choice: SingleChoice,
  deps: RetryDeps = {},
): Promise<ReadableStream<Uint8Array>> {
  if (cfg.type === "anthropic-compat") {
    return streamAnthropic({ ...opts, model: cfg.model, apiKey: cfg.key, apiBase: cfg.baseUrl, effort: choice.effort }, deps);
  }
  const resp = await fetchWithRetry(endpointFor(cfg), {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify(bodyFor(cfg, opts, choice, true)),
  }, deps);
  if (!resp.ok || !resp.body) return fail(resp, cfg);
  return transformProviderStream(resp.body, cfg);
}

/** Ikke-strømmende single-shot (v2-plukkepasset). Speiler messageAnthropic. */
export async function messageProvider(
  cfg: ProviderConfig,
  opts: AnthropicStreamOptions,
  choice: SingleChoice,
  deps: RetryDeps = {},
): Promise<AnthropicMessageResult> {
  if (cfg.type === "anthropic-compat") {
    return messageAnthropic({ ...opts, model: cfg.model, apiKey: cfg.key, apiBase: cfg.baseUrl, effort: choice.effort }, deps);
  }
  const resp = await fetchWithRetry(endpointFor(cfg), {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify(bodyFor(cfg, opts, choice, false)),
  }, deps);
  if (!resp.ok) return fail(resp, cfg);
  const json = await resp.json();

  let text = "";
  let u: Record<string, number> = {};
  if (cfg.type === "openai-responses") {
    const blocks = Array.isArray(json?.output) ? json.output : [];
    text = blocks
      .flatMap((b: { content?: unknown }) => Array.isArray(b.content) ? b.content : [])
      .filter((c: { type?: string }) => c?.type === "output_text")
      .map((c: { text?: string }) => c.text ?? "")
      .join("");
    u = json?.usage ?? {};
    return {
      text,
      usage: {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    };
  }
  text = json?.choices?.[0]?.message?.content ?? "";
  u = json?.usage ?? {};
  return {
    text,
    usage: {
      inputTokens: u.prompt_tokens ?? 0,
      outputTokens: u.completion_tokens ?? 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
  };
}
