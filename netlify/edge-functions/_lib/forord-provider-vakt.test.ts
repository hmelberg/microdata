import { assertMatch, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

// _lib/forord-provider-vakt.test.ts — leser KILDETEKSTEN til svar-jobb.mts og
// sjekker at forord-kallet fortsatt er portet mot `!choice.provider`. Samme
// knep som kjoretid.test.ts: filen er .mts og bor i netlify/functions/,
// altså UTENFOR alt som ellers kjører i dette repoet. `deno check`/`deno
// test` leser bare *.ts (Deno-syntaks); `node --test "tests/js/*.test.js"`
// treffer bare tests/js/ og ville uansett ikke kjørt en Netlify Background
// Function; ingen type-sjekker i repoet leser filen. Uten DENNE testen er
// `!choice.provider`-leddet den ENESTE sikkerhetsegenskapen i hele
// background-transport-planen med null dekning noe sted.
//
// HVA SOM LEKKER OM LEDDET FORSVINNER: med en egendefinert leverandør
// konfigurert er choice.apiKey brukerens FREMMEDE nøkkel
// (llm-choice.ts:155, `apiKey = provider?.key ?? byokKey ?? serverKey`) —
// ikke en Anthropic-nøkkel. messageAnthropic uten apiBase går til den ekte
// api.anthropic.com (anthropic.ts:39-41, apiTarget(undefined)). Et
// Grundig-forord på den veien ville dermed sendt brukerens hemmelige
// leverandørnøkkel til en vert brukeren aldri har valgt. Funnet og fikset i
// en re-review av Task 9 (se task-9-report.md, «Finding 1»). IKKE slett
// denne testen fordi den er brittle mot omskriving — gjør den heller
// robust, eller spør noen. Den som trigger den, skal forstå HVORFOR fra
// denne kommentaren alene, uten å måtte lete opp task-9-reviewen.

const KILDE = await Deno.readTextFile(
  new URL("../../functions/svar-jobb.mts", import.meta.url),
);

Deno.test("forord-kallet i svar-jobb.mts er fortsatt portet mot !choice.provider", () => {
  const kallIndeks = KILDE.indexOf("skrivForord(");
  if (kallIndeks === -1) {
    throw new Error(
      "Fant ingen skrivForord(...)-kall i svar-jobb.mts. Flyttet eller " +
        "omdøpt? Denne vakten må FØLGE kallstedet, ikke slettes.",
    );
  }
  // Vinduet foran kallet er stort nok til å romme hele if-betingelsen (og
  // god margin), men lite nok til at nærmeste `if (` i vinduet garantert ER
  // porten foran skrivForord — verifisert manuelt: neste `if (` lenger opp i
  // filen ligger >1300 tegn unna kallet, mens porten selv ligger ~70 tegn
  // unna.
  const vindu = KILDE.slice(Math.max(0, kallIndeks - 400), kallIndeks);
  const ifIndeks = vindu.lastIndexOf("if (");
  if (ifIndeks === -1) {
    throw new Error(
      "Fant ingen if(...)-port i de 400 tegnene foran skrivForord(...) — " +
        "forordet ser ut til å kalles UBETINGET nå. Det ville sendt et " +
        "Haiku-kall (og dermed choice.apiKey) på HVER tur, uansett " +
        "leverandør eller resume-status.",
    );
  }
  const betingelse = vindu.slice(ifIndeks);

  // Sanity: er dette faktisk SAMME if som før (effort + resumeState), ikke
  // en annen if vinduet tilfeldigvis fanget opp?
  assertStringIncludes(
    betingelse,
    "choice.effort",
    "Fant en if rett før skrivForord(...), men den nevner ikke " +
      "choice.effort — sannsynligvis feil if fanget opp av vinduet.",
  );
  assertStringIncludes(
    betingelse,
    "body.resumeState",
    "Fant en if rett før skrivForord(...), men den nevner ikke " +
      "body.resumeState — sannsynligvis feil if fanget opp av vinduet.",
  );

  // DEN faktiske vakten. \s* tåler linjeskift/reformatering (deno fmt,
  // omordnede && ledd) uten å svekkes — den krever fortsatt et `!` RETT FØR
  // `choice.provider`, så et bytte til f.eks. `choice.provider === undefined`
  // ville (riktig nok) også slå ut. Det er en bevisst avveining: falske
  // positiver her koster fem minutter; et falskt negativ koster en lekket
  // nøkkel.
  assertMatch(
    betingelse,
    /!\s*choice\.provider/,
    "PORTEN MANGLER !choice.provider foran skrivForord(...) i svar-jobb.mts. " +
      "Med en egendefinert leverandør konfigurert sender dette brukerens " +
      "fremmede API-nøkkel (choice.apiKey) til den ekte api.anthropic.com " +
      "via et 'gratis' Haiku-forord. Se kommentaren øverst i denne " +
      "testfilen for hele kjeden (llm-choice.ts:155, anthropic.ts:39-41) — " +
      "gjeninnfør leddet, ikke slett testen.",
  );
});
