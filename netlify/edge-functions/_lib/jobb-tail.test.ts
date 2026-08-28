import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { lagSkriver, type BlobbStore } from "./jobb-blobb.ts";
import { tailStream } from "./jobb-tail.ts";

function fakeStore() {
  const data = new Map<string, string>();
  const store: BlobbStore = {
    get: (k, opts) => {
      const v = data.get(k);
      if (v === undefined) return Promise.resolve(null);
      return Promise.resolve(opts?.type === "json" ? JSON.parse(v) : v);
    },
    set: (k, v) => { data.set(k, v); return Promise.resolve(); },
    setJSON: (k, v) => { data.set(k, JSON.stringify(v)); return Promise.resolve(); },
    delete: (k) => { data.delete(k); return Promise.resolve(); },
    list: (o) => Promise.resolve({
      blobs: [...data.keys()].filter((k) => k.startsWith(o.prefix)).map((key) => ({ key })),
    }),
  };
  return { store, data };
}

async function lesAlt(s: ReadableStream<Uint8Array>): Promise<string> {
  const dec = new TextDecoder();
  let ut = "";
  for await (const chunk of s) ut += dec.decode(chunk, { stream: true });
  return ut;
}

/** Klokke som rykker fram et fast antall ms for hvert sleep-kall. Feltene er
 * NØYAKTIG `now` og `sleep` slik at `...k` kan spres rett inn i TailOpts —
 * et ekstra felt her gir overflødig-felt-feil i `deno check`. */
function klokke(stegMs: number) {
  let na = 0;
  return {
    now: () => na,
    sleep: (_ms: number) => { na += stegMs; return Promise.resolve(); },
  };
}

Deno.test("dreneret ferdig jobb strømmes ut og lukkes", async () => {
  const { store } = fakeStore();
  const k = klokke(120);
  const s = lagSkriver(store, "j1", k.now);
  await s.skriv('data: {"type":"delta","text":"hei"}\n\n');
  await s.avslutt("ferdig");
  const ut = await lesAlt(tailStream({ store, jobId: "j1", fra: 0, ...k }));
  assertEquals(ut, 'data: {"type":"delta","text":"hei"}\n\n');
});

Deno.test("gjenopptak fra markør hopper over det klienten alt har sett", async () => {
  const { store } = fakeStore();
  const k = klokke(120);
  let na = 0;
  const s = lagSkriver(store, "j1", () => (na += 200));
  await s.skriv('data: {"type":"delta","text":"en"}\n\n');
  await s.skriv('data: {"type":"delta","text":"to"}\n\n');
  await s.avslutt("ferdig");
  const ut = await lesAlt(tailStream({ store, jobId: "j1", fra: 1, ...k }));
  assertEquals(ut, 'data: {"type":"delta","text":"to"}\n\n');
});

Deno.test("overlevering på frist emitterer tail med riktig markør", async () => {
  const { store } = fakeStore();
  let na = 0;
  const s = lagSkriver(store, "j1", () => (na += 200));
  await s.skriv('data: {"type":"delta","text":"en"}\n\n');
  // Jobben står fortsatt som «kjorer» — taileren må gi opp på fristen.
  const k = klokke(20_000);
  const ut = await lesAlt(tailStream({
    store, jobId: "j1", fra: 0, now: k.now, sleep: k.sleep, fristMs: 45_000,
  }));
  assertStringIncludes(ut, 'data: {"type":"delta","text":"en"}\n\n');
  assertStringIncludes(ut, '"type":"tail"');
  assertStringIncludes(ut, '"cursor":1');
  assertStringIncludes(ut, '"job":"j1"');
});

Deno.test("manglende head gir forklart feil etter ventetiden", async () => {
  const { store } = fakeStore();
  const k = klokke(3000);
  const ut = await lesAlt(tailStream({
    store, jobId: "finnes-ikke", fra: 0, now: k.now, sleep: k.sleep,
    ventPaaHeadMs: 10_000,
  }));
  assertStringIncludes(ut, '"type":"error"');
  assertStringIncludes(ut, "startet aldri");
});

Deno.test("ferdig jobb ryddes bort etter drenering", async () => {
  const { store, data } = fakeStore();
  const k = klokke(120);
  const s = lagSkriver(store, "j1", k.now);
  await s.skriv('data: {"type":"done"}\n\n');
  await s.avslutt("ferdig");
  await lesAlt(tailStream({ store, jobId: "j1", fra: 0, ...k }));
  assertEquals([...data.keys()], []);
});

Deno.test("overlevering rydder IKKE — jobben lever videre", async () => {
  const { store, data } = fakeStore();
  let na = 0;
  const s = lagSkriver(store, "j1", () => (na += 200));
  await s.skriv('data: {"type":"delta","text":"en"}\n\n');
  const k = klokke(20_000);
  await lesAlt(tailStream({
    store, jobId: "j1", fra: 0, now: k.now, sleep: k.sleep, fristMs: 45_000,
  }));
  assertEquals(data.has("j1/head"), true);
});
