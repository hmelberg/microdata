import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  chunkNokkel, headNokkel, lagSkriver, lesChunks, lesHead, slettJobb,
  type BlobbStore,
} from "./jobb-blobb.ts";

/** Falsk store som HUSKER rekkefølgen skrivingene kom i. */
function fakeStore() {
  const data = new Map<string, string>();
  const rekkefolge: string[] = [];
  const store: BlobbStore = {
    get: (k, opts) => {
      const v = data.get(k);
      if (v === undefined) return Promise.resolve(null);
      return Promise.resolve(opts?.type === "json" ? JSON.parse(v) : v);
    },
    set: (k, v) => { data.set(k, v); rekkefolge.push(k); return Promise.resolve(); },
    setJSON: (k, v) => { data.set(k, JSON.stringify(v)); rekkefolge.push(k); return Promise.resolve(); },
    delete: (k) => { data.delete(k); return Promise.resolve(); },
    list: (o) => Promise.resolve({
      blobs: [...data.keys()].filter((k) => k.startsWith(o.prefix)).map((key) => ({ key })),
    }),
  };
  return { store, data, rekkefolge };
}

Deno.test("nøklene er sorterbare og nullpolstret", () => {
  assertEquals(chunkNokkel("abc", 1), "abc/000001");
  assertEquals(chunkNokkel("abc", 42), "abc/000042");
  assertEquals(headNokkel("abc"), "abc/head");
});

Deno.test("chunk skrives FØR head — invarianten leseren hviler på", async () => {
  const { store, rekkefolge } = fakeStore();
  const s = lagSkriver(store, "j1", () => 1000);
  await s.skriv('data: {"type":"done"}\n\n');   // kontroll-event tvinger flush
  assertEquals(rekkefolge, ["j1/000001", "j1/head"]);
});

Deno.test("vanlige deltaer buffres til 150 ms har gått", async () => {
  const { store, rekkefolge } = fakeStore();
  let na = 1000;
  const s = lagSkriver(store, "j1", () => na);
  await s.skriv('data: {"type":"delta","text":"a"}\n\n');
  await s.skriv('data: {"type":"delta","text":"b"}\n\n');
  assertEquals(rekkefolge, []);                      // ingenting flushet ennå
  na = 1200;
  await s.skriv('data: {"type":"delta","text":"c"}\n\n');
  assertEquals(rekkefolge, ["j1/000001", "j1/head"]);
  assertEquals(await store.get("j1/000001"),
    'data: {"type":"delta","text":"a"}\n\ndata: {"type":"delta","text":"b"}\n\ndata: {"type":"delta","text":"c"}\n\n');
});

Deno.test("kontroll-events flushes umiddelbart", async () => {
  for (const t of ["run_code", "continue", "done", "error"]) {
    const { store, rekkefolge } = fakeStore();
    const s = lagSkriver(store, "j1", () => 1000);
    await s.skriv(`data: {"type":"${t}"}\n\n`);
    assertEquals(rekkefolge.length, 2, `${t} skulle flushet straks`);
  }
});

Deno.test("avslutt flusher resten og setter slutt-tilstanden", async () => {
  const { store } = fakeStore();
  const s = lagSkriver(store, "j1", () => 1000);
  await s.skriv('data: {"type":"delta","text":"hei"}\n\n');
  await s.avslutt("ferdig");
  const head = await lesHead(store, "j1");
  assertEquals(head, { seq: 1, state: "ferdig", start: 1000 });
});

Deno.test("avslutt uten buffret innhold lager ingen tom chunk", async () => {
  const { store, rekkefolge } = fakeStore();
  const s = lagSkriver(store, "j1", () => 1000);
  await s.avslutt("feil");
  assertEquals(rekkefolge, ["j1/head"]);
  assertEquals((await lesHead(store, "j1"))?.seq, 0);
});

Deno.test("lesHead gir null for ukjent jobb", async () => {
  const { store } = fakeStore();
  assertEquals(await lesHead(store, "finnes-ikke"), null);
});

Deno.test("lesChunks henter halvåpent intervall (fra, til]", async () => {
  const { store } = fakeStore();
  let na = 0;
  const s = lagSkriver(store, "j1", () => (na += 1000));
  await s.skriv('data: {"type":"delta","text":"en"}\n\n');
  await s.skriv('data: {"type":"delta","text":"to"}\n\n');
  await s.skriv('data: {"type":"delta","text":"tre"}\n\n');
  assertEquals(await lesChunks(store, "j1", 0, 3), [
    'data: {"type":"delta","text":"en"}\n\n',
    'data: {"type":"delta","text":"to"}\n\n',
    'data: {"type":"delta","text":"tre"}\n\n',
  ]);
  // Gjenopptak fra markør 1 hopper over det klienten alt har sett.
  assertEquals(await lesChunks(store, "j1", 1, 3), [
    'data: {"type":"delta","text":"to"}\n\n',
    'data: {"type":"delta","text":"tre"}\n\n',
  ]);
});

Deno.test("slettJobb fjerner både chunks og head", async () => {
  const { store, data } = fakeStore();
  const s = lagSkriver(store, "j1", () => 1000);
  await s.skriv('data: {"type":"done"}\n\n');
  await slettJobb(store, "j1");
  assertEquals([...data.keys()], []);
});
