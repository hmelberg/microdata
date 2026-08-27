import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { makeOpenAiCompatTurn, messageOpenAiCompat, toOpenAiMessages, toOpenAiTools } from "./openai-compat.ts";
import type { ProviderConfig } from "./config.ts";
import type { AgenticResumeState } from "../anthropic.ts";

const CFG: ProviderConfig = {
  type: "openai-compat", baseUrl: "https://llm.example/v1",
  model: "test-m", key: "sk-proj-abc123XYZ", webSearch: "none",
};
const freshState = (): AgenticResumeState => ({
  messages: [{ role: "user", content: "Spørsmål?" }], turn: 0, clientCalls: 0,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
});
function fakeFetch(status: number, body: unknown, captured: { url?: string; body?: Record<string, unknown>; headers?: Record<string, string> } = {}): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    captured.url = String(input);
    captured.body = JSON.parse(String(init?.body));
    captured.headers = (init?.headers as Record<string, string>) ?? {};
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as typeof fetch;
}

/** Returns a canned response per call, capturing each call's request body. */
function sequentialFetch(
  responses: { status: number; body: unknown }[],
  captured: { bodies: Record<string, unknown>[] },
): typeof fetch {
  let i = 0;
  return ((_input: string | URL | Request, init?: RequestInit) => {
    captured.bodies.push(JSON.parse(String(init?.body)));
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status }));
  }) as typeof fetch;
}

Deno.test("toOpenAiTools: input_schema → function.parameters", () => {
  const out = toOpenAiTools([{ name: "probe", description: "d", input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } }]) as Record<string, Record<string, unknown>>[];
  assertEquals(out[0].function.name, "probe");
  assertEquals((out[0].function.parameters as Record<string, unknown>).required, ["url"]);
});

Deno.test("toOpenAiMessages: tool_use/tool_result-historikk oversettes", () => {
  const msgs = toOpenAiMessages("SYS", [
    { role: "user", content: "Q?" },
    { role: "assistant", content: [
      { type: "text", text: "tenker" },
      { type: "tool_use", id: "c1", name: "probe", input: { url: "u1" } },
    ]},
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok=true" }] },
  ]) as Record<string, unknown>[];
  assertEquals(msgs[0], { role: "system", content: "SYS" });
  assertEquals(msgs[1], { role: "user", content: "Q?" });
  const asst = msgs[2] as { tool_calls: { id: string; function: { name: string; arguments: string } }[] };
  assertEquals(asst.tool_calls[0].id, "c1");
  assertEquals(JSON.parse(asst.tool_calls[0].function.arguments), { url: "u1" });
  assertEquals(msgs[3], { role: "tool", tool_call_id: "c1", content: "ok=true" });
});

Deno.test("makeOpenAiCompatTurn: tool_calls → toolUses, stop tool_use", async () => {
  const captured: { url?: string; body?: Record<string, unknown>; headers?: Record<string, string> } = {};
  const turn = makeOpenAiCompatTurn(CFG);
  const res = await turn(freshState(), {
    system: "SYS", maxTokens: 100,
    tools: [{ name: "probe", description: "d", input_schema: { type: "object", properties: {} } }],
    deps: { fetchImpl: fakeFetch(200, {
      choices: [{ message: { content: null, tool_calls: [
        { id: "c9", type: "function", function: { name: "probe", arguments: `{"url":"u9"}` } },
      ]}}],
      usage: { prompt_tokens: 11, completion_tokens: 3 },
    }, captured) },
  });
  assertEquals(captured.url, "https://llm.example/v1/chat/completions");
  assertEquals(captured.headers?.["Authorization"], "Bearer sk-proj-abc123XYZ");
  assertEquals(res.stop, "tool_use");
  assertEquals(res.toolUses, [{ id: "c9", name: "probe", input: { url: "u9" } }]);
  assertEquals(res.usage, { inputTokens: 11, outputTokens: 3 });
});

