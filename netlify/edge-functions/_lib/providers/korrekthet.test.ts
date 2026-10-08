// Leverandør-korrekthet (review-runden 2026-10-08): avkorting meldt som
// suksess, for høy max_tokens til vilkårlige leverandører, tapt samtale-
// historikk og effort til modeller som ikke tåler den.
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { makeOpenAiCompatTurn, messageOpenAiCompat } from "./openai-compat.ts";
import { makeOpenAiResponsesTurn } from "./openai-responses.ts";
import { type ProviderTurnResult, runProviderAgenticStream } from "./agentic.ts";
import { messageProvider, streamProvider } from "./single.ts";
import type { ProviderConfig } from "./config.ts";
import type { AgenticResumeState } from "../anthropic.ts";

const COMPAT: ProviderConfig = {
  type: "openai-compat", baseUrl: "https://llm.example/v1",
  model: "deepseek-chat", key: "sk-proj-abc123XYZ", webSearch: "none",
};
const RESP: ProviderConfig = {
  type: "openai-responses", baseUrl: "https://api.openai.example/v1",
  model: "gpt-4o", key: "sk-proj-abc123XYZ", webSearch: "native",
};
const freshState = (msgs: Record<string, unknown>[] = [{ role: "user", content: "Q?" }]): AgenticResumeState => ({
  messages: msgs, turn: 0, clientCalls: 0,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
});
const TOOLS = [{ name: "run_code", description: "d", input_schema: { type: "object", properties: {} } }];

/** Ett hermetisk svar per kall; fanger hver request-body. */
function seq(responses: { status: number; body: unknown; sse?: boolean }[], bodies: Record<string, unknown>[]): typeof fetch {
  let i = 0;
  return ((_u: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r.sse) {
      const lines = r.body as string[];
      const enc = new TextEncoder();
      return Promise.resolve(new Response(new ReadableStream({
        start(c) {
          for (const l of lines) c.enqueue(enc.encode(`data: ${l}\n\n`));
          c.close();
        },
      }), { status: r.status }));
    }
    return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status }));
  }) as typeof fetch;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Record<string, unknown>[]> {
  const text = await new Response(stream).text();
  return text.split("\n\n").filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, "")));
}

// ── Bug 1: avkorting ─────────────────────────────────────────────────────

Deno.test("compat: finish_reason length → stop max_tokens, aldri tool_use med tomme args", async () => {
  const bodies: Record<string, unknown>[] = [];
  const res = await makeOpenAiCompatTurn(COMPAT)(freshState(), {
    system: "S", tools: TOOLS, maxTokens: 100,
    deps: { fetchImpl: seq([{ status: 200, body: {
      choices: [{ finish_reason: "length", message: { content: null, tool_calls: [
        { id: "c1", type: "function", function: { name: "run_code", arguments: `{"script":"tabulate ki` } },
      ] } }],
    } }], bodies) },
  });
  assertEquals(res.stop, "max_tokens");
});

Deno.test("compat: uparsbare tool-args uten length → kallet emitteres ikke med tom input", async () => {
  const bodies: Record<string, unknown>[] = [];
  const res = await makeOpenAiCompatTurn(COMPAT)(freshState(), {
    system: "S", tools: TOOLS, maxTokens: 100,
    deps: { fetchImpl: seq([{ status: 200, body: {
      choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [
        { id: "c1", type: "function", function: { name: "run_code", arguments: `{"script":` } },
      ] } }],
    } }], bodies) },
  });
  assertEquals(res.stop, "max_tokens");
});

Deno.test("responses: status incomplete (max_output_tokens) → stop max_tokens", async () => {
  const bodies: Record<string, unknown>[] = [];
  const res = await makeOpenAiResponsesTurn(RESP)(freshState(), {
    system: "S", tools: TOOLS, maxTokens: 100,
    deps: { fetchImpl: seq([{ status: 200, body: {
      id: "r1", status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "function_call", call_id: "c1", name: "run_code", arguments: `{"scr` }],
    } }], bodies) },
  });
  assertEquals(res.stop, "max_tokens");
});

Deno.test("løkka: stop max_tokens → error-event (ikke done, ikke run_code)", async () => {
  const events = await collect(runProviderAgenticStream({
    runTurn: () => Promise.resolve({
      text: "Delvis", toolUses: [], searchNotes: [], stop: "max_tokens",
      usage: { inputTokens: 1, outputTokens: 1 },
    } as ProviderTurnResult),
    system: "S", userContent: "Q?", tools: [], executeTool: () => Promise.resolve(""),
    clientTools: ["run_code"],
  }));
  assertEquals(events.some((e) => e.type === "done"), false);
  assertEquals(events.some((e) => e.type === "run_code"), false);
  const err = events.find((e) => e.type === "error");
  assert(err && String(err.message).includes("avkortet"), JSON.stringify(events));
});

