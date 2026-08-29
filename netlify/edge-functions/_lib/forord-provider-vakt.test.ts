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
//
// REVIEWFUNN (Task 10, samme runde): den FØRSTE versjonen av denne testen
// matchet rå tekst i et vindu foran skrivForord(...) UTEN å bry seg om
// kommentar-syntaks. En reviewer viste at å kommentere bort selve if-linja
//   // if (choice.effort && !choice.provider && !body.resumeState) {
// — og la den bare gjenværende `}` stå igjen som en helt vanlig blokk —
// er gyldig TypeScript som kaller skrivForord UBETINGET, mens teksten
// "!choice.provider" fortsatt står ordrett i fila (inni kommentaren) og
// fikk testen til å bestå. Et falskt negativ, nøyaktig den kategorien denne
// testen finnes for å hindre. Fikset ved å fjerne kommentarer FØR søket
// (stripComments under) — se task-10-report.md for mutant-kjøringene (nå
// tre: slettet ledd, kommentert-bort if, og en dekk-streng med gate-teksten
// rett før et ellers ubetinget kall — alle tre feiler korrekt).
//
// GRENSE (funnet i samme runde, bevisst IKKE lukket): denne vakten er
// leksikalsk, ikke semantisk — den sjekker at riktig TEKST finnes i AKTIV
// kode, ikke at uttrykket faktisk EVALUERER riktig. En bevisst tautologi som
// `choice.effort && (true || !choice.provider) && !body.resumeState` består
// testen (teksten «!choice.provider» står der, hverken kommentert eller i en
// streng) mens porten reelt er kortsluttet bort av `true ||`. Å lukke DET
// krever ekte uttrykks-evaluering, ikke tekstsøk — i praksis en egen liten
// TypeScript-parser, langt utenfor hva en grep-vakt skal være. Bevisst
// ikke bygget: trusselmodellen denne testen dekker er GLIPP (kommentert bort
// under debugging, mistet i en refaktorering eller mergekonflikt) — samme
// kategori som de tre mutantene over — ikke en innsider som saboterer sin
// egen sikkerhetskode med en tautologi. Nevnt her i stedet for late som
// grensen ikke finnes.

// Fjerner linje- og blokk-kommentarer, OG blanker innholdet i strenger og
// malstrenger (se begrunnelse ved streng-grenen under — kort: en streng med
// skråstrek-skråstrek skal ikke feiltolkes som kommentarstart, og en streng
// som ordrett inneholder gate-teksten skal ikke kunne late som betingelsen
// gjelder). Kommentar- og streng-tegn erstattes med mellomrom ETT FOR ETT,
// så lengden — og dermed alle indekser denne testen regner ut etterpå — er
// uendret i forhold til originalteksten. Ikke en fullstendig JS-parser (den
// har ingen anelse om regex-literaler, f.eks.), men trenger bare å være
// korrekt for ÉN fil vi selv skriver, ikke for vilkårlig input.
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  type Tilstand = "kode" | "linje" | "blokk" | "'" | '"' | "`";
  let tilstand: Tilstand = "kode";
  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : "";
    if (tilstand === "kode") {
      if (c === "/" && c2 === "/") { tilstand = "linje"; out += "  "; i += 2; continue; }
      if (c === "/" && c2 === "*") { tilstand = "blokk"; out += "  "; i += 2; continue; }
      if (c === "'" || c === '"' || c === "`") { tilstand = c; out += c; i++; continue; }
      out += c;
      i++;
      continue;
    }
    if (tilstand === "linje") {
      if (c === "\n") { tilstand = "kode"; out += "\n"; i++; continue; }
      out += " ";
      i++;
      continue;
    }
    if (tilstand === "blokk") {
      if (c === "*" && c2 === "/") { tilstand = "kode"; out += "  "; i += 2; continue; }
      out += c === "\n" ? "\n" : " ";
      i++;
      continue;
    }
    // Inni en streng/malstreng: BLANK innholdet også (ikke bare
    // kommentarer). Ikke bare for "//" i en URL-streng — en streng som
    // ordrett inneholder teksten "!choice.provider" rett før et nå-
    // ubetinget kall ville ellers dukket opp som en tredje måte å lure
    // testen på, uten at betingelsen faktisk gjelder. Ekte kode har aldri
    // grunn til at selve gate-uttrykket står i en streng, så å blanke det
    // koster ingenting reelt og lukker hullet. Escapede anførselstegn
    // (\" \' \`) blankes parvis så de ikke lukker strengen for tidlig.
    if (c === "\\" && c2 !== "") { out += "  "; i += 2; continue; }
    if (c === tilstand) { tilstand = "kode"; out += c; i++; continue; }
    out += c === "\n" ? "\n" : " ";
    i++;
  }
  return out;
}

