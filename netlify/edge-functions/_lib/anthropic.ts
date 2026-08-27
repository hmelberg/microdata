import { flushSseBuffer, parseSseFrames } from "./sse-frames.ts";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export interface AnthropicStreamOptions {
  apiKey: string;
  model: string;
  prompt: string;
  maxTokens?: number;
  // Optional cached system prefix. When set, it is sent as a `system` block
  // with a cache_control breakpoint so the (large, stable) prefix is billed
  // at cache-read rates on repeat requests instead of full input rates.
  system?: string;
  // Cache TTL for the system block. "1h" needs the extended-cache-ttl beta
  // header; "5m" (default) is GA. Ignored when `system` is unset.
  cacheTtl?: "5m" | "1h";
  // Anthropic-kompatibel gateway (multi-provider-runden 2026-08-27): POST går
  // til `${apiBase}/messages` i stedet for api.anthropic.com. Konvensjonen er
  // «alt før endepunktnavnet», lik providers/config.ts.
  apiBase?: string;
  // output_config.effort — NØSTET, aldri toppnivå, og ingen beta-header.
  // Utelates helt når den er unset: effort FEILER på Haiku 4.5, som er
  // nøyaktig modellen picker-passet og «fast»-nivået bruker (llm-choice.ts).
  effort?: string;
}

export interface StreamEvent {
  type: "text" | "done" | "error";
  text?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  message?: string;
}

/**
 * Identitetskoblede Anthropic-nøkler krever at forespørselen sier HVILKET
 * workspace den handler på vegne av — uten headeren svarer API-et 400
 * («anthropic-workspace-id is required when authenticating with an
 * identity-linked API key»), uansett hvor riktig resten av bodyen er.
 * Vanlige workspace-nøkler trenger den ikke, så headeren settes kun når
 * ANTHROPIC_WORKSPACE_ID faktisk er konfigurert.
 *
 * Gjelder BARE serverens egen nøkkel. En BYOK-bruker med identitetskoblet
 * nøkkel må bruke en vanlig workspace-nøkkel i stedet — vi har ingen måte å
 * vite workspace-id-en deres på.
 */
function workspaceHeader(): Record<string, string> {
  const id = Deno.env.get("ANTHROPIC_WORKSPACE_ID");
  return id ? { "anthropic-workspace-id": id } : {};
}

/** Endepunktet for dette kallet: brukerens gateway, ellers Anthropic selv. */
function apiTarget(apiBase?: string): string {
  return apiBase ? `${apiBase.replace(/\/+$/, "")}/messages` : ANTHROPIC_API;
}

const ANTHROPIC_TIMEOUT_MS = 30_000;
const ANTHROPIC_RETRIES = 2;

export interface RetryDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  retries?: number;
  timeoutMs?: number;
}

