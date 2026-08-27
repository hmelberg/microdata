// _lib/svar-instruks.ts — systeminstruksen for /api/svar (samlet pipeline,
// spec 2026-08-28): kode-svar-prefiksen (regler + katalog + referanser, per
// modus) + løkke-regler for run_code/variabel_info + det syntetiske premisset
// + svarformatet. Løkke-reglene er tilpasset fra askstats svar-prompt.ts §RUN
// (komplett-første-kjøring, budsjett som reparasjonsreserve, mekanikk-noten
// speiler run-disiplin.ts) — men uten OUTPUTS-plassholderne: microdatas
// kjøringer gir tekst-output, og scriptet ligger synlig i editoren.

import { buildCachedPrefix, type GenMode } from "./prefiks.ts";

export const RUN_CODE_TOOL = {
  name: "run_code",
  description:
    "Kjør et komplett script i brukerens emulator-miljø (microdata-DSL, python eller r — modusblokken sier hvilket). Returnerer kjøringens tekst-output og eventuell feilmelding. Kall med HELE scriptet; rett og kall igjen ved feil (innenfor kjørebudsjettet).",
  input_schema: {
    type: "object",
    properties: { script: { type: "string", description: "hele scriptet, klart til kjøring" } },
    required: ["script"],
  },
};

export const VARIABEL_INFO_TOOL = {
  name: "variabel_info",
  description:
    "Slå opp detaljer for registervariabler: full beskrivelse, type, gyldighetsperiode og kodeliste. Kall med eksakt variabelnavn, eller et søkeord for å finne kandidater.",
  input_schema: {
    type: "object",
    properties: { navn: { type: "string", description: "variabelnavn eller søkeord" } },
    required: ["navn"],
  },
};

export type SvarKvalitet = "fast" | "balanced" | "best";

/** Kvalitetsvelgeren styrer BÅDE modell/effort (llm-choice) og løkkebudsjett
 *  (spec §3): én meny, ett «hvor grundig»-begrep. Balansert = askstats
 *  felt-testede deep-tall. */
export function svarBudsjett(q: SvarKvalitet): { clientCalls: number; runCalls: number } {
  switch (q) {
    case "fast": return { clientCalls: 8, runCalls: 3 };
    case "best": return { clientCalls: 20, runCalls: 6 };
    default: return { clientCalls: 12, runCalls: 4 };
  }
}

/** Markdown-vern (COPIED-mønster fra askstats svar-prompt.ts): injisert
 *  brukertekst kan inneholde egne overskrifter — demoter dem to nivåer
 *  (tak 6) så de aldri «avslutter» promptens egne ##-seksjoner. */
export function demoteHeadings(s: string): string {
  return s.replace(/^(#{1,6})(\s)/gm, (_m, h: string, sp: string) =>
    "#".repeat(Math.min(6, h.length + 2)) + sp);
}

/** 4000: egne instruksjoner er regler, ikke dokumentasjon (askstat bruker
 *  8000 fordi profil-tekster rommer datasettdokumentasjon — det gjør ikke
 *  microdatas). Klient-cap i ai-chat.js skal være samme 4000. */
export function coerceUserInstructions(p: unknown): string {
  return typeof p === "string" ? p.trim().slice(0, 4000) : "";
}

const LOKKE_INSTRUKS = `\
## Kjøring og sluttsvar (run_code)

Du har verktøyet run_code: det kjører ETT komplett script i brukerens
emulator og returnerer kjøringens tekst-output og eventuell feilmelding
(suksess starter med «OK.», feil med «FEIL:»). Arbeidsmåte:

1. Trenger du variabeldetaljer eller kodelister underveis: bruk
   variabel_info. IKKE gjett koder.
2. Skriv HELE scriptet og kall run_code med det. ALDRI legg scriptet som
   kodeblokk i svarteksten i stedet for å kalle run_code — scriptet settes
   automatisk inn i brukerens editor når det kjøres.
   FØRSTE kjøring skal være KOMPLETT: import + tilrettelegging + analyse i
   ETT script. Kjørebudsjettet er en REPARASJONSRESERVE, ikke en
   arbeidsplan — planlegg som om kjøring 1 er den eneste du får.
   Variabler overlever IKKE mellom kjøringer — hver kjøring er et
   frittstående script.
   MEKANIKK (håndheves av kjøretiden): etter din FØRSTE vellykkede kjøring
   får du en påminnelse om å levere svaret; etter din ANDRE vellykkede
   kjøring stenges run_code for resten av løpet. Planlegg deretter.
3. Les outputen. Feil, eller output som ikke besvarer spørsmålet → rett
   scriptet og kall run_code igjen (innenfor kjørebudsjettet). Feiler også
   ANDRE reparasjonsforsøk på samme tilnærming: ikke lapp videre — velg en
   enklere tilnærming eller lever ærlig degradering.
4. Når outputen besvarer spørsmålet: skriv SLUTTSVARET som ren markdown.
   Ikke gjenta hele scriptet (det ligger i editoren) og ikke gjengi hele
   utskriften — pek på og TOLK tallene som bærer svaret.`;

const SYNTETISK_PREMISS = `\
## Syntetiske øvingsdata — innramming av alle tall

Emulatoren kjører på syntetiske øvingsdata, ikke ekte registerdata.
METODEN og tolkningsmåten er poenget: vis hvordan man gjør analysen på
microdata.no og hvordan utskriften leses. Tall fra kjøringene er
illustrasjon og skal aldri presenteres som faktisk statistikk — si
eksplisitt i svaret at tallene er syntetiske der du omtaler dem.`;

const SVARFORMAT = `\
## Svarformat

- Kort svar på spørsmålet først (med syntetisk-forbeholdet der tall inngår).
- Deretter «Slik leser du utskriften»: pek på de bærende tallene/radene i
  kjøringens output og forklar dem.
- Til slutt «Vurderinger og forslag»: mekanisme-kandidater bak mønsteret,
  forbehold (konfundering, seleksjon, målefeil), og forslag til videre
  analyser med relevante registervariabler.
- Rene forklaringsspørsmål (ingen kjøring nødvendig): svar direkte, uten
  seksjonene over.`;

export interface SvarSystemDeps {
  /** Test-injeksjon: hopp over buildCachedPrefix. */
  prefix?: string;
  /** Brukerens egne instruksjoner (rå tekst fra klienten). */
  userInstructions?: string;
}

export async function buildSvarSystem(
  origin: string,
  mode: GenMode,
  deps: SvarSystemDeps = {},
): Promise<string> {
  const prefix = deps.prefix ?? await buildCachedPrefix(origin, mode);
  const blocks = [prefix, LOKKE_INSTRUKS, SYNTETISK_PREMISS, SVARFORMAT];
  const egne = coerceUserInstructions(deps.userInstructions);
  if (egne) {
    blocks.push(
      "## Brukerens egne instruksjoner\n\n" +
        "Følg disse så langt de ikke strider mot reglene over:\n\n" +
        demoteHeadings(egne),
    );
  }
  return blocks.join("\n\n");
}

export function questionTurn(question: string, script?: string): string {
  return [
    "# Brukerforespørsel",
    script?.trim()
      ? `**Gjeldende script i editor (kontekst):**\n\`\`\`\n${script.trim()}\n\`\`\``
      : "",
    `**Spørsmål:** ${question}`,
  ].filter(Boolean).join("\n\n");
}

export function progressLabel(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "run_code": return "▶ Kjører scriptet …";
    case "variabel_info": return `Slår opp ${String(input.navn ?? "").slice(0, 60)} …`;
    default: return `Kjører ${name} …`;
  }
}