const KILDE_RAW = await Deno.readTextFile(
  new URL("../../functions/svar-jobb.mts", import.meta.url),
);
const KILDE = stripComments(KILDE_RAW);

Deno.test("forord-kallet i svar-jobb.mts er fortsatt portet mot !choice.provider", () => {
  const kallIndeks = KILDE.indexOf("skrivForord(");
  if (kallIndeks === -1) {
    throw new Error(
      "Fant ingen AKTIV skrivForord(...)-kall i svar-jobb.mts (kommentarer " +
        "er fjernet før dette søket). Enten er kallet flyttet/omdøpt, eller " +
        "kommentert bort. Denne vakten må FØLGE kallstedet, ikke slettes.",
    );
  }
  // Vinduet foran kallet er stort nok til å romme hele if-betingelsen (og
  // god margin), men lite nok til at nærmeste `if (` i vinduet garantert ER
  // porten foran skrivForord — verifisert manuelt: neste `if (` lenger opp i
  // filen ligger >1300 tegn unna kallet, mens porten selv ligger ~70 tegn
  // unna. stripComments bevarer lengden 1:1, så disse avstandene gjelder
  // uendret i den kommentar-fjernede teksten.
  const vindu = KILDE.slice(Math.max(0, kallIndeks - 400), kallIndeks);
  const ifIndeks = vindu.lastIndexOf("if (");
  if (ifIndeks === -1) {
    throw new Error(
      "Fant ingen AKTIV if(...)-port i de 400 tegnene foran skrivForord(...) " +
        "(kommentarer er fjernet før dette søket) — forordet ser ut til å " +
        "kalles UBETINGET nå, enten fordi porten mangler eller fordi hele " +
        "if-linja er kommentert bort med den lukkende } stående igjen som en " +
        "vanlig blokk. Det ville sendt et Haiku-kall (og dermed " +
        "choice.apiKey) på HVER tur, uansett leverandør eller resume-status.",
    );
  }
  const betingelse = vindu.slice(ifIndeks);

  // Sanity: er dette faktisk SAMME if som før (effort + resumeState), ikke
  // en annen if vinduet tilfeldigvis fanget opp?
  assertStringIncludes(
    betingelse,
    "choice.effort",
    "Fant en AKTIV if rett før skrivForord(...), men den nevner ikke " +
      "choice.effort — sannsynligvis feil if fanget opp av vinduet.",
  );
  assertStringIncludes(
    betingelse,
    "body.resumeState",
    "Fant en AKTIV if rett før skrivForord(...), men den nevner ikke " +
      "body.resumeState — sannsynligvis feil if fanget opp av vinduet.",
  );

  // DEN faktiske vakten. \s* tåler linjeskift/reformatering (deno fmt,
  // omordnede && ledd) uten å svekkes — den krever fortsatt et `!` RETT FØR
  // `choice.provider`, så et bytte til f.eks. `choice.provider === undefined`
  // ville (riktig nok) også slå ut. Det er en bevisst avveining: falske
  // positiver her koster fem minutter; et falskt negativ koster en lekket
  // nøkkel. Fordi betingelse kommer fra KILDE (kommentar-fjernet), holder
  // ikke lenger et `!choice.provider` som bare STÅR i en kommentar — se
  // reviewfunnet øverst i fila.
  assertMatch(
    betingelse,
    /!\s*choice\.provider/,
    "PORTEN MANGLER en AKTIV !choice.provider foran skrivForord(...) i " +
      "svar-jobb.mts (kommentarer er fjernet før dette søket, så det holder " +
      "IKKE at teksten står i en kommentar). Med en egendefinert leverandør " +
      "konfigurert sender dette brukerens fremmede API-nøkkel (choice.apiKey) " +
      "til den ekte api.anthropic.com via et 'gratis' Haiku-forord. Se " +
      "kommentaren øverst i denne testfilen for hele kjeden " +
      "(llm-choice.ts:155, anthropic.ts:39-41) — gjeninnfør leddet som EKTE " +
      "kode, ikke slett testen.",
  );
});