/**
 * POST with an abort timeout and retry/backoff on 429 (rate limited) and 529
 * (overloaded). Honours a numeric Retry-After when present. Network errors are
 * retried too; the final error propagates. Injectable for tests.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  deps: RetryDeps = {},
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const retries = deps.retries ?? ANTHROPIC_RETRIES;
  const timeoutMs = deps.timeoutMs ?? ANTHROPIC_TIMEOUT_MS;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetchImpl(url, { ...init, signal: ctrl.signal });
      clearTimeout(timer);
      if ((resp.status === 429 || resp.status === 529) && attempt < retries) {
        const ra = parseInt(resp.headers.get("retry-after") ?? "", 10);
        const delay = Number.isFinite(ra) && ra > 0
          ? Math.min(ra * 1000, 10_000)
          : Math.min(1000 * 2 ** attempt, 8000);
        await sleep(delay);
        continue;
      }
      return resp;
    } catch (e) {
      clearTimeout(timer);
      lastError = e;
      if (attempt < retries) {
        await sleep(Math.min(1000 * 2 ** attempt, 8000));
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

export async function streamAnthropic(
  opts: AnthropicStreamOptions,
  deps: RetryDeps = {},
): Promise<ReadableStream<Uint8Array>> {
  const useLongTtl = opts.cacheTtl === "1h";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": opts.apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    ...workspaceHeader(),
  };
  if (opts.system && useLongTtl) {
    headers["anthropic-beta"] = "extended-cache-ttl-2025-04-11";
  }

  const requestBody: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 2000,
    stream: true,
    messages: [{ role: "user", content: opts.prompt }],
  };
  if (opts.effort) requestBody.output_config = { effort: opts.effort };
  if (opts.system) {
    requestBody.system = [
      {
        type: "text",
        text: opts.system,
        cache_control: useLongTtl
          ? { type: "ephemeral", ttl: "1h" }
          : { type: "ephemeral" },
      },
    ];
  }

  const upstream = await fetchWithRetry(apiTarget(opts.apiBase), {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
  }, deps);

  if (!upstream.ok || !upstream.body) {
    // Log the upstream detail server-side, but do NOT echo it to the client
    // (it can contain account/key diagnostics). Callers surface a generic 502.
    const detail = await upstream.text().catch(() => "");
    console.error(`Anthropic API error ${upstream.status}: ${detail}`);
    throw new Error(`Anthropic API error ${upstream.status}`);
  }

  return transformAnthropicStream(upstream.body);
}

export interface AnthropicMessageResult {
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
}

/**
 * Single, non-streaming completion. Used by the v2 variable-picker pass, which
 * needs the full result (a JSON array of variable names) before generation can
 * start. Reuses fetchWithRetry for timeout + 429/529 backoff. `deps` is
 * injectable for tests.
 */
export async function messageAnthropic(
  opts: AnthropicStreamOptions,
  deps: RetryDeps = {},
): Promise<AnthropicMessageResult> {
  const useLongTtl = opts.cacheTtl === "1h";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": opts.apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    ...workspaceHeader(),
  };
  if (opts.system && useLongTtl) {
    headers["anthropic-beta"] = "extended-cache-ttl-2025-04-11";
  }
  const requestBody: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 1024,
    stream: false,
    messages: [{ role: "user", content: opts.prompt }],
  };
  if (opts.effort) requestBody.output_config = { effort: opts.effort };
  if (opts.system) {
    requestBody.system = [
      {
        type: "text",
        text: opts.system,
        cache_control: useLongTtl ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" },
      },
    ];
  }

  const resp = await fetchWithRetry(
    apiTarget(opts.apiBase),
    { method: "POST", headers, body: JSON.stringify(requestBody) },
    deps,
  );
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    console.error(`Anthropic API error ${resp.status}: ${detail}`);
    throw new Error(`Anthropic API error ${resp.status}`);
  }
  const json = await resp.json();
  const text = Array.isArray(json?.content)
    ? json.content.filter((b: { type?: string }) => b?.type === "text")
        .map((b: { text?: string }) => b.text ?? "").join("")
    : "";
  const u = json?.usage ?? {};
  return {
    text,
    usage: {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
    },
  };
}

