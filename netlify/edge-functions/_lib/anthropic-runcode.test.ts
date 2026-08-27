// microdata-EGEN testfil (ikke i askstat): run_code-graften i den native
// runAgenticStream-løkka — porteringen 2026-08-28 av askstats pending-
// mekanikk inn i microdatas (ikke-strømmende) løkkevariant.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type AgenticResumeState, runAgenticStream } from "./anthropic.ts";

interface SseEvent { type: string; [k: string]: unknown }

async function samle(stream: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
  const text = await new Response(stream).text();
  return text.split("\n\n").filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
}

function apiSvar(content: unknown[], stop: string): Response {
  return new Response(JSON.stringify({
    content, stop_reason: stop,
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200 });
}

const BASE = {
  apiKey: "k", model: "m", system: "s", userContent: "q",
  tools: [{ name: "run_code" }, { name: "variabel_info" }],
  progressLabel: () => "…",
  clientTools: ["run_code"],
};

Deno.test("run_code-kall → run_code-event + continue med pending, executeTool røres ikke", async () => {
  let executed = 0;
  const bodies: string[] = [];
  const fetchImpl = ((_u: string, init: RequestInit) => {
    bodies.push(String(init.body));
    return Promise.resolve(apiSvar(
      [{ type: "tool_use", id: "toolu_1", name: "run_code", input: { script: "summarize x" } }],
      "tool_use",
    ));
  }) as typeof fetch;
  const ev = await samle(runAgenticStream({
    ...BASE,
    executeTool: () => { executed++; return Promise.resolve("aldri"); },
    deps: { fetchImpl },
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

Deno.test("resume med pending + runResult flettes inn som tool_result før neste tur", async () => {
  const bodies: string[] = [];
  const fetchImpl = ((_u: string, init: RequestInit) => {
    bodies.push(String(init.body));
    return Promise.resolve(apiSvar([{ type: "text", text: "Svar." }], "end_turn"));
  }) as typeof fetch;
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
    deps: { fetchImpl },
  }));
  assertStringIncludes(bodies[0], "OK. OUTPUT (truncated)");
  assertStringIncludes(bodies[0], "toolu_1");
  assert(ev.some((e) => e.type === "text" && e.text === "Svar."));
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
    deps: { fetchImpl: (() => Promise.resolve(apiSvar([], "end_turn"))) as typeof fetch },
  }));
  const err = ev.find((e) => e.type === "error");
  assert(err, "error-event mangler");
  assertStringIncludes(String(err!.message), "run_result");
});

Deno.test("kjørebudsjett brukt opp → tool_result-beskjed i stedet for ny pending", async () => {
  let kall = 0;
  const bodies: string[] = [];
  const fetchImpl = ((_u: string, init: RequestInit) => {
    bodies.push(String(init.body));
    kall++;
    return Promise.resolve(kall === 1
      ? apiSvar([{ type: "tool_use", id: "toolu_9", name: "run_code", input: { script: "s" } }], "tool_use")
      : apiSvar([{ type: "text", text: "Ferdig." }], "end_turn"));
  }) as typeof fetch;
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
    deps: { fetchImpl },
  }));
  assertEquals(ev.some((e) => e.type === "run_code"), false);
  assertStringIncludes(bodies[1], "Kjøre-budsjettet er brukt opp");
});
