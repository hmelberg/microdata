import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runProviderAgenticStream, type ProviderTurnResult } from "./agentic.ts";

async function collect(stream: ReadableStream<Uint8Array>): Promise<Record<string, unknown>[]> {
  const text = await new Response(stream).text();
  return text.split("\n\n").filter(Boolean)
    .map((l) => JSON.parse(l.replace(/^data: /, "")));
}

Deno.test("løkka: tool-tur → verktøy kjøres → neste tur gir svar (2 turer, turnsPerCall=2)", async () => {
  const turns: ProviderTurnResult[] = [
    { text: "", toolUses: [{ id: "c1", name: "probe", input: { url: "https://x.example/d.csv" } }],
      searchNotes: [], stop: "tool_use", usage: { inputTokens: 10, outputTokens: 5 } },
    { text: "Svaret.", toolUses: [], searchNotes: ["🔎 Websøk: testquery"], stop: "end",
      usage: { inputTokens: 20, outputTokens: 15 } },
  ];
  const seenStates: number[] = [];
  const executed: string[] = [];
  const events = await collect(runProviderAgenticStream({
    runTurn: (state) => { seenStates.push(state.messages.length); return Promise.resolve(turns.shift()!); },
    system: "SYS", userContent: "Q?", tools: [{ name: "probe" }],
    executeTool: (name, input) => { executed.push(`${name}:${input.url}`); return Promise.resolve("ok=true"); },
    turnsPerCall: 2,
  }));
  assertEquals(executed, ["probe:https://x.example/d.csv"]);
  assertEquals(seenStates, [1, 3]);            // Q → +assistant +tool_result
  const texts = events.filter((e) => e.type === "text");
  assertEquals(texts, [{ type: "text", text: "Svaret." }]);
  const done = events.find((e) => e.type === "done") as Record<string, number>;
  assertEquals(done.inputTokens, 30);
  assertEquals(done.outputTokens, 20);
  assertEquals(done.cacheReadTokens, 0);
  if (!events.some((e) => e.type === "progress" && String(e.text).includes("Websøk"))) {
    throw new Error("searchNotes ble ikke til progress-events");
  }
});

Deno.test("løkka: turnsPerCall brukt opp → continue-event med state + extra", async () => {
  const events = await collect(runProviderAgenticStream({
    runTurn: () => Promise.resolve({
      text: "", toolUses: [{ id: "c1", name: "probe", input: {} }],
      searchNotes: [], stop: "tool_use", usage: { inputTokens: 1, outputTokens: 1 },
    } as ProviderTurnResult),
    system: "SYS", userContent: "Q?", tools: [],
    executeTool: () => Promise.resolve("ok"),
    turnsPerCall: 1,
    continueExtra: () => ({ probed: [{ url: "u" }] }),
  }));
  const cont = events.find((e) => e.type === "continue") as Record<string, unknown>;
  if (!cont) throw new Error("mangler continue: " + JSON.stringify(events));
  const state = cont.state as { messages: unknown[]; turn: number };
  assertEquals(state.turn, 1);
  assertEquals(state.messages.length, 3);
  assertEquals((cont.probed as unknown[]).length, 1);
});

Deno.test("løkka: responseId lagres i state.prevResponseId, verktøybudsjett håndheves", async () => {
  let calls = 0;
  const events = await collect(runProviderAgenticStream({
    runTurn: () => Promise.resolve({
      text: "", toolUses: [{ id: `c${++calls}`, name: "probe", input: {} }],
      searchNotes: [], stop: "tool_use", usage: { inputTokens: 1, outputTokens: 1 },
      responseId: `resp_${calls}`,
    } as ProviderTurnResult),
    system: "SYS", userContent: "Q?", tools: [],
    executeTool: () => Promise.resolve("ok"),
    maxClientToolCalls: 1, turnsPerCall: 2,
  }));
  const cont = events.find((e) => e.type === "continue") as Record<string, unknown>;
  const state = cont.state as { prevResponseId?: string; messages: Record<string, unknown>[] };
  assertEquals(state.prevResponseId, "resp_2");
  // andre verktøykallet skal ha fått budsjett-beskjeden i tool_result
  const lastResults = state.messages[state.messages.length - 1].content as { content: string }[];
  if (!lastResults[0].content.includes("Verktøy-budsjettet")) {
    throw new Error("budsjettmelding mangler: " + JSON.stringify(lastResults));
  }
});