function transformAnthropicStream(
  upstream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;

  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader();
      // One payload handler, used for both the streaming reads and the
      // end-of-stream drain. These two paths used to be a verbatim
      // copy-paste of each other (framing AND event handling duplicated),
      // so a fix to one silently missed the other; framing now lives in
      // sse-frames.ts and the event vocabulary lives here, once.
      const handlePayload = (payload: string) => {
        try {
          const obj = JSON.parse(payload);
          if (obj.type === "content_block_delta" && obj.delta?.type === "text_delta") {
            const out: StreamEvent = { type: "text", text: obj.delta.text };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(out)}\n\n`));
          } else if (obj.type === "message_start" && obj.message?.usage) {
            inputTokens = obj.message.usage.input_tokens ?? 0;
            cacheReadTokens = obj.message.usage.cache_read_input_tokens ?? 0;
            cacheCreationTokens = obj.message.usage.cache_creation_input_tokens ?? 0;
          } else if (obj.type === "message_delta" && obj.usage) {
            outputTokens = obj.usage.output_tokens ?? outputTokens;
          }
        } catch (_e) {
          // ignore non-JSON event data
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
        // Drain any residual buffer content not yet terminated by \n\n
        flushSseBuffer(buffer).forEach(handlePayload);
        const done: StreamEvent = {
          type: "done",
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(done)}\n\n`));
      } catch (e) {
        const err: StreamEvent = { type: "error", message: String(e) };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(err)}\n\n`));
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });
}

// ── Agentic tool loop (Web mode / data-svar) ─────────────────────────────
// Non-streaming turns while the model calls tools; the final answer is
// emitted as one SSE text event (accepted trade-off: no token streaming on
// the final turn — the loop stays simple and correct). Hosted tools
// (web_search) run inside the API; stop_reason "pause_turn" is resumed.

export interface AgenticOptions {
  apiKey: string;
  model: string;
  system: string;
  userContent: string;
  tools: unknown[];
  executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
  progressLabel?: (name: string, input: Record<string, unknown>) => string;
  maxTokens?: number;
  cacheTtl?: "5m" | "1h";
  maxClientToolCalls?: number;
  maxTurns?: number;
  // Continuation protocol: Netlify caps CPU per edge invocation, so a run
  // that needs many API turns must be split across invocations. When the
  // per-call turn budget (turnsPerCall, default 1) is spent without a final
  // answer, the stream ends with {type:"continue", state, ...continueExtra()}
  // and the client re-POSTs with `resume` = that state.
  resume?: AgenticResumeState;
  turnsPerCall?: number;
  continueExtra?: () => Record<string, unknown>;
  deps?: RetryDeps;
  // Speiler AnthropicStreamOptions (multi-provider-runden 2026-08-27):
  // anthropic-kompatibel gateway, og output_config.effort NØSTET.
  apiBase?: string;
  effort?: string;
  // run_code-graften (samlet svar-pipeline 2026-08-28, portert fra askstats
  // native løkke): verktøynavn i clientTools utføres av KLIENTEN — kallet
  // emitteres som {type:"run_code", script} + continue m/state.pending, og
  // resultatet kommer tilbake i `runResult` på neste invokasjon.
  clientTools?: string[];
  maxRunCode?: number;
  runResult?: string;
}

// Everything the loop needs to pick up where a previous invocation stopped.
// Round-trips through the client verbatim; contains only the question, tool
// results and model output — never the system prompt or API keys.
export interface AgenticResumeState {
  messages: Record<string, unknown>[];
  turn: number;
  clientCalls: number;
  // Feltene under bæres av det ORDRETT kopierte leverandørlaget
  // (_lib/providers/agentic.ts, fra askstat) — de er valgfrie og rører ikke
  // den anthropic-native løkka under. pdfVern er BEVISST utelatt: askstat
  // trenger det for API-ets eget websøk, og providers/ refererer det ikke.
  //
  // prevResponseId: openai-responses holder samtaletilstanden server-side —
  // bare id-en rundtures, og meldingsarrayet bærer da kun siste tool-results.
  prevResponseId?: string;
  runCalls?: number;
  // getPackCalls: askstats get_pack-teller. microdata har ikke det verktøyet,
  // så telleren er inert her — den står fordi den kopierte fila refererer den,
  // og et avvik ville brutt cherry-pick-veien mellom søsterrepoene.
  getPackCalls?: number;
  // pending: hvilket klientutført verktøy vi venter svar på over et resume-hopp.
  pending?: {
    results: { tool_use_id: string; content: string }[];
    awaitingId: string;
    name?: string;
    expectedId?: string;
  };
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
}

// Long final generations (multi-tool-call context, big final script) can
// exceed a 90s non-streaming turn. 180s trades a longer worst-case wait for
// fewer AbortErrors; the proper future fix is streaming the final turn
// instead of buffering it whole.
const AGENTIC_TIMEOUT_MS = 180_000;

// Netlify/CDN kills streamed responses that go silent for too long (~40-60s).
// Non-streaming API turns are exactly such silent windows, so while a turn is
// in flight we emit a progress event every 10s. `replace: true` tells the
// client to update the previous progress line in place instead of appending.
const HEARTBEAT_MS = 10_000;

// Anthropic-strømmen regnes som død etter 2 min uten ett eneste event —
// langt over normal delta-takt, langt under Netlifys tålmodighet.
const STREAM_IDLE_MS = 120_000;

interface TurnResult {
  content: Record<string, unknown>[];
  stopReason: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
}

// Strømmer ÉN API-tur (portert fra askstats anthropic.ts 2026-08-28, minus
// PDF-vernet som hører til deres hostede websøk). Text-deltaer forwardes live
// via onDelta; alle innholdsblokker rekonstrueres for state.messages etter
// SDK-mønsteret: blokken fra content_block_start + akkumulerte deltaer
// (text_delta, input_json_delta — parses ved content_block_stop).
// GRUNNEN til streaming er hard: en ikke-strømmende sonnet-tur på stor
// prompt kan ta >60 s, og Netlify kutter edge-invokasjonen ved ~60 s
// UANSETT heartbeats (målt 2026-08-28: «Error in input stream» hos Hans,
// reprodusert med kutt ved nøyaktig 60.2 s).
async function streamOneTurn(
  url: string,
  headers: Record<string, string>,
  requestBody: Record<string, unknown>,
  deps: RetryDeps,
  onDelta: (text: string) => void,
): Promise<TurnResult> {
  const resp = await fetchWithRetry(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...requestBody, stream: true }),
  }, deps);
  if (!resp.ok || !resp.body) {
    const detail = await resp.text().catch(() => "");
    console.error(`Anthropic API error ${resp.status}: ${detail}`);
    throw new Error(`Anthropic API error ${resp.status}`);
  }

  const blocks: Record<string, unknown>[] = [];
  const partialJson = new Map<number, string>();
  let stopReason = "";
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

  const handle = (obj: Record<string, unknown>) => {
    const t = obj.type;
    if (t === "message_start") {
      const u = (obj.message as Record<string, unknown> | undefined)?.usage as Record<string, number> | undefined;
      usage.inputTokens = u?.input_tokens ?? 0;
      usage.cacheReadTokens = u?.cache_read_input_tokens ?? 0;
      usage.cacheCreationTokens = u?.cache_creation_input_tokens ?? 0;
    } else if (t === "content_block_start") {
      const idx = obj.index as number;
      blocks[idx] = { ...(obj.content_block as Record<string, unknown> ?? {}) };
      const bt = blocks[idx].type;
      if (bt === "tool_use" || bt === "server_tool_use") partialJson.set(idx, "");
    } else if (t === "content_block_delta") {
      const idx = obj.index as number;
      const blk = blocks[idx];
      const d = obj.delta as Record<string, unknown> | undefined;
      if (!blk || !d) return;
      if (d.type === "text_delta") {
        blk.text = String(blk.text ?? "") + String(d.text ?? "");
        onDelta(String(d.text ?? ""));
      } else if (d.type === "input_json_delta") {
        partialJson.set(idx, (partialJson.get(idx) ?? "") + String(d.partial_json ?? ""));
      } else if (d.type === "citations_delta" && d.citation) {
        blk.citations = [...(blk.citations as unknown[] ?? []), d.citation];
      }
    } else if (t === "content_block_stop") {
      const idx = obj.index as number;
      const blk = blocks[idx];
      if (blk && partialJson.has(idx)) {
        const raw = partialJson.get(idx) ?? "";
        try { blk.input = raw ? JSON.parse(raw) : (blk.input ?? {}); }
        catch { blk.input = blk.input ?? {}; }
        partialJson.delete(idx);
      }
    } else if (t === "message_delta") {
      const d = obj.delta as Record<string, unknown> | undefined;
      if (d?.stop_reason) stopReason = String(d.stop_reason);
      const u = obj.usage as Record<string, number> | undefined;
      if (u?.output_tokens !== undefined) usage.outputTokens = u.output_tokens;
    } else if (t === "error") {
      const e = obj.error as Record<string, unknown> | undefined;
      throw new Error(`Anthropic stream error: ${e?.message ?? "ukjent"}`);
    }
  };

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      let timer: number | undefined;
      const r = await Promise.race([
        reader.read(),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error("Anthropic-strømmen stallet (> 120 s uten data)")), STREAM_IDLE_MS);
        }),
      ]).finally(() => clearTimeout(timer));
      if (r.done) break;
      buffer += decoder.decode(r.value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n\n")) >= 0) {
        const event = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const dataLine = event.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        const payload = dataLine.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try { handle(JSON.parse(payload)); }
        catch (e) {
          if (e instanceof Error && e.message.startsWith("Anthropic stream error")) throw e;
          /* ignorér uparsbare keep-alives */
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* allerede lukket */ }
  }
  return { content: blocks.filter(Boolean), stopReason, usage };
}

export function runAgenticStream(opts: AgenticOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const maxClientCalls = opts.maxClientToolCalls ?? 12;
  const maxTurns = opts.maxTurns ?? 24;
  const deps: RetryDeps = { timeoutMs: AGENTIC_TIMEOUT_MS, ...opts.deps };
  const useLongTtl = opts.cacheTtl === "1h";

  return new ReadableStream({
    async start(controller) {
      const emit = (obj: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-api-key": opts.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        ...workspaceHeader(),
      };
      if (useLongTtl) headers["anthropic-beta"] = "extended-cache-ttl-2025-04-11";
      const system = [{
        type: "text",
        text: opts.system,
        cache_control: useLongTtl ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" },
      }];

      const state: AgenticResumeState = opts.resume ?? {
        messages: [{ role: "user", content: opts.userContent }],
        turn: 0,
        clientCalls: 0,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      };
      const turnsPerCall = opts.turnsPerCall ?? 1;
      const clientToolNames = new Set(opts.clientTools ?? []);
      const maxRunCode = opts.maxRunCode ?? 2;
      // En pause_turn-segments tekst er kladd akkurat som en tool_use-turs —
      // carryHadText husker streamet tekst på tvers av pause_turn-fortsettelser
      // slik at turn_discard ikke glemmes (askstat-mønsteret).
      let carryHadText = false;

      try {
        // Resume etter run_code: flett klientens resultat inn som tool_result
        // sammen med eventuelle server-verktøyresultater fra samme tur.
        // (Portert fra askstats løkke; get_pack-grenen utelatt — microdata
        // har ikke verktøyet.)
        if (state.pending) {
          if (typeof opts.runResult !== "string") {
            throw new Error("resume med ventende run_code mangler run_result");
          }
          const merged = [...state.pending.results,
            { tool_use_id: state.pending.awaitingId, content: opts.runResult }];
          state.messages.push({
            role: "user",
            content: merged.map((r) => ({ type: "tool_result", tool_use_id: r.tool_use_id, content: r.content })),
          });
          delete state.pending;
        }
        for (let i = 0; i < turnsPerCall; i++) {
          if (state.turn >= maxTurns) throw new Error("tool-loopen nådde maks antall turer");
          const turnLabel = state.turn === 0
            ? "🧠 Tolker spørsmålet og planlegger"
            : `🤔 Arbeider med svaret (tur ${state.turn + 1})`;
          emit({ type: "progress", text: `${turnLabel} …`, replace: true });
          const turnStart = Date.now();
          // Heartbeat trengs bare til første delta — deretter holder deltaene
          // SSE-strømmen i live.
          let sawDelta = false;
          let turnHadText = false;
          const beat = setInterval(() => {
            if (sawDelta) return;
            const s = Math.round((Date.now() - turnStart) / 1000);
            try {
              emit({ type: "progress", text: `${turnLabel} … (${s} s)`, replace: true });
            } catch (_) { /* stream already closed */ }
          }, HEARTBEAT_MS);
          let turn: TurnResult;
          try {
            turn = await streamOneTurn(apiTarget(opts.apiBase), headers, {
              model: opts.model,
              max_tokens: opts.maxTokens ?? 8192,
              system,
              tools: opts.tools,
              messages: state.messages,
              ...(opts.effort ? { output_config: { effort: opts.effort } } : {}),
            }, deps, (text) => {
              sawDelta = true;
              turnHadText = true;
              emit({ type: "delta", text });
            });
          } finally {
            clearInterval(beat);
          }
          state.turn++;
          state.usage.inputTokens += turn.usage.inputTokens;
          state.usage.outputTokens += turn.usage.outputTokens;
          state.usage.cacheReadTokens += turn.usage.cacheReadTokens;
          state.usage.cacheCreationTokens += turn.usage.cacheCreationTokens;
          const content = turn.content;

          // Hosted tools (web_search/web_fetch) run inside the API and are
          // otherwise invisible to the user — surface what was searched/read.
          for (const b of content) {
            if (b?.type !== "server_tool_use") continue;
            const inp = (b.input ?? {}) as Record<string, unknown>;
            const what = String(inp.query ?? inp.url ?? "").slice(0, 120);
            emit({
              type: "progress",
              text: b.name === "web_fetch" ? `🌐 Leser ${what}` : `🔎 Websøk: ${what}`,
            });
          }

          if (turn.stopReason === "pause_turn") {
            state.messages.push({ role: "assistant", content });
            carryHadText = carryHadText || turnHadText;
            continue;
          }
          const toolUses = content.filter(
            (b: { type?: string }): b is { type: string; id: string; name: string; input?: Record<string, unknown> } =>
              b.type === "tool_use",
          );
          if (turn.stopReason === "tool_use" && toolUses.length) {
            state.messages.push({ role: "assistant", content });
            // Streamet tekst i en verktøy-tur er kladd — be klienten droppe
            // den fra svarbufferen (den står igjen i prosesshistorikken).
            if (turnHadText || carryHadText) emit({ type: "turn_discard" });
            carryHadText = false;
            const results: { tool_use_id: string; content: string }[] = [];
            // Klientutført verktøy (run_code): utfør ALDRI her — pauser løkka
            // og overlater kjøringen til klienten via pending/continue.
            let clientCall: { id: string; name: string; input: Record<string, unknown> } | null = null;
            for (const tu of toolUses) {
              if (clientToolNames.has(tu.name)) {
                state.runCalls = (state.runCalls ?? 0) + 1;
                if (state.runCalls > maxRunCode) {
                  results.push({ tool_use_id: tu.id, content:
                    "Kjøre-budsjettet er brukt opp — skriv sluttsvaret NÅ basert på det du allerede vet. Vær ærlig om hva som ikke ble verifisert." });
                } else if (clientCall) {
                  results.push({ tool_use_id: tu.id, content: "Kall ett klientverktøy (run_code) én gang per tur." });
                } else {
                  clientCall = { id: tu.id, name: tu.name, input: (tu.input ?? {}) as Record<string, unknown> };
                }
                continue;
              }
              state.clientCalls++;
              const label = opts.progressLabel?.(tu.name, tu.input ?? {}) ?? `Kjører ${tu.name} …`;
              emit({ type: "progress", text: label });
              let out: string;
              if (state.clientCalls > maxClientCalls) {
                out = "Verktøy-budsjettet er brukt opp — generer svaret NÅ med det du allerede har funnet. Vær ærlig om hva som mangler.";
              } else {
                try {
                  out = await opts.executeTool(tu.name, tu.input ?? {});
                } catch (e) {
                  out = `Verktøyfeil: ${String(e).slice(0, 300)}`;
                }
              }
              results.push({ tool_use_id: tu.id, content: out });
            }
            if (clientCall) {
              state.pending = { results, awaitingId: clientCall.id, name: "run_code" };
              emit({ type: "run_code", script: String(clientCall.input.script ?? "") });
              emit({ type: "continue", state, ...(opts.continueExtra?.() ?? {}) });
              controller.close();
              return;
            }
            state.messages.push({
              role: "user",
              content: results.map((r) => ({ type: "tool_result", tool_use_id: r.tool_use_id, content: r.content })),
            });
            continue;
          }
          // Final answer — its deltas were already forwarded live above.
          carryHadText = false;
          emit({ type: "done", ...state.usage });
          controller.close();
          return;
        }
        // Turn budget for THIS invocation spent without a final answer: hand
        // the state back so the client can continue in a fresh invocation.
        emit({ type: "continue", state, ...(opts.continueExtra?.() ?? {}) });
        controller.close();
        return;
      } catch (e) {
        emit({ type: "error", message: String(e) });
        controller.close();
      }
    },
  });
}