Deno.test("makeOpenAiCompatTurn: 400 m/ tool-avvisning → spec-melding; nøkkel aldri i feil", async () => {
  const turn = makeOpenAiCompatTurn(CFG);
  const err = await assertRejects(() => turn(freshState(), {
    system: "S", maxTokens: 10, tools: [{ name: "probe", input_schema: {} }],
    deps: { fetchImpl: fakeFetch(400, { error: { message: "'tools' is not supported, key sk-proj-abc123XYZ" } }), retries: 0 },
  }), Error);
  if (!err.message.includes("verktøystøtte")) throw new Error("feil melding: " + err.message);
  if (err.message.includes("sk-proj")) throw new Error("nøkkel i feilmelding");
});

Deno.test("messageOpenAiCompat: enkel tur uten tools", async () => {
  const captured: { body?: Record<string, unknown> } = {};
  const res = await messageOpenAiCompat(CFG, { system: "SYS", prompt: "P", maxTokens: 55 },
    { fetchImpl: fakeFetch(200, { choices: [{ message: { content: "Svar." } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }, captured) });
  assertEquals(res.text, "Svar.");
  assertEquals(captured.body?.tools, undefined);
  assertEquals(captured.body?.max_tokens, 55);
});

// ── Fix 4: max_tokens fallback (some OpenAI chat models reject max_tokens,
// wanting max_completion_tokens instead; most compat providers still want
// max_tokens — so send max_tokens first and retry once on rejection). ──

Deno.test("makeOpenAiCompatTurn: 400 max_tokens rejection → retries once with max_completion_tokens", async () => {
  const captured: { bodies: Record<string, unknown>[] } = { bodies: [] };
  const turn = makeOpenAiCompatTurn(CFG);
  const res = await turn(freshState(), {
    system: "SYS", maxTokens: 123, tools: [],
    deps: { fetchImpl: sequentialFetch([
      { status: 400, body: { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } } },
      { status: 200, body: { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } },
    ], captured) },
  });
  assertEquals(res.text, "ok");
  assertEquals(captured.bodies.length, 2);
  assertEquals(captured.bodies[0].max_tokens, 123);
  assertEquals("max_completion_tokens" in captured.bodies[0], false);
  assertEquals(captured.bodies[1].max_completion_tokens, 123);
  assertEquals("max_tokens" in captured.bodies[1], false);
});

Deno.test("makeOpenAiCompatTurn: non-max_tokens 400 still throws without retry", async () => {
  const captured: { bodies: Record<string, unknown>[] } = { bodies: [] };
  const turn = makeOpenAiCompatTurn(CFG);
  await assertRejects(() => turn(freshState(), {
    system: "SYS", maxTokens: 10, tools: [],
    deps: { fetchImpl: sequentialFetch([
      { status: 400, body: { error: { message: "invalid api key" } } },
    ], captured), retries: 0 },
  }), Error);
  assertEquals(captured.bodies.length, 1);
});

Deno.test("messageOpenAiCompat: 400 max_tokens rejection → retries once with max_completion_tokens", async () => {
  const captured: { bodies: Record<string, unknown>[] } = { bodies: [] };
  const res = await messageOpenAiCompat(CFG, { system: "SYS", prompt: "P", maxTokens: 55 }, {
    fetchImpl: sequentialFetch([
      { status: 400, body: { error: { message: "Unsupported parameter: 'max_tokens'" } } },
      { status: 200, body: { choices: [{ message: { content: "Svar." } }], usage: { prompt_tokens: 5, completion_tokens: 2 } } },
    ], captured),
  });
  assertEquals(res.text, "Svar.");
  assertEquals(captured.bodies.length, 2);
  assertEquals(captured.bodies[1].max_completion_tokens, 55);
  assertEquals("max_tokens" in captured.bodies[1], false);
});

Deno.test("messageOpenAiCompat: non-max_tokens 400 still throws without retry", async () => {
  const captured: { bodies: Record<string, unknown>[] } = { bodies: [] };
  await assertRejects(() => messageOpenAiCompat(CFG, { system: "SYS", prompt: "P", maxTokens: 55 }, {
    fetchImpl: sequentialFetch([
      { status: 400, body: { error: { message: "insufficient_quota" } } },
    ], captured),
  }), Error);
  assertEquals(captured.bodies.length, 1);
});