Deno.test("løkka: run_code med tomt script emitteres aldri — modellen får beskjed", async () => {
  const seen: AgenticResumeState[] = [];
  const turns: ProviderTurnResult[] = [
    { text: "", toolUses: [{ id: "c1", name: "run_code", input: {} }], searchNotes: [],
      stop: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
    { text: "Ferdig.", toolUses: [], searchNotes: [], stop: "end", usage: { inputTokens: 1, outputTokens: 1 } },
  ];
  const events = await collect(runProviderAgenticStream({
    runTurn: (s) => { seen.push(structuredClone(s)); return Promise.resolve(turns.shift()!); },
    system: "S", userContent: "Q?", tools: [], executeTool: () => Promise.resolve(""),
    clientTools: ["run_code"], turnsPerCall: 2,
  }));
  assertEquals(events.some((e) => e.type === "run_code"), false);
  assert(events.some((e) => e.type === "done"));
  const last = seen[1].messages[seen[1].messages.length - 1] as { content: { content: string }[] };
  assert(last.content[0].content.includes("script"));
});

Deno.test("streamProvider compat: finish_reason length → error, ikke done", async () => {
  const events = await collect(await streamProvider(COMPAT, { apiKey: "", model: "", prompt: "p" }, {}, {
    fetchImpl: seq([{ status: 200, sse: true, body: [
      '{"choices":[{"delta":{"content":"Hei"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"length"}]}',
      "[DONE]",
    ] }], []),
    sleep: () => Promise.resolve(),
  }));
  assertEquals(events.some((e) => e.type === "done"), false);
  assert(String(events.find((e) => e.type === "error")?.message).includes("avkortet"));
});

Deno.test("streamProvider responses: response.incomplete og response.failed → error", async () => {
  for (const line of [
    '{"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}',
    '{"type":"response.failed","response":{"error":{"message":"server_error"}}}',
    '{"type":"error","message":"overloaded"}',
  ]) {
    const events = await collect(await streamProvider(RESP, { apiKey: "", model: "", prompt: "p" }, {}, {
      fetchImpl: seq([{ status: 200, sse: true, body: [
        '{"type":"response.output_text.delta","delta":"Hei"}', line,
      ] }], []),
      sleep: () => Promise.resolve(),
    }));
    assertEquals(events.some((e) => e.type === "done"), false, line);
    assert(events.some((e) => e.type === "error"), line);
  }
});

// ── Bug 2: max_tokens-tak ────────────────────────────────────────────────

Deno.test("compat: 400 'valid range [1, 8192]' → ett nytt forsøk med 8192", async () => {
  const bodies: Record<string, unknown>[] = [];
  const res = await messageOpenAiCompat(COMPAT, { system: "S", prompt: "p", maxTokens: 32000 }, {
    fetchImpl: seq([
      { status: 400, body: { error: { message: "Invalid max_tokens value, the valid range of max_tokens is [1, 8192]" } } },
      { status: 200, body: { choices: [{ message: { content: "ok" } }] } },
    ], bodies),
  });
  assertEquals(res.text, "ok");
  assertEquals(bodies.length, 2);
  assertEquals(bodies[1].max_tokens, 8192);
});

Deno.test("compat: 400 'at most 16384' etter max_completion_tokens-bytte → senket tak beholdes", async () => {
  const bodies: Record<string, unknown>[] = [];
  await messageOpenAiCompat(COMPAT, { system: "S", prompt: "p", maxTokens: 32000 }, {
    fetchImpl: seq([
      { status: 400, body: { error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead." } } },
      { status: 400, body: { error: { message: "max_tokens is too large: 32000. This model supports at most 16384 completion tokens" } } },
      { status: 200, body: { choices: [{ message: { content: "ok" } }] } },
    ], bodies),
  });
  assertEquals(bodies.length, 3);
  assertEquals(bodies[1].max_completion_tokens, 32000);
  assertEquals(bodies[2].max_completion_tokens, 16384);
  assertEquals("max_tokens" in bodies[2], false);
});

Deno.test("compat: token-tak-400 uten tall → parameteren utelates", async () => {
  const bodies: Record<string, unknown>[] = [];
  await messageOpenAiCompat(COMPAT, { system: "S", prompt: "p", maxTokens: 32000 }, {
    fetchImpl: seq([
      { status: 400, body: { error: { message: "max_tokens exceeds the model's token limit" } } },
      { status: 200, body: { choices: [{ message: { content: "ok" } }] } },
    ], bodies),
  });
  assertEquals("max_tokens" in bodies[1], false);
  assertEquals("max_completion_tokens" in bodies[1], false);
});

Deno.test("responses: 400 om max_output_tokens → ett nytt forsøk med senket tak", async () => {
  const bodies: Record<string, unknown>[] = [];
  const res = await makeOpenAiResponsesTurn(RESP)(freshState(), {
    system: "S", tools: TOOLS, maxTokens: 32000,
    deps: { fetchImpl: seq([
      { status: 400, body: { error: { message: "max_output_tokens is too large: 32000. This model supports at most 16384 completion tokens" } } },
      { status: 200, body: { id: "r1", output: [{ type: "message", content: [{ type: "output_text", text: "Svar" }] }] } },
    ], bodies) },
  });
  assertEquals(res.text, "Svar");
  assertEquals(bodies[1].max_output_tokens, 16384);
});

// ── Bug 3: samtalehistorikk ──────────────────────────────────────────────

Deno.test("løkka: forhistorikk seedes foran dagens spørsmål", async () => {
  let first: AgenticResumeState | undefined;
  await collect(runProviderAgenticStream({
    runTurn: (s) => {
      first = structuredClone(s);
      return Promise.resolve({ text: "x", toolUses: [], searchNotes: [], stop: "end", usage: { inputTokens: 0, outputTokens: 0 } });
    },
    system: "S", userContent: "Nå?", tools: [], executeTool: () => Promise.resolve(""),
    forhistorikk: [{ role: "user", content: "Før?" }, { role: "assistant", content: "Svar før." }],
  }));
  assertEquals(first!.messages, [
    { role: "user", content: "Før?" },
    { role: "assistant", content: "Svar før." },
    { role: "user", content: "Nå?" },
  ]);
});

Deno.test("responses: første tur med historikk → input-liste, dagens spørsmål sist", async () => {
  const bodies: Record<string, unknown>[] = [];
  await makeOpenAiResponsesTurn(RESP)(freshState([
    { role: "user", content: "Før?" },
    { role: "assistant", content: "Svar før." },
    { role: "user", content: "Nå?" },
  ]), {
    system: "S", tools: TOOLS, maxTokens: 10,
    deps: { fetchImpl: seq([{ status: 200, body: { id: "r1", output: [] } }], bodies) },
  });
  assertEquals(bodies[0].input, [
    { role: "user", content: "Før?" },
    { role: "assistant", content: "Svar før." },
    { role: "user", content: "Nå?" },
  ]);
});

// ── Bug 4: effort til vilkårlige modeller ───────────────────────────────

Deno.test("single compat: 400 om reasoning_effort → ett nytt forsøk uten effort", async () => {
  const bodies: Record<string, unknown>[] = [];
  const events = await collect(await streamProvider(COMPAT, { apiKey: "", model: "", prompt: "p" }, { effort: "medium" }, {
    fetchImpl: seq([
      { status: 400, body: { error: { message: "Unrecognized request argument supplied: reasoning_effort" } } },
      { status: 200, sse: true, body: ['{"choices":[{"delta":{"content":"Hei"},"finish_reason":"stop"}]}', "[DONE]"] },
    ], bodies),
    sleep: () => Promise.resolve(),
  }));
  assertEquals(bodies[0].reasoning_effort, "medium");
  assertEquals("reasoning_effort" in bodies[1], false);
  assert(events.some((e) => e.type === "done"));
});

Deno.test("single responses: 400 om reasoning.effort → nytt forsøk uten reasoning (message)", async () => {
  const bodies: Record<string, unknown>[] = [];
  const res = await messageProvider(RESP, { apiKey: "", model: "", prompt: "p" }, { effort: "low" }, {
    fetchImpl: seq([
      { status: 400, body: { error: { message: "Unsupported parameter: 'reasoning.effort' is not supported with this model." } } },
      { status: 200, body: { output: [{ content: [{ type: "output_text", text: "ok" }] }] } },
    ], bodies),
  });
  assertEquals(res.text, "ok");
  assertEquals("reasoning" in bodies[1], false);
});

Deno.test("single: annen 400 → ingen retry, generisk feil", async () => {
  const bodies: Record<string, unknown>[] = [];
  await assertRejects(() => messageProvider(COMPAT, { apiKey: "", model: "", prompt: "p" }, { effort: "low" }, {
    fetchImpl: seq([{ status: 400, body: { error: { message: "bad model" } } }], bodies),
  }), Error, "Leverandørfeil 400");
  assertEquals(bodies.length, 1);
});
