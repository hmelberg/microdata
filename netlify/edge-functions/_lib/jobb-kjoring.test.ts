import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type BlobbStore, chunkNokkel, headNokkel, lesChunks, lesHead } from "./jobb-blobb.ts";
import { kjorJobb } from "./jobb-kjoring.ts";

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

/** Manuelle timere: testen fyrer hjerteslaget selv og ser at det stoppes. */
function timere() {
  const aktive = new Map<number, () => void>();
  let neste = 1;
  return {
    aktive,
    settIntervall: (f: () => void, _ms: number) => { const id = neste++; aktive.set(id, f); return id; },
    stoppIntervall: (id: unknown) => { aktive.delete(id as number); },
    fyr: () => { for (const f of aktive.values()) f(); },
  };
}

const stille = () => {};
const alleChunks = async (store: BlobbStore, jobId: string) => {
  const h = await lesHead(store, jobId);
  return (await lesChunks(store, jobId, 0, h?.seq ?? 0)).join("");
};

Deno.test("kjorJobb: normalt løp skriver, avslutter og stopper hjerteslaget", async () => {
  const { store } = fakeStore();
  const t = timere();
  const utfall = await kjorJobb({
    store, jobId: "j1", now: () => 1000, logg: stille, ...t,
    arbeid: async (s) => {
      assertEquals(t.aktive.size, 1);          // hjerteslag går mens arbeidet pågår
      await s.skriv('data: {"type":"done"}\n\n');
      await s.avslutt("ferdig");
    },
  });
  assertEquals(utfall, "kjort");
  assertEquals((await lesHead(store, "j1"))?.state, "ferdig");
  assertEquals(t.aktive.size, 0);
});

Deno.test("kjorJobb: hjerteslaget stempler head med fersk oppdatert", async () => {
  const { store } = fakeStore();
  const t = timere();
  let na = 1000;
  await kjorJobb({
    store, jobId: "j1", now: () => na, logg: stille, ...t,
    arbeid: async (s) => {
      na = 90_000;
      t.fyr();
      await new Promise((r) => setTimeout(r, 0));
      assertEquals((await lesHead(store, "j1"))?.oppdatert, 90_000);
      await s.avslutt("ferdig");
    },
  });
});

Deno.test("kjorJobb: Netlify-retry med eksisterende head kjører IKKE arbeidet igjen", async () => {
  const { store, data } = fakeStore();
  await store.set(chunkNokkel("j1", 1), 'data: {"type":"delta","text":"første løp"}\n\n');
  await store.setJSON(headNokkel("j1"), { seq: 1, state: "kjorer", start: 0, oppdatert: 0 });
  let arbeidKalt = false;
  const utfall = await kjorJobb({
    store, jobId: "j1", now: () => 5000, logg: stille, ...timere(),
    arbeid: () => { arbeidKalt = true; return Promise.resolve(); },
  });
  assertEquals(utfall, "gjentatt");
  assertEquals(arbeidKalt, false);
  // Første løps chunk står urørt, og jobben er avsluttet med en ren feil.
  assertEquals(data.get(chunkNokkel("j1", 1)), 'data: {"type":"delta","text":"første løp"}\n\n');
  const head = await lesHead(store, "j1");
  assertEquals(head?.state, "feil");
  assertEquals(head?.seq, 2);
  assertStringIncludes(await alleChunks(store, "j1"), '"type":"error"');
});

Deno.test("kjorJobb: arbeid som kaster gir skrubbet feil-event + feil-state, aldri et kast", async () => {
  const { store } = fakeStore();
  const t = timere();
  const KEY = "sk-ant-hemmelig-999";
  const utfall = await kjorJobb({
    store, jobId: "j1", now: () => 1000, logg: stille, ...t,
    skrubb: (s) => s.split(KEY).join("***"),
    arbeid: () => Promise.reject(new Error(`oppstrøm sa ${KEY}`)),
  });
  assertEquals(utfall, "feilet");
  assertEquals((await lesHead(store, "j1"))?.state, "feil");
  const ut = await alleChunks(store, "j1");
  assertStringIncludes(ut, '"type":"error"');
  assertEquals(ut.includes(KEY), false);
  assertEquals(t.aktive.size, 0);
});

Deno.test("kjorJobb: feil i feilhåndteringen (Blobs nede) slipper heller ikke ut", async () => {
  const { store } = fakeStore();
  let kall = 0;
  const skjor: BlobbStore = {
    ...store,
    // Første head-skriving (start) går bra, alt etterpå feiler.
    setJSON: (k, v, o) => (kall++ === 0 ? store.setJSON(k, v, o) : Promise.reject(new Error("blobs nede"))),
    set: () => Promise.reject(new Error("blobs nede")),
  };
  const utfall = await kjorJobb({
    store: skjor, jobId: "j1", now: () => 1000, logg: stille, ...timere(),
    arbeid: () => Promise.reject(new Error("boom")),
  });
  assertEquals(utfall, "feilet");
});

Deno.test("kjorJobb: start() som feiler gir 'startfeil' uten kast og uten arbeid", async () => {
  const { store } = fakeStore();
  let arbeidKalt = false;
  const utfall = await kjorJobb({
    store: { ...store, setJSON: () => Promise.reject(new Error("blobs nede")) },
    jobId: "j1", now: () => 1000, logg: stille, ...timere(),
    arbeid: () => { arbeidKalt = true; return Promise.resolve(); },
  });
  assertEquals(utfall, "startfeil");
  assertEquals(arbeidKalt, false);
});

Deno.test("kjorJobb: retry der merkingen feiler slipper heller ikke ut", async () => {
  const { store } = fakeStore();
  await store.setJSON(headNokkel("j1"), { seq: 1, state: "kjorer", start: 0, oppdatert: 0 });
  const utfall = await kjorJobb({
    store: { ...store, set: () => Promise.reject(new Error("blobs nede")) },
    jobId: "j1", now: () => 1000, logg: stille, ...timere(),
    arbeid: () => Promise.resolve(),
  });
  assertEquals(utfall, "gjentatt");
});

Deno.test("kjorJobb: arbeid som returnerer uten avslutt lukkes som feil", async () => {
  const { store } = fakeStore();
  const utfall = await kjorJobb({
    store, jobId: "j1", now: () => 1000, logg: stille, ...timere(),
    arbeid: async (s) => { await s.skriv('data: {"type":"delta","text":"halvt"}\n\n'); },
  });
  assertEquals(utfall, "feilet");
  assertEquals((await lesHead(store, "j1"))?.state, "feil");
  assertStringIncludes(await alleChunks(store, "j1"), '"type":"error"');
});

Deno.test("kjorJobb: et hjerteslag som feiler svelges og stopper ikke løpet", async () => {
  const { store } = fakeStore();
  const t = timere();
  let headSkriv = 0;
  const ustabil: BlobbStore = {
    ...store,
    setJSON: (k, v, o) => (++headSkriv === 2 ? Promise.reject(new Error("blipp")) : store.setJSON(k, v, o)),
  };
  const utfall = await kjorJobb({
    store: ustabil, jobId: "j1", now: () => 1000, logg: stille, ...t,
    arbeid: async (s) => {
      t.fyr();                                  // hjerteslag nr. 1 feiler (head-skriving nr. 2)
      await new Promise((r) => setTimeout(r, 0));
      await s.skriv('data: {"type":"done"}\n\n');
      await s.avslutt("ferdig");
    },
  });
  assertEquals(utfall, "kjort");
  assertEquals((await lesHead(store, "j1"))?.state, "ferdig");
});
