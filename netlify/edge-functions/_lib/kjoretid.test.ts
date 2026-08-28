import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Modulene bakgrunnsfunksjonen (Node) importerer, direkte eller transitivt.
// Ingen av dem får inneholde URL-importer eller Deno-globaler.
const NODE_TRYGGE = [
  "anthropic.ts", "auth.ts", "llm-choice.ts", "rate-limit.ts",
  "feiljournal.ts", "run-disiplin.ts", "svar-instruks.ts", "prefiks.ts",
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
