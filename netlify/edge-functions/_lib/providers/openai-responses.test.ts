import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { makeOpenAiResponsesTurn, messageOpenAiResponses } from "./openai-responses.ts";
import type { ProviderConfig } from "./config.ts";
import type { AgenticResumeState } from "../anthropic.ts";

const CFG: ProviderConfig = {
  type: "openai-responses", baseUrl: "https://api.openai.example/v1",
  model: "gpt-test", key: "sk-proj-abc123XYZ", webSearch: "native",
};
function fakeFetch(status: number, body: unknown, captured: { url?: string; body?: Record<string, unknown> } = {}): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    captured.url = String(input);
    captured.body = JSON.parse(String(init?.body));
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as typeof fetch;
}
const TOOLS = [{ name: "probe", description: "d", input_schema: { type: "object", properties: {} } }];

Deno.test("første tur: instructions+input+web_search-tool; output mappes", async () => {
  const captured: { url?: string; body?: Record<string, unknown> } = {};
  const state: AgenticResumeState = {
    messages: [{ role: "user", content: "Q?" }], turn: 0, clientCalls: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  };
  const res = await makeOpenAiResponsesTurn(CFG)(state, {
    system: "SYS", tools: TOOLS, maxTokens: 99,
    deps: { fetchImpl: fakeFetch(200, {
      id: "resp_1",
      output: [
        { type: "web_search_call", action: { query: "norsk rente" } },
        { type: "function_call", call_id: "c1", name: "probe", arguments: `{"url":"u"}` },
      ],
      usage: { input_tokens: 7, output_tokens: 2 },
    }, captured) },
  });
  assertEquals(captured.url, "https://api.openai.example/v1/responses");
  assertEquals(captured.body?.instructions, "SYS");
  assertEquals(captured.body?.input, "Q?");
  assertEquals(captured.body?.store, true);
  assertEquals(captured.body?.max_output_tokens, 99);
  const tools = captured.body?.tools as Record<string, unknown>[];
  assertEquals(tools[0].type, "function");
  assertEquals(tools[0].name, "probe");
  assertEquals(tools[tools.length - 1], { type: "web_search" });
  assertEquals(res.responseId, "resp_1");
  assertEquals(res.toolUses, [{ id: "c1", name: "probe", input: { url: "u" } }]);
  assertEquals(res.searchNotes, ["🔎 Websøk: norsk rente"]);
  assertEquals(res.stop, "tool_use");
});

Deno.test("senere tur: previous_response_id + kun function_call_output", async () => {
  const captured: { body?: Record<string, unknown> } = {};
  const state: AgenticResumeState = {
    messages: [
      { role: "user", content: "Q?" },
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "probe", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok=true" }] },
    ],
    turn: 1, clientCalls: 1, prevResponseId: "resp_1",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  };
  const res = await makeOpenAiResponsesTurn(CFG)(state, {
    system: "SYS", tools: TOOLS, maxTokens: 99,
    deps: { fetchImpl: fakeFetch(200, {
      id: "resp_2",
      output: [{ type: "message", content: [{ type: "output_text", text: "Svar." }] }],
      usage: { input_tokens: 5, output_tokens: 4 },
    }, captured) },
  });
  assertEquals(captured.body?.previous_response_id, "resp_1");
  assertEquals(captured.body?.instructions, undefined);
  assertEquals(captured.body?.input, [{ type: "function_call_output", call_id: "c1", output: "ok=true" }]);
  assertEquals(res.text, "Svar.");
  assertEquals(res.stop, "end");
  assertEquals(res.responseId, "resp_2");
});

Deno.test("store-avvisning → spec-melding; nøkkel aldri i feilmelding", async () => {
  const state: AgenticResumeState = {
    messages: [{ role: "user", content: "Q?" }], turn: 0, clientCalls: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  };
  const err = await assertRejects(() => makeOpenAiResponsesTurn(CFG)(state, {
    system: "S", tools: TOOLS, maxTokens: 10,
    deps: { fetchImpl: fakeFetch(400, { error: { message: "store is not supported, sk-proj-abc123XYZ" } }), retries: 0 },
  }), Error);
  if (!err.message.includes("lagret samtaletilstand")) throw new Error("feil melding: " + err.message);
  if (err.message.includes("sk-proj")) throw new Error("nøkkel i feilmelding");
});

Deno.test("messageOpenAiResponses: enkel tur uten tools", async () => {
  const captured: { body?: Record<string, unknown> } = {};
  const res = await messageOpenAiResponses(CFG, { system: "SYS", prompt: "P", maxTokens: 44 },
    { fetchImpl: fakeFetch(200, {
      id: "resp_9",
      output: [{ type: "message", content: [{ type: "output_text", text: "Tolket." }] }],
      usage: { input_tokens: 3, output_tokens: 1 },
    }, captured) });
  assertEquals(res.text, "Tolket.");
  assertEquals(captured.body?.tools, undefined);
  assertEquals(captured.body?.store, false);
});

Deno.test("messageOpenAiResponses: 400 med 'tool' i detalj gir generisk feil (ingen tools sendt)", async () => {
  const err = await assertRejects(() => messageOpenAiResponses(CFG, { system: "S", prompt: "P", maxTokens: 10 },
    { fetchImpl: fakeFetch(400, { error: { message: "model gpt-x-tool-preview not found" } }), retries: 0 }), Error);
  if (err.message.includes("verktøystøtte")) throw new Error("feilklassifisert som tools-avvisning: " + err.message);
  if (!err.message.includes("Leverandørfeil 400")) throw new Error("uventet melding: " + err.message);
});
