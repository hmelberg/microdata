import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { journalfor, lagNokkel } from "./feiljournal.ts";

Deno.test("lagNokkel: dags-prefiks + sorterbar tid + suffiks", () => {
  const n = lagNokkel(new Date("2026-08-28T21:05:03.123Z"), "ab12");
  assertEquals(n, "2026-08-28/210503-123-ab12");
});

Deno.test("journalfor: skriver cappet JSON-post med egen nøkkel per hendelse", async () => {
  const skrevet: { key: string; value: string }[] = [];
  const store = { set: (key: string, value: string) => { skrevet.push({ key, value }); return Promise.resolve(); } };
  await journalfor(store, {
    type: "run_feil",
    sporsmal: "s".repeat(500),
    detalj: "d".repeat(900),
    mode: "microdata",
    quality: "balanced",
  }, new Date("2026-08-28T21:05:03.123Z"), "xy99");
  assertEquals(skrevet.length, 1);
  assertStringIncludes(skrevet[0].key, "2026-08-28/");
  const post = JSON.parse(skrevet[0].value);
  assertEquals(post.type, "run_feil");
  assertEquals(post.sporsmal.length, 300);   // cappet
  assertEquals(post.detalj.length, 400);     // cappet
  assertEquals(post.mode, "microdata");
  assert(post.tid.startsWith("2026-08-28T21:05:03"));
});

Deno.test("journalfor: feiler ÅPENT — en død store velter aldri svaret", async () => {
  const store = { set: () => Promise.reject(new Error("blobs nede")) };
  await journalfor(store, { type: "sporsmal", sporsmal: "x" });   // skal ikke kaste
  const storeSynk = { set: () => { throw new Error("synkron eksplosjon"); } };
  await journalfor(storeSynk, { type: "sporsmal", sporsmal: "x" });
});

Deno.test("svar-hendelsen bærer svar/script/oppslag/slutt/usage, med caps", async () => {
  let skrevet = "";
  const store = { set: (_k: string, v: string) => { skrevet = v; return Promise.resolve(); } };
  await journalfor(store, {
    type: "svar",
    sporsmal: "hva er effekten?",
    mode: "microdata",
    quality: "balanced",
    svar: "S".repeat(5000),
    script: "K".repeat(4000),
    oppslag: Array.from({ length: 30 }, (_, i) => `V${i}`),
    slutt: "done",
    usage: { inputTokens: 3500, outputTokens: 8192 },
  }, new Date("2026-08-29T09:23:21.777Z"), "test");
  const p = JSON.parse(skrevet);
  assertEquals(p.type, "svar");
  assertEquals(p.slutt, "done");
  assertEquals(p.usage.outputTokens, 8192);
  assertEquals(p.svar.length, 4000, "svar skal kappes på 4000");
  assertEquals(p.script.length, 3000, "script skal kappes på 3000");
  assertEquals(p.oppslag.length, 20, "oppslag skal kappes på 20");
});

Deno.test("de gamle hendelsene får ALDRI de nye feltene som tomme nøkler", async () => {
  // En sporsmal-post skal se ut nøyaktig som før — ellers vokser journalen med
  // støy, og eldre poster blir vanskeligere å lese ved siden av nye.
  let skrevet = "";
  const store = { set: (_k: string, v: string) => { skrevet = v; return Promise.resolve(); } };
  await journalfor(store, { type: "sporsmal", sporsmal: "q", mode: "microdata", quality: "fast" },
    new Date("2026-08-29T09:23:21.777Z"), "test");
  const p = JSON.parse(skrevet);
  assertEquals("svar" in p, false);
  assertEquals("script" in p, false);
  assertEquals("oppslag" in p, false);
  assertEquals("usage" in p, false);
});

Deno.test("svar-posten bærer sporring, varighet, modell og effort", async () => {
  let skrevet = "";
  const store = { set: (_k: string, v: string) => { skrevet = v; return Promise.resolve(); } };
  await journalfor(store, {
    type: "svar", sporsmal: "q", sporring: "abc-123",
    varighetMs: 41300, modell: "claude-opus-5", effort: "high",
    slutt: "done", usage: { outputTokens: 8192 },
  }, new Date("2026-08-29T09:23:21.777Z"), "test");
  const p = JSON.parse(skrevet);
  assertEquals(p.sporring, "abc-123");
  assertEquals(p.varighetMs, 41300);
  assertEquals(p.modell, "claude-opus-5");
  assertEquals(p.effort, "high");
});

Deno.test("sporring knytter hoppene i ETT spørsmål sammen på tvers av hendelsestyper", async () => {
  // Dette er hele poenget: et spørsmål gir én sporsmal-post, kanskje en
  // run_feil-post, og én svar-post per hopp. Uten felles id måtte de gjettes
  // sammen på tidsstempel + tekst — som ryker når samme spørsmål stilles to
  // ganger, altså nøyaktig når noe har hengt og brukeren prøvde igjen.
  const poster: string[] = [];
  const store = { set: (_k: string, v: string) => { poster.push(v); return Promise.resolve(); } };
  const id = "sporring-1";
  await journalfor(store, { type: "sporsmal", sporsmal: "q", sporring: id }, new Date(), "a");
  await journalfor(store, { type: "run_feil", sporsmal: "q", detalj: "FEIL: x", sporring: id }, new Date(), "b");
  await journalfor(store, { type: "svar", sporsmal: "q", sporring: id, slutt: "done" }, new Date(), "c");
  const ider = poster.map((p) => JSON.parse(p).sporring);
  assertEquals(ider, [id, id, id]);
  assertEquals(poster.map((p) => JSON.parse(p).type), ["sporsmal", "run_feil", "svar"]);
});