Deno.test("løkka: runTurn-feil → error-event, aldri exception", async () => {
  const events = await collect(runProviderAgenticStream({
    runTurn: () => Promise.reject(new Error("Leverandørfeil 500")),
    system: "SYS", userContent: "Q?", tools: [], executeTool: () => Promise.resolve("ok"),
  }));
  const err = events.find((e) => e.type === "error");
  if (!err || !String(err.message).includes("Leverandørfeil 500")) {
    throw new Error("mangler error-event: " + JSON.stringify(events));
  }
});

Deno.test("provider-løkka: run_code → run_code+continue m/ pending; resume m/ runResult fullfører", async () => {
  const turns = [
    { text: "", toolUses: [{ id: "p1", name: "run_code", input: { script: "1+1" } }], searchNotes: [], stop: "tool_use" as const, usage: { inputTokens: 1, outputTokens: 1 } },
    { text: "Ferdig", toolUses: [], searchNotes: [], stop: "end" as const, usage: { inputTokens: 1, outputTokens: 1 } },
  ];
  let call = 0;
  const runTurn = () => Promise.resolve(turns[call++]);
  const base = {
    runTurn, system: "s", userContent: "q", tools: [],
    executeTool: () => Promise.reject(new Error("skal ikke kalles")),
    clientTools: ["run_code"], turnsPerCall: 8,
  };
  const ev1 = await collect(runProviderAgenticStream(base));
  assertEquals(ev1.find((e) => e.type === "run_code")?.script, "1+1");
  const st = ev1.find((e) => e.type === "continue")?.state as never;
  const ev2 = await collect(runProviderAgenticStream({ ...base, resume: st, runResult: "OK:\n2" }));
  assertEquals(ev2.find((e) => e.type === "text")?.text, "Ferdig");
  assertEquals(ev2.at(-1)?.type, "done");
});

Deno.test("provider-løkka: get_pack → get_pack+continue m/ pending (name+expectedId); resume m/ getPackResult fullfører", async () => {
  const turns = [
    { text: "", toolUses: [{ id: "p1", name: "get_pack", input: { id: "norway" } }], searchNotes: [], stop: "tool_use" as const, usage: { inputTokens: 1, outputTokens: 1 } },
    { text: "Ferdig", toolUses: [], searchNotes: [], stop: "end" as const, usage: { inputTokens: 1, outputTokens: 1 } },
  ];
  let call = 0;
  const runTurn = () => Promise.resolve(turns[call++]);
  const base = {
    runTurn, system: "s", userContent: "q", tools: [],
    executeTool: () => Promise.reject(new Error("skal ikke kalles")),
    clientTools: ["run_code", "get_pack"], turnsPerCall: 8,
  };
  const ev1 = await collect(runProviderAgenticStream(base));
  assertEquals(ev1.find((e) => e.type === "get_pack")?.id, "norway");
  const st = ev1.find((e) => e.type === "continue")?.state as
    { pending?: Record<string, unknown>; getPackCalls?: number; runCalls?: number };
  assertEquals(st.pending?.name, "get_pack");
  assertEquals(st.pending?.expectedId, "norway");
  // Review-funn 2026-08-06 #3: EGEN teller — run_code sitt budsjett urørt.
  assertEquals(st.getPackCalls, 1);
  assertEquals(st.runCalls, undefined);
  const ev2 = await collect(runProviderAgenticStream({
    ...base, resume: st as never, getPackResult: { id: "norway", text: "full pakketekst" },
  }));
  assertEquals(ev2.find((e) => e.type === "text")?.text, "Ferdig");
  assertEquals(ev2.at(-1)?.type, "done");
});

Deno.test("provider-løkka: get_pack over EGET budsjett (maxGetPack) får server-side tool_result", async () => {
  const turns = [
    { text: "", toolUses: [{ id: "p1", name: "get_pack", input: { id: "x" } }], searchNotes: [], stop: "tool_use" as const, usage: { inputTokens: 1, outputTokens: 1 } },
    { text: "Ferdig uten flere pakke-hentinger", toolUses: [], searchNotes: [], stop: "end" as const, usage: { inputTokens: 1, outputTokens: 1 } },
  ];
  let call = 0;
  const events = await collect(runProviderAgenticStream({
    runTurn: () => Promise.resolve(turns[call++]),
    system: "s", userContent: "q", tools: [],
    executeTool: () => Promise.resolve(""),
    clientTools: ["get_pack"], maxGetPack: 3, turnsPerCall: 8,
    resume: {
      messages: [{ role: "user", content: "q" }], turn: 1, clientCalls: 0, getPackCalls: 3,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    } as never,
  }));
  assertEquals(events.some((e) => e.type === "get_pack"), false);
  assertEquals(events.at(-1)?.type, "done");
});

