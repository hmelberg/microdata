// _lib/feiljournal.ts — automatisk feiljournal for selvforbedringssløyfen
// (2026-08-28). Skrives KUN for kall autentisert med det PERSONLIGE
// tilgangspassordet (Hans' egen bruk — hans data, hans site); delt passord og
// BYOK journalføres aldri. Lagres i Netlify Blobs-storen «feiljournal» med
// ÉN nøkkel per hendelse (append-mønster: ingen read-modify-write, så
// eventual consistency er ufarlig her — i motsetning til rate-limit-telleren).
// Leses fra repoet med:  netlify blobs:list feiljournal  /  netlify blobs:get
// feiljournal <nøkkel>. Journalen er BEST-EFFORT: den feiler ÅPENT og får
// aldri velte et svar.

export interface JournalStore {
  set(key: string, value: string): Promise<void>;
}

export interface JournalHendelse {
  // "sporsmal" (nytt spørsmål), "run_feil" (kjøring klassifisert FEIL),
  // "feil" (error-event fra løkka — oppstrøms/plattform),
  // "svar" (ett hopp fullført — se feltene under).
  type: string;
  sporsmal?: string;
  detalj?: string;
  mode?: string;
  quality?: string;

  // ── «svar»-feltene (2026-08-29) ────────────────────────────────────────
  // Journalen fanget tidligere BARE spørsmål og eksplisitte feil. Det holdt
  // ikke: 2026-08-29 hang en spørring fordi løkka meldte en max_tokens-
  // avkortet tur som `done` — en svikt som PRESENTERTE seg som suksess var
  // dermed usynlig for journalen av nøyaktig samme grunn som den var usynlig
  // for brukeren. Journalen så to identiske spørsmål og ingenting galt.
  //
  // Med disse feltene fanges det som trengs for å forbedre prompt og kode:
  // hva modellen faktisk svarte, hvilket script den skrev, hvilke variabler
  // den slo opp (forankret den seg i katalogen, eller gjettet?), hvordan
  // hoppet endte, og forbruket — der `stopReason: max_tokens` med tomt svar
  // ville avslørt dagens feil på ett blikk.
  svar?: string;
  script?: string;
  oppslag?: string[];
  /** "done" | "continue" | "error" — hvordan hoppet endte. */
  slutt?: string;
  usage?: Record<string, number>;
}

const MAX_SPORSMAL = 300;
const MAX_DETALJ = 400;
// Svar og script kappes, men romslig: poenget er å kunne LESE hva modellen
// gjorde i ettertid, ikke bare at den gjorde noe.
const MAX_SVAR = 4000;
const MAX_SCRIPT = 3000;
const MAX_OPPSLAG = 20;

/** «ÅÅÅÅ-MM-DD/HHMMSS-mmm-<suffiks>» — dags-prefiks for list, sorterbar tid. */
export function lagNokkel(now: Date, suffiks: string): string {
  const iso = now.toISOString();               // 2026-08-28T21:05:03.123Z
  const dag = iso.slice(0, 10);
  const tid = iso.slice(11, 19).replace(/:/g, "") + "-" + iso.slice(20, 23);
  return `${dag}/${tid}-${suffiks}`;
}

export async function journalfor(
  store: JournalStore,
  h: JournalHendelse,
  now: Date = new Date(),
  suffiks: string = Math.random().toString(36).slice(2, 6),
): Promise<void> {
  try {
    const post = {
      tid: now.toISOString(),
      type: h.type,
      sporsmal: (h.sporsmal ?? "").slice(0, MAX_SPORSMAL),
      detalj: (h.detalj ?? "").slice(0, MAX_DETALJ) || undefined,
      mode: h.mode,
      quality: h.quality,
      svar: h.svar ? h.svar.slice(0, MAX_SVAR) : undefined,
      script: h.script ? h.script.slice(0, MAX_SCRIPT) : undefined,
      oppslag: h.oppslag?.length ? h.oppslag.slice(0, MAX_OPPSLAG) : undefined,
      slutt: h.slutt,
      usage: h.usage,
    };
    await store.set(lagNokkel(now, suffiks), JSON.stringify(post));
  } catch (_e) {
    // best-effort: journalfeil skal aldri nå brukeren
  }
}
