import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fetchWithRetry, messageAnthropic, runAgenticStream } from "./anthropic.ts";

const noSleep = (_ms: number) => Promise.resolve();

function resp(status: number, headers: Record<string, string> = {}): Response {
  return new Response("body", { status, headers });
}

Deno.test("fetchWithRetry: retries on 429 then returns success", async () => {
  let calls = 0;
  const fetchImpl = ((_url: string | URL | Request, _init?: RequestInit) => {
    calls++;
    return Promise.resolve(calls < 3 ? resp(429) : resp(200));
  }) as typeof fetch;
  const r = await fetchWithRetry("https://x/", { method: "POST" }, {
    fetchImpl,
    sleep: noSleep,
    retries: 3,
  });
  assertEquals(r.status, 200);
  assertEquals(calls, 3);
});

Deno.test("fetchWithRetry: retries on 529 (overloaded)", async () => {
  let calls = 0;
  const fetchImpl = (() => {
    calls++;
    return Promise.resolve(calls < 2 ? resp(529) : resp(200));
  }) as typeof fetch;
  const r = await fetchWithRetry("https://x/", {}, { fetchImpl, sleep: noSleep, retries: 2 });
  assertEquals(r.status, 200);
  assertEquals(calls, 2);
});

Deno.test("fetchWithRetry: does NOT retry on 400", async () => {
  let calls = 0;
  const fetchImpl = (() => {
    calls++;
    return Promise.resolve(resp(400));
  }) as typeof fetch;
  const r = await fetchWithRetry("https://x/", {}, { fetchImpl, sleep: noSleep, retries: 3 });
  assertEquals(r.status, 400);
  assertEquals(calls, 1);
});

Deno.test("fetchWithRetry: gives up after exhausting retries on 429", async () => {
  let calls = 0;
  const fetchImpl = (() => {
    calls++;
    return Promise.resolve(resp(429));
  }) as typeof fetch;
  const r = await fetchWithRetry("https://x/", {}, { fetchImpl, sleep: noSleep, retries: 2 });
  assertEquals(r.status, 429);
  assertEquals(calls, 3); // initial + 2 retries
});

Deno.test("fetchWithRetry: retries network errors, then propagates", async () => {
  let calls = 0;
  const fetchImpl = (() => {
    calls++;
    return Promise.reject(new Error("boom"));
  }) as typeof fetch;
  await assertRejects(
    () => fetchWithRetry("https://x/", {}, { fetchImpl, sleep: noSleep, retries: 2 }),
    Error,
    "boom",
  );
  assertEquals(calls, 3);
});

Deno.test("fetchWithRetry: honours numeric Retry-After (capped)", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const fetchImpl = (() => {
    calls++;
    return Promise.resolve(calls < 2 ? resp(429, { "retry-after": "3" }) : resp(200));
  }) as typeof fetch;
  await fetchWithRetry("https://x/", {}, {
    fetchImpl,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    retries: 2,
  });
  assertEquals(sleeps[0], 3000);
});