Deno.test("provider-løkka: get_pack-id saneres ved emisjon (id ≤100, [A-Za-z0-9:_-])", async () => {
  const events = await collect(runProviderAgenticStream({
    runTurn: () => Promise.resolve({
      text: "", toolUses: [{ id: "p1", name: "get_pack", input: { id: "../x!!" + "y".repeat(150) } }],
      searchNotes: [], stop: "tool_use" as const, usage: { inputTokens: 1, outputTokens: 1 },
    }),
    system: "s", userContent: "q", tools: [],
    executeTool: () => Promise.reject(new Error("skal ikke kalles")),
    clientTools: ["get_pack"], turnsPerCall: 8,
  }));
  const gp = events.find((e) => e.type === "get_pack");
  assert(gp?.id);
  assert(/^[A-Za-z0-9:_-]*$/.test(String(gp?.id)));
  assert(String(gp?.id).length <= 100);
  const st = events.find((e) => e.type === "continue")?.state as { pending?: Record<string, unknown> };
  assertEquals(st.pending?.expectedId, gp?.id);
});

Deno.test("provider-løkka: resume med tomt getPackResult.text fletter en markørstreng, ikke en tom content-blokk", async () => {
  const turns = [
    { text: "", toolUses: [{ id: "p1", name: "get_pack", input: { id: "ukjent" } }], searchNotes: [], stop: "tool_use" as const, usage: { inputTokens: 1, outputTokens: 1 } },
    { text: "Ferdig", toolUses: [], searchNotes: [], stop: "end" as const, usage: { inputTokens: 1, outputTokens: 1 } },
  ];
  let call = 0;
  const ev1 = await collect(runProviderAgenticStream({
    runTurn: () => Promise.resolve(turns[call++]),
    system: "s", userContent: "q", tools: [],
    executeTool: () => Promise.resolve(""),
    clientTools: ["get_pack"], turnsPerCall: 8,
  }));
  const st = ev1.find((e) => e.type === "continue")?.state as never;
  // Fang siste tool_result FØR den forsvinner inn i neste tur (state.messages
  // ved starten av resume-turen har allerede fletten inn — se runTurn under).
  let seenContent = "";
  const ev2 = await collect(runProviderAgenticStream({
    runTurn: (state) => {
      const lastUser = state.messages.at(-1) as { role: string; content: { content: string }[] };
      if (lastUser?.role === "user") seenContent = lastUser.content[0]?.content ?? "";
      return Promise.resolve(turns[call++]);
    },
    system: "s", userContent: "q", tools: [],
    executeTool: () => Promise.resolve(""),
    clientTools: ["get_pack"], turnsPerCall: 8,
    resume: st, getPackResult: { id: "ukjent", text: "" },
  }));
  assertEquals(ev2.at(-1)?.type, "done");
  assert(seenContent.length > 0); // ALDRI en tom content-streng
  assert(seenContent.includes("fant ikke pakken"));
});

Deno.test("løkka: veggklokke-fristen yielder continue etter påbegynt tur (aldri 0 turer)", async () => {
  let kjorte = 0;
  const events = await collect(runProviderAgenticStream({
    runTurn: () => {
      kjorte++;
      return Promise.resolve({
        text: "", toolUses: [{ id: "c" + kjorte, name: "probe", input: {} }],
        searchNotes: [], stop: "tool_use", usage: { inputTokens: 1, outputTokens: 1 },
      } as ProviderTurnResult);
    },
    system: "SYS", userContent: "Q?", tools: [],
    executeTool: () => Promise.resolve("ok"),
    turnsPerCall: 8,
    veggklokkeMs: 0,          // fristen er alt passert ved tur 2-sjekken
  }));
  assertEquals(kjorte, 1);    // minst én tur kjøres alltid — aldri null-fremdrift
  const cont = events.find((e) => e.type === "continue") as Record<string, unknown>;
  if (!cont) throw new Error("mangler continue: " + JSON.stringify(events));
  assertEquals((cont.state as { turn: number }).turn, 1);
});
