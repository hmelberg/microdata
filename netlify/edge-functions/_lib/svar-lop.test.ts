import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { byggLop, nyHopSamler, oppslagFraProgress } from "./svar-lop.ts";
import { progressLabel } from "./svar-instruks.ts";

Deno.test("prefiks-feil gir 502 som Response, ikke en kastet feil", async () => {
  const ut = await byggLop({
    origin: "https://eksempel.invalid",
    question: "hei", mode: "microdata",
    choice: { apiKey: "sk-ant-test", model: "claude-sonnet-5" },
    erPersonlig: false, byokKey: null, runOkCalls: 0, kvalitet: "balanced",
    journalHendelse: () => {}, turnDeadlineMs: 50_000,
    buildSystem: () => { throw new Error("prefiks nede"); },
  });
  assertEquals(ut instanceof Response, true);
  assertEquals((ut as Response).status, 502);
});

// ── Feiljournalens «svar»-hendelse (2026-08-29) ──────────────────────────
// Journalen fanget før bare spørsmål og eksplisitte feil. Da en spørring hang
// fordi løkka meldte en max_tokens-avkortet tur som `done`, så journalen to
// identiske spørsmål og ingenting galt — svikten var usynlig for den av samme
// grunn som for brukeren. Disse feltene fanger hva modellen FAKTISK gjorde.

Deno.test("oppslagFraProgress er bundet til progressLabels EKTE utdata, ikke til en håndskrevet streng", () => {
  // Poenget: etiketten bygges i svar-instruks.ts. Endres formen der, skal
  // DENNE testen ryke — ikke oppslagsfangsten stille i produksjon.
  const ekte = progressLabel("variabel_info", { navn: "INNTEKT_WLONN" });
  assertEquals(oppslagFraProgress(ekte), "INNTEKT_WLONN");
});

Deno.test("oppslagFraProgress ignorerer progress-linjer som ikke er oppslag", () => {
  assertEquals(oppslagFraProgress(progressLabel("run_code", {})), null);
  assertEquals(oppslagFraProgress("🧠 Tolker spørsmålet og planlegger …"), null);
  assertEquals(oppslagFraProgress(""), null);
});

Deno.test("nyHopSamler starter tom — ingen arvet tilstand mellom hopp", () => {
  const a = nyHopSamler();
  a.tekst = "x";
  a.oppslag.push("y");
  const b = nyHopSamler();
  assertEquals(b.tekst, "");
  assertEquals(b.oppslag, []);
});