Deno.test("messageAnthropic returns text and usage from a non-streamed response", async () => {
  const fakeResponse = new Response(
    JSON.stringify({
      content: [{ type: "text", text: '["BEFOLKNING_KJOENN","INNTEKT_WLONN"]' }],
      usage: { input_tokens: 100, output_tokens: 12 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
  const fetchImpl = (() => Promise.resolve(fakeResponse)) as typeof fetch;

  const out = await messageAnthropic(
    { apiKey: "k", model: "m", prompt: "q", system: "s", maxTokens: 64 },
    { fetchImpl },
  );
  assertEquals(out.text, '["BEFOLKNING_KJOENN","INNTEKT_WLONN"]');
  assertEquals(out.usage.outputTokens, 12);
});

Deno.test("messageAnthropic throws on non-OK upstream", async () => {
  const fetchImpl = (() => Promise.resolve(new Response("boom", { status: 500 }))) as typeof fetch;
  let threw = false;
  try {
    await messageAnthropic({ apiKey: "k", model: "m", prompt: "q" }, { fetchImpl });
  } catch (_e) {
    threw = true;
  }
  assertEquals(threw, true);
});

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<Record<string, unknown>[]> {
  const text = await new Response(stream).text();
  return text.split("\n\n").filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
}

// ── Streaming-turer (portert fra askstats anthropic.test.ts 2026-08-28) ──
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

function streamedToolTurn(toolName: string, id: string, inputJson: string) {
  return [
    { type: "message_start", message: { usage: { input_tokens: 8 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Jeg sjekker kilden." } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id, name: toolName, input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: inputJson.slice(0, 8) } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: inputJson.slice(8) } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ];
}

function sseFetch(turns: unknown[][]): typeof fetch {
  let call = 0;
  return (() =>
    Promise.resolve(new Response(sseUpstream(turns[call++]), { status: 200 }))
  ) as unknown as typeof fetch;
}

Deno.test("runAgenticStream: tool round-trip then final text", async () => {
  const fetchImpl = sseFetch([
    streamedToolTurn("probe", "tu1", JSON.stringify({ url: "https://x/d.csv" })),
    streamedTextTurn("Her er scriptet."),
  ]);
  const calls: string[] = [];
  const events = await collectSse(runAgenticStream({
    apiKey: "k", model: "m", system: "s", userContent: "q",
    tools: [{ name: "probe", description: "d", input_schema: { type: "object" } }],
    executeTool: (name, input) => { calls.push(`${name}:${input.url}`); return Promise.resolve('{"ok":true}'); },
    turnsPerCall: 99,
    deps: { fetchImpl },
  }));
  assertEquals(calls, ["probe:https://x/d.csv"]);
  // Turn 1 ends in tool_use — its "Jeg sjekker kilden." text was scratch work,
  // discarded via turn_discard. Turn 2's deltas (after turn_discard) are the
  // real final answer; no separate "text" event exists anymore.
  assertEquals(events.some((e) => e.type === "text"), false);
  assertEquals(events.some((e) => e.type === "turn_discard"), true);
  const discardIdx = events.findIndex((e) => e.type === "turn_discard");
  const finalDeltas = events.slice(discardIdx + 1)
    .filter((e) => e.type === "delta").map((e) => e.text).join("");
  assertEquals(finalDeltas, "Her er scriptet.");
  const done = events.at(-1)!;
  assertEquals(done.type, "done");
  assertEquals(done.inputTokens, 18); // 8 (tool turn) + 10 (final turn)
  assertEquals(done.outputTokens, 12); // 7 (tool turn) + 5 (final turn)
});

Deno.test("runAgenticStream: hosted web_search/web_fetch surface as progress labels", async () => {
  const fetchImpl = sseFetch([
    [
      { type: "message_start", message: { usage: { input_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "s1", name: "web_search", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ query: "utdanning lønn norge" }) } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "pause_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ],
    [
      { type: "message_start", message: { usage: { input_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "s2", name: "web_fetch", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ url: "https://ssb.no/x" }) } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "svar" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ],
  ]);
  const events = await collectSse(runAgenticStream({
    apiKey: "k", model: "m", system: "s", userContent: "q", tools: [],
    executeTool: () => Promise.resolve(""),
    turnsPerCall: 99,
    deps: { fetchImpl },
  }));
  const labels = events.filter((e) => e.type === "progress" && !e.replace).map((e) => e.text);
  assertEquals(labels, ["🔎 Websøk: utdanning lønn norge", "🌐 Leser https://ssb.no/x"]);
  assertEquals(events.at(-1)?.type, "done");
});

Deno.test("runAgenticStream: budget exhausts into forced generation", async () => {
  const toolTurn = streamedToolTurn("probe", "t", JSON.stringify({}));
  const finalTurn = streamedTextTurn("ferdig");
  let toolResults: string[] = [];
  const events = await collectSse(runAgenticStream({
    apiKey: "k", model: "m", system: "s", userContent: "q",
    tools: [], maxClientToolCalls: 2, turnsPerCall: 99,
    executeTool: () => { return Promise.resolve("data"); },
    deps: { fetchImpl: (( _u: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const lastUser = body.messages.filter((m: { role: string }) => m.role === "user").pop();
      if (Array.isArray(lastUser?.content)) {
        for (const c of lastUser.content) if (c.type === "tool_result") toolResults.push(String(c.content));
      }
      const turn = body.messages.length >= 7 ? finalTurn : toolTurn; // 3 tool rounds then final
      return Promise.resolve(new Response(sseUpstream(turn), { status: 200 }));
    }) as typeof fetch },
  }));
  // third call is over budget (max 2) -> its result is the budget message
  if (!toolResults[2]?.includes("budsjett")) throw new Error("ventet budsjett-melding: " + toolResults[2]);
  assertEquals(events.at(-1)?.type, "done");
});

Deno.test("runAgenticStream: default one turn per call — continue carries state, resume finishes", async () => {
  const fetchImpl = sseFetch([
    streamedToolTurn("probe", "tu1", JSON.stringify({ url: "https://x/d.csv" })),
    streamedTextTurn("ferdig svar"),
  ]);
  const base = {
    apiKey: "k", model: "m", system: "s", userContent: "q", tools: [],
    executeTool: () => Promise.resolve('{"ok":true}'),
    continueExtra: () => ({ probed: [{ url: "https://x/d.csv", ok: true }] }),
    deps: { fetchImpl },
  };
  // Invocation 1: one tool turn, then hands back state instead of looping on.
  const ev1 = await collectSse(runAgenticStream(base));
  const cont = ev1.at(-1)!;
  assertEquals(cont.type, "continue");
  const st = cont.state as { turn: number; clientCalls: number; messages: unknown[]; usage: Record<string, number> };
  assertEquals(st.turn, 1);
  assertEquals(st.clientCalls, 1);
  assertEquals(st.messages.length, 3); // user q, assistant tool_use, user tool_result
  assertEquals((cont.probed as { url: string }[])[0].url, "https://x/d.csv");
  // Invocation 2: resumes from the state and finishes; usage summed across both.
  const ev2 = await collectSse(runAgenticStream({ ...base, resume: st as never }));
  const deltas = ev2.filter((e) => e.type === "delta").map((e) => e.text).join("");
  assertEquals(deltas, "ferdig svar");
  const done = ev2.at(-1)!;
  assertEquals(done.type, "done");
  assertEquals(done.inputTokens, 18); // 8 (turn 1, tool) + 10 (turn 2, final)
  assertEquals(done.outputTokens, 12); // 7 (turn 1, tool) + 5 (turn 2, final)
});

Deno.test("runAgenticStream: API error surfaces as error event", async () => {
  const events = await collectSse(runAgenticStream({
    apiKey: "k", model: "m", system: "s", userContent: "q", tools: [],
    executeTool: () => Promise.resolve(""),
    deps: { fetchImpl: ((_u: string | URL | Request) =>
      Promise.resolve(new Response("boom", { status: 500 }))) as typeof fetch, retries: 0 },
  }));
  assertEquals(events.at(-1)?.type, "error");
});

// ── apiBase + effort (multi-provider-runden 2026-08-27) ───────────────────
import { streamAnthropic } from "./anthropic.ts";

/** Fanger url + parset body fra ETT kall, og svarer med en tom SSE-strøm. */
function captureBody() {
  const seen: { url: string; body: Record<string, unknown> } = { url: "", body: {} };
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    seen.body = JSON.parse(String(init?.body ?? "{}"));
    return Promise.resolve(
      new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 }),
    );
  }) as typeof fetch;
  return { seen, deps: { fetchImpl, sleep: () => Promise.resolve() } };
}

Deno.test("effort is nested under output_config, never top-level", async () => {
  const { seen, deps } = captureBody();
  await streamAnthropic({ apiKey: "k", model: "claude-sonnet-5", prompt: "p", effort: "high" }, deps);
  assertEquals(seen.body.output_config, { effort: "high" });
  assertEquals(seen.body.effort, undefined);
});

Deno.test("no output_config at all when effort is unset (it errors on Haiku 4.5)", async () => {
  const { seen, deps } = captureBody();
  await streamAnthropic({ apiKey: "k", model: "claude-haiku-4-5", prompt: "p" }, deps);
  assertEquals("output_config" in seen.body, false);
});

Deno.test("apiBase redirects the POST to the gateway's /messages", async () => {
  const { seen, deps } = captureBody();
  await streamAnthropic({ apiKey: "k", model: "m", prompt: "p", apiBase: "https://gw.example/v1" }, deps);
  assertEquals(seen.url, "https://gw.example/v1/messages");
});

Deno.test("without apiBase the POST still goes to the real Anthropic endpoint", async () => {
  const { seen, deps } = captureBody();
  await streamAnthropic({ apiKey: "k", model: "m", prompt: "p" }, deps);
  assertEquals(seen.url, "https://api.anthropic.com/v1/messages");
});

Deno.test("messageAnthropic carries effort and apiBase the same way", async () => {
  const { seen, deps } = captureBody();
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    seen.body = JSON.parse(String(init?.body ?? "{}"));
    return Promise.resolve(Response.json({ content: [{ type: "text", text: "x" }], usage: {} }));
  }) as typeof fetch;
  await messageAnthropic(
    { apiKey: "k", model: "m", prompt: "p", effort: "medium", apiBase: "https://gw.example/v1" },
    { ...deps, fetchImpl },
  );
  assertEquals(seen.url, "https://gw.example/v1/messages");
  assertEquals(seen.body.output_config, { effort: "medium" });
});

Deno.test("anthropic-workspace-id is sent only when configured", async () => {
  const prev = Deno.env.get("ANTHROPIC_WORKSPACE_ID");
  try {
    Deno.env.delete("ANTHROPIC_WORKSPACE_ID");
    let seenHeaders: Headers = new Headers();
    const grab = ((_u: string | URL | Request, init?: RequestInit) => {
      seenHeaders = new Headers(init?.headers);
      return Promise.resolve(
        new Response(new ReadableStream({ start: (c) => c.close() })),
      );
    }) as typeof fetch;
    await streamAnthropic({ apiKey: "k", model: "m", prompt: "p" },
      { fetchImpl: grab, sleep: () => Promise.resolve() });
    assertEquals(seenHeaders.get("anthropic-workspace-id"), null);

    Deno.env.set("ANTHROPIC_WORKSPACE_ID", "wrkspc_123");
    await streamAnthropic({ apiKey: "k", model: "m", prompt: "p" },
      { fetchImpl: grab, sleep: () => Promise.resolve() });
    assertEquals(seenHeaders.get("anthropic-workspace-id"), "wrkspc_123");
  } finally {
    Deno.env.delete("ANTHROPIC_WORKSPACE_ID");
    if (prev !== undefined) Deno.env.set("ANTHROPIC_WORKSPACE_ID", prev);
  }
});
