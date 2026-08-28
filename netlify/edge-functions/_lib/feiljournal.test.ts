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
