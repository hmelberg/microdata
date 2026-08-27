// COPIED fra askstat/netlify/edge-functions/_lib/run-disiplin.ts — ikke re-style.
// Run-disiplin (spec 2026-08-04-lokke-niva-design.md): rene funksjoner for
// svar-klart-stopp. Kryss-lag-kontrakt: klientens run_code-armen i js/ai-chat.js (runSvar) formatterer 'OK. OUTPUT (truncated):\n…' / 'FEIL:\n…' —
// klassifisereren er KONSERVATIV (alt uten OK.-prefiks er feil; en mistet
// suksess gir bare mildere oppførsel, aldri falsk stopp).

export const PAAMINNELSE =
  "[PÅMINNELSE fra kjøretiden: outputen over foreligger — skriv " +
  "sluttsvaret nå. Ny run_code-kjøring KUN hvis outputen faktisk ikke " +
  "besvarer spørsmålet; etter neste vellykkede kjøring stenges run_code.]";

export function klassifiserRunResult(s: string | undefined): "ok" | "feil" {
  return typeof s === "string" && s.startsWith("OK.") ? "ok" : "feil";
}

export function coerceRunOkCalls(u: unknown): number {
  return typeof u === "number" && Number.isInteger(u) && u >= 0 && u <= 50 ? u : 0;
}

export function skalStengeRunCode(runOkCalls: number): boolean {
  return runOkCalls >= 2;
}

export function medPaaminnelse(runResult: string): string {
  return runResult + "\n\n" + PAAMINNELSE;
}

export function filtrerRunCode(tools: unknown[], runOkCalls: number): unknown[] {
  if (!skalStengeRunCode(runOkCalls)) return tools;
  const filtrert = tools.filter((t) => (t as { name?: string }).name !== "run_code");
  // beregning-ruten har KUN run_code i verktøylista (buildRouteToolDefs) —
  // filtrering ville tømt den, og Anthropic-API-et avviser meldinger med
  // tool_use-blokker når `tools` er tom/mangler. Stengingsmekanismen hoppes
  // derfor STILLE over her (run_code blir stående); kjørebudsjettet
  // (depthRunCodeCalls) er fortsatt taket for feilende reparasjonsforsøk.
  return filtrert.length > 0 ? filtrert : tools;
}
