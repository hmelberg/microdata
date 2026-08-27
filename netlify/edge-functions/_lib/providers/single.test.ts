import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { messageProvider, streamProvider } from "./single.ts";
import type { ProviderConfig } from "./config.ts";
import type { StreamEvent } from "../anthropic.ts";

function prov(type: ProviderConfig["type"]): ProviderConfig {
  const base = {
    "openai-compat": { baseUrl: "https://api.mistral.ai/v1", model: "mistral-large-latest" },
    "openai-responses": { baseUrl: "https://api.openai.com/v1", model: "gpt-5.6" },
    "anthropic-compat": { baseUrl: "https://gw.example/v1", model: "claude-sonnet-5" },
  }[type];
  return { type, ...base, key: "sk-secret-123", webSearch: "none" };
}
const base = () => ({ apiKey: "IGNORED-KEY", model: "IGNORED-MODEL", prompt: "p", system: "s" });

/** Upstream SSE stream from raw payload lines. */
function sse(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(`data: ${l}\n\n`));
      c.close();
    },
  });
}

/** Collect the StreamEvents our own transform emits. */
async function drain(s: ReadableStream<Uint8Array>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of s) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (line.startsWith("data:")) out.push(JSON.parse(line.slice(5).trim()));
    }
  }
  return out;
}

function captureBody(body?: unknown) {
  const seen: { url: string; body: Record<string, unknown>; auth: string } = { url: "", body: {}, auth: "" };
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    seen.body = JSON.parse(String(init?.body ?? "{}"));
    seen.auth = String(new Headers(init?.headers).get("authorization") ?? "");
    return Promise.resolve(
      body === undefined
        ? new Response(new ReadableStream({ start: (c) => c.close() }))
        : Response.json(body),
    );
  }) as typeof fetch;
  return { seen, deps: { fetchImpl, sleep: () => Promise.resolve() } };
}

Deno.test("openai-compat emits the app's own SSE contract", async () => {
  const deps = {
    fetchImpl: (() =>
      Promise.resolve(new Response(sse([
        '{"choices":[{"delta":{"content":"Hei"}}]}',
        '{"choices":[{"delta":{"content":" du"}}]}',
        '{"usage":{"prompt_tokens":11,"completion_tokens":3}}',
        "[DONE]",
      ])))) as typeof fetch,
    sleep: () => Promise.resolve(),
  };
  const events = await drain(await streamProvider(prov("openai-compat"), base(), {}, deps));
  assertEquals(events[0], { type: "text", text: "Hei" });
  assertEquals(events[1], { type: "text", text: " du" });
  assertEquals(events[2].type, "done");
  assertEquals(events[2].inputTokens, 11);
  assertEquals(events[2].outputTokens, 3);
  assertEquals(events[2].cacheReadTokens, 0);
  assertEquals(events[2].cacheCreationTokens, 0);
});

Deno.test("streamProvider sends p.model and NEVER choice.model", async () => {
  const { seen, deps } = captureBody();
  await streamProvider(
    prov("openai-compat"), base(), { model: "ALSO-WRONG" } as { effort?: string }, deps,
  );
  assertEquals(seen.body.model, "mistral-large-latest");
});

Deno.test("openai-compat uses the provider key, not opts.apiKey", async () => {
  const { seen, deps } = captureBody();
  await streamProvider(prov("openai-compat"), base(), {}, deps);
  assertEquals(seen.auth, "Bearer sk-secret-123");
});

Deno.test("openai-compat carries effort as reasoning_effort, and omits it when unset", async () => {
  const a = captureBody();
  await streamProvider(prov("openai-compat"), base(), { effort: "high" }, a.deps);
  assertEquals(a.seen.body.reasoning_effort, "high");
  const b = captureBody();
  await streamProvider(prov("openai-compat"), base(), {}, b.deps);
  assertEquals("reasoning_effort" in b.seen.body, false);
});

Deno.test("openai-compat sends system+user as two messages and asks for usage", async () => {
  const { seen, deps } = captureBody();
  await streamProvider(prov("openai-compat"), base(), {}, deps);
  assertEquals(seen.url, "https://api.mistral.ai/v1/chat/completions");
  assertEquals(seen.body.messages, [{ role: "system", content: "s" }, { role: "user", content: "p" }]);
  assertEquals(seen.body.stream, true);
  assertEquals(seen.body.stream_options, { include_usage: true });
});

Deno.test("openai-responses uses instructions/input and nests effort under reasoning", async () => {
  const { seen, deps } = captureBody();
  await streamProvider(prov("openai-responses"), base(), { effort: "xhigh" }, deps);
  assertEquals(seen.url, "https://api.openai.com/v1/responses");
  assertEquals(seen.body.instructions, "s");
  assertEquals(seen.body.input, "p");
  assertEquals(seen.body.reasoning, { effort: "xhigh" });
});

Deno.test("openai-responses reads output_text.delta", async () => {
  const deps = {
    fetchImpl: (() =>
      Promise.resolve(new Response(sse([
        '{"type":"response.output_text.delta","delta":"Hall"}',
        '{"type":"response.output_text.delta","delta":"o"}',
        '{"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":2}}}',
      ])))) as typeof fetch,
    sleep: () => Promise.resolve(),
  };
  const events = await drain(await streamProvider(prov("openai-responses"), base(), {}, deps));
  assertEquals(events.filter((e) => e.type === "text").map((e) => e.text).join(""), "Hallo");
  const done = events[events.length - 1];
  assertEquals(done.inputTokens, 7);
  assertEquals(done.outputTokens, 2);
});

Deno.test("anthropic-compat delegates to streamAnthropic with apiBase", async () => {
  const { seen, deps } = captureBody();
  await streamProvider(prov("anthropic-compat"), base(), { effort: "high" }, deps);
  assertEquals(seen.url, "https://gw.example/v1/messages");
  assertEquals(seen.body.output_config, { effort: "high" });
  assertEquals(seen.body.model, "claude-sonnet-5");
});

Deno.test("an upstream error never echoes the key", async () => {
  const deps = {
    fetchImpl: (() =>
      Promise.resolve(new Response("invalid key sk-secret-123", { status: 401 }))) as typeof fetch,
    sleep: () => Promise.resolve(),
    retries: 0,
  };
  const err = await streamProvider(prov("openai-compat"), base(), {}, deps)
    .then(() => "NO THROW").catch((e) => String(e));
  assertEquals(err.includes("sk-secret-123"), false);
  assertEquals(err.includes("401"), true);
});

Deno.test("messageProvider returns joined text and usage (openai-compat)", async () => {
  const { deps } = captureBody({
    choices: [{ message: { content: "svar" } }],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
  });
  const r = await messageProvider(prov("openai-compat"), base(), {}, deps);
  assertEquals(r.text, "svar");
  assertEquals(r.usage.inputTokens, 5);
  assertEquals(r.usage.outputTokens, 2);
  assertEquals(r.usage.cacheReadTokens, 0);
});

Deno.test("messageProvider handles openai-responses output_text", async () => {
  const { deps } = captureBody({
    output: [{ type: "message", content: [{ type: "output_text", text: "hei" }] }],
    usage: { input_tokens: 3, output_tokens: 1 },
  });
  const r = await messageProvider(prov("openai-responses"), base(), {}, deps);
  assertEquals(r.text, "hei");
  assertEquals(r.usage.inputTokens, 3);
});
