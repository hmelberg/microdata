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
    // Kommentarer og strenger som nevner «Deno» er greit; kall er ikke.
    if (/\bDeno\.(env|readTextFile|writeTextFile)\b/.test(src)) treff.push(f);
  }
  assertEquals(treff, []);
});
