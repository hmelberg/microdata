// microdata-EGEN testfil (ikke i askstat): run_code-graften OG streaming-
// turene i den native runAgenticStream-løkka. SSE-hjelperne (sseUpstream/
// streamedTextTurn/streamedToolTurn) er kopiert fra askstats anthropic.test.ts.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type AgenticResumeState, runAgenticStream } from "./anthropic.ts";

interface SseEvent { type: string; [k: string]: unknown }

async function samle(stream: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
  const text = await new Response(stream).text();
  return text.split("\n\n").filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
}

function sseUpstream(events: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const e of events) {
        c.enqueue(enc.encode(`event: x\ndata: ${JSON.stringify(e)}\n\n`));
      }
      c.close();
    },
  });
}

function streamedTextTurn(text: string) {
  return [
    { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ...text.split(" ").map((w, i) => ({
      type: "content_block_delta", index: 0,
      delta: { type: "text_delta", text: (i ? " " : "") + w },
    })),
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
}

function streamedToolTurn(toolName: string, id: string, inputJson: string, ledetekst = "Jeg kjører analysen.") {
  return [
    { type: "message_start", message: { usage: { input_tokens: 8 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ledetekst } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id, name: toolName, input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: inputJson.slice(0, 8) } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: inputJson.slice(8) } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ];
}

function sseFetch(turns: unknown[][], bodies?: string[]): typeof fetch {
  let call = 0;
  return ((_u: string, init?: RequestInit) => {
    if (bodies && init) bodies.push(String(init.body));
    return Promise.resolve(new Response(sseUpstream(turns[call++]), { status: 200 }));
  }) as unknown as typeof fetch;
}

const BASE = {
  apiKey: "k", model: "m", system: "s", userContent: "q",
  tools: [{ name: "run_code" }, { name: "variabel_info" }],
  progressLabel: () => "…",
  clientTools: ["run_code"],
};

Deno.test("run_code-kall → run_code-event + continue med pending, executeTool røres ikke", async () => {
  let executed = 0;
  const ev = await samle(runAgenticStream({
    ...BASE,
    executeTool: () => { executed++; return Promise.resolve("aldri"); },
    deps: { fetchImpl: sseFetch([
      streamedToolTurn("run_code", "toolu_1", JSON.stringify({ script: "summarize x" })),
    ]) },
  }));
  const rc = ev.find((e) => e.type === "run_code");
  assert(rc, "run_code-event mangler: " + JSON.stringify(ev));
  assertEquals(rc!.script, "summarize x");
  const cont = ev.find((e) => e.type === "continue");
  assert(cont, "continue-event mangler");
  const st = cont!.state as AgenticResumeState;
  assertEquals(st.pending?.awaitingId, "toolu_1");
  assertEquals(st.pending?.name, "run_code");
  assertEquals(st.runCalls, 1);
  assertEquals(executed, 0);
});

Deno.test("text-deltaer forwardes live som delta-events; scratch-tur før tool_use får turn_discard", async () => {
  const ev = await samle(runAgenticStream({
    ...BASE,
    executeTool: () => Promise.resolve("x"),
    deps: { fetchImpl: sseFetch([
      streamedToolTurn("run_code", "toolu_1", JSON.stringify({ script: "s" }), "Tenker høyt først."),
    ]) },
  }));
  const deltas = ev.filter((e) => e.type === "delta").map((e) => e.text).join("");
  assertStringIncludes(deltas, "Tenker høyt først.");
  assert(ev.some((e) => e.type === "turn_discard"), "turn_discard mangler: " + JSON.stringify(ev.map(e => e.type)));
});

Deno.test("resume med pending + runResult flettes inn som tool_result før neste tur", async () => {
  const bodies: string[] = [];
  const resume: AgenticResumeState = {
    messages: [{ role: "user", content: "q" }],
    turn: 1, clientCalls: 0, runCalls: 1,
    pending: { results: [], awaitingId: "toolu_1", name: "run_code" },
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  };
  const ev = await samle(runAgenticStream({
    ...BASE,
    executeTool: () => Promise.resolve("x"),
    resume, runResult: "OK. OUTPUT (truncated):\n42",
    deps: { fetchImpl: sseFetch([streamedTextTurn("Svar.")], bodies) },
  }));
  assertStringIncludes(bodies[0], "OK. OUTPUT (truncated)");
  assertStringIncludes(bodies[0], "toolu_1");
  const deltas = ev.filter((e) => e.type === "delta").map((e) => e.text).join("");
  assertEquals(deltas, "Svar.");
  assert(ev.some((e) => e.type === "done"));
});

Deno.test("resume med pending UTEN run_result er en feil, aldri stille videre", async () => {
  const resume: AgenticResumeState = {
    messages: [{ role: "user", content: "q" }],
    turn: 1, clientCalls: 0,
    pending: { results: [], awaitingId: "toolu_1", name: "run_code" },
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  };
  const ev = await samle(runAgenticStream({
    ...BASE,
    executeTool: () => Promise.resolve("x"),
    resume,
    deps: { fetchImpl: sseFetch([streamedTextTurn("aldri")]) },
  }));
  const err = ev.find((e) => e.type === "error");
  assert(err, "error-event mangler");
  assertStringIncludes(String(err!.message), "run_result");
});

Deno.test("kjørebudsjett brukt opp → tool_result-beskjed i stedet for ny pending", async () => {
  const bodies: string[] = [];
  const ev = await samle(runAgenticStream({
    ...BASE,
    executeTool: () => Promise.resolve("x"),
    maxRunCode: 2,
    resume: {
      messages: [{ role: "user", content: "q" }],
      turn: 1, clientCalls: 0, runCalls: 2,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    },
    turnsPerCall: 2,
    deps: { fetchImpl: sseFetch([
      streamedToolTurn("run_code", "toolu_9", JSON.stringify({ script: "s" })),
      streamedTextTurn("Ferdig."),
    ], bodies) },
  }));
  assertEquals(ev.some((e) => e.type === "run_code"), false);
  assertStringIncludes(bodies[1], "Kjøre-budsjettet er brukt opp");
});

Deno.test("server-verktøy (variabel_info) kjøres fortsatt i løkka, streamet", async () => {
  const calls: string[] = [];
  const ev = await samle(runAgenticStream({
    ...BASE,
    executeTool: (name, input) => { calls.push(`${name}:${input.navn}`); return Promise.resolve("detaljer"); },
    turnsPerCall: 2,
    deps: { fetchImpl: sseFetch([
      streamedToolTurn("variabel_info", "toolu_2", JSON.stringify({ navn: "NUDB_BU" })),
      streamedTextTurn("Svar med detaljer."),
    ]) },
  }));
  assertEquals(calls, ["variabel_info:NUDB_BU"]);
  assert(ev.some((e) => e.type === "done"));
});

Deno.test("tur-deadline gir ren error-event i stedet for kuttet strøm", async () => {
  // En oppstrøm som aldri leverer noe: deadline (injisert kort) skal vinne.
  const evig = new ReadableStream<Uint8Array>({ start() { /* aldri data */ } });
  const ev = await samle(runAgenticStream({
    ...BASE,
    executeTool: () => Promise.resolve("x"),
    deps: {
      fetchImpl: (() => Promise.resolve(new Response(evig, { status: 200 }))) as typeof fetch,
      turnDeadlineMs: 80,
    },
  }));
  const err = ev.find((e) => e.type === "error");
  if (!err) throw new Error("error-event mangler: " + JSON.stringify(ev.map((e) => e.type)));
  if (!String(err.message).includes("plattformtaket")) throw new Error("feil melding: " + err.message);
});
