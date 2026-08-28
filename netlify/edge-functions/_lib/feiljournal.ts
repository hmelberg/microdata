// _lib/feiljournal.ts — automatisk feiljournal for selvforbedringssløyfen
// (2026-08-28). Skrives KUN for kall autentisert med det PERSONLIGE
// tilgangspassordet (Hans' egen bruk — hans data, hans site); delt passord og
// BYOK journalføres aldri. Lagres i Netlify Blobs-storen «feiljournal» med
// ÉN nøkkel per hendelse (append-mønster: ingen read-modify-write, så
// eventual consistency er ufarlig her — i motsetning til rate-limit-telleren).
// Leses fra repoet med:  netlify blobs:list feiljournal  /  netlify blobs:get
// feiljournal <nøkkel>. Journalen er BEST-EFFORT: den feiler ÅPENT og får
// aldri velte et svar.
// @ts-ignore - @netlify/blobs via esm.sh for Deno/Edge-kompatibilitet
import { getStore } from "https://esm.sh/@netlify/blobs@7";

export interface JournalStore {
  set(key: string, value: string): Promise<void>;
}

export interface JournalHendelse {
  // "sporsmal" (nytt spørsmål), "run_feil" (kjøring klassifisert FEIL),
  // "feil" (error-event fra løkka — oppstrøms/plattform).
  type: string;
  sporsmal?: string;
  detalj?: string;
  mode?: string;
  quality?: string;
}

const MAX_SPORSMAL = 300;
const MAX_DETALJ = 400;

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
    };
    await store.set(lagNokkel(now, suffiks), JSON.stringify(post));
  } catch (_e) {
    // best-effort: journalfeil skal aldri nå brukeren
  }
}

/** Standard-storen. Egen funksjon så svar.ts kan hente den lat og testene slippe nettverk. */
export function feiljournalStore(): JournalStore {
  return (getStore as unknown as (opts: { name: string }) => JournalStore)({ name: "feiljournal" });
}
