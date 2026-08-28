import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Modulene bakgrunnsfunksjonen (Node) importerer, direkte eller transitivt.
// Ingen av dem får inneholde URL-importer eller Deno-globaler.
//
// De siste ti (providers/*, tools/variabel-info.ts, ssrf.ts, svar-lop.ts,
// jobb-blobb.ts, catalog-format.ts, sse-frames.ts) ble lagt til i Task 5
// (2026-08-29): Task 4-reviewen verifiserte de første åtte for hånd som
// kjøretidsnøytrale; Task 5-reviewen fant at listen ikke dekket hele den
// transitive lukningen (catalog-format.ts via prefiks.ts, sse-frames.ts via
// anthropic.ts) og la til de to siste. Manuell verifisering holder bare til
// neste endring — vakten er det som gjør det varig (task-4-report-rulingen).
const NODE_TRYGGE = [
  "anthropic.ts", "auth.ts", "llm-choice.ts", "rate-limit.ts",
  "feiljournal.ts", "run-disiplin.ts", "svar-instruks.ts", "prefiks.ts",
  "providers/agentic.ts", "providers/openai-compat.ts",
  "providers/openai-responses.ts", "providers/config.ts",
  "tools/variabel-info.ts", "ssrf.ts", "svar-lop.ts", "jobb-blobb.ts",
  "catalog-format.ts", "sse-frames.ts",
];

Deno.test("Node-trygge moduler har ingen URL-importer", async () => {
  const treff: string[] = [];
  for (const f of NODE_TRYGGE) {
    const src = await Deno.readTextFile(new URL(f, import.meta.url));
    if (/from\s+"https:\/\//.test(src)) treff.push(f);
  }
  assertEquals(treff, []);
});

Deno.test("Node-trygge moduler rører ikke Deno-globalen", async () => {
  const treff: string[] = [];
  for (const f of NODE_TRYGGE) {
    const src = await Deno.readTextFile(new URL(f, import.meta.url));
    // Regelen er absolutt: INGEN Deno.*-tilgang i disse filene, ikke bare de
    // tre API-ene som var kjent da denne testen ble skrevet. En smalere regex
    // (f.eks. kun env/readTextFile/writeTextFile) ville sluppet gjennom
    // Deno.serve, Deno.exit, Deno.cwd, Deno.readFile osv. — reell risiko for
    // en fil som ellers ser Node-trygg ut. (Kommentert 2026-08-29 etter
    // review-funn: regexen var for smal, brifen tok feil, ikke reviewen.)
    if (/\bDeno\.\w+/.test(src)) treff.push(f);
  }
  assertEquals(treff, []);
});
