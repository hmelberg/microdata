// _lib/jobb-kjoring.ts — livsløpet rundt én svarjobb i bakgrunnsfunksjonen
// (netlify/functions/svar-jobb.mts). Skilt ut hit fordi Node-funksjonene ikke
// har eget testoppsett; denne modulen er ren og testes med Deno.
//
// Tre ansvar som ikke hører hjemme i selve løpet:
//
// 1. IDEMPOTENS. Kaster en bakgrunnsinvokasjon, kan Netlify kjøre den på nytt
//    med SAMME body og dermed samme jobId. Før dette nullstilte retryen head
//    til seq 0, overskrev chunk-nøklene og spleiset to løp sammen — og kalte
//    modellen igjen på brukerens nøkkel. Nå tar bare den første invokasjonen
//    jobben (startHvisNy); en retry merker en hengende jobb som feilet og gjør
//    ellers ingenting.
// 2. LIVSTEGN. Dødjobb-vakten i jobb-tail.ts måler stillhet siden siste
//    head-skriving. Et hjerteslag hvert HJERTESLAG_MS holder head fersk mens
//    løpet står stille (prefiks, forord-retry, backoff, venting på headers).
// 3. INGEN UHÅNDTERTE FEIL. kjorJobb kaster aldri: alt arbeidet kaster blir
//    til et skrubbet error-event + «feil»-state, og feil i selve feil-
//    skrivingen (Blobs nede) logges og svelges. Et kast ut av handleren ville
//    ellers utløst nettopp retryen punkt 1 handler om.
import {
  type BlobbStore, HJERTESLAG_MS, type JobbSkriver, lagSkriver, merkGjentattJobbFeilet,
} from "./jobb-blobb.ts";

export type JobbUtfall = "kjort" | "feilet" | "gjentatt" | "startfeil";

export interface KjorJobbOpts {
  store: BlobbStore;
  jobId: string;
  arbeid: (skriver: JobbSkriver) => Promise<void>;
  now?: () => number;
  hjerteslagMs?: number;
  settIntervall?: (f: () => void, ms: number) => unknown;
  stoppIntervall?: (h: unknown) => void;
  /** Fjerner nøkler fra feiltekst før den skrives til klienten. */
  skrubb?: (s: string) => string;
  logg?: (...a: unknown[]) => void;
}

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;

export async function kjorJobb(o: KjorJobbOpts): Promise<JobbUtfall> {
  const now = o.now ?? (() => Date.now());
  const logg = o.logg ?? ((...a: unknown[]) => console.error(...a));
  const skrubb = o.skrubb ?? ((s: string) => s);
  const settIntervall = o.settIntervall ?? ((f: () => void, ms: number) => setInterval(f, ms));
  const stoppIntervall = o.stoppIntervall ??
    ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));

  const skriver = lagSkriver(o.store, o.jobId, now);
  let ny: boolean;
  try {
    ny = await skriver.startHvisNy();
  } catch (e) {
    // Ingen head skrevet: taileren sier «startet aldri» etter ventPaaHeadMs.
    logg("svar-jobb: kunne ikke skrive head:", skrubb(String(e)));
    return "startfeil";
  }
  if (!ny) {
    logg(`svar-jobb: jobId ${o.jobId} finnes alt (retry) — kjøres ikke på nytt`);
    try {
      await merkGjentattJobbFeilet(o.store, o.jobId, now);
    } catch (e) {
      logg("svar-jobb: kunne ikke merke gjentatt jobb:", skrubb(String(e)));
    }
    return "gjentatt";
  }

  const timer = settIntervall(() => {
    skriver.hjerteslag().catch((e) => logg("svar-jobb: hjerteslag feilet:", skrubb(String(e))));
  }, o.hjerteslagMs ?? HJERTESLAG_MS);

  const avsluttMedFeil = async (melding: string): Promise<void> => {
    try {
      await skriver.skriv(sse({ type: "error", message: melding }));
    } catch (e) {
      logg("svar-jobb: kunne ikke skrive feil-event:", skrubb(String(e)));
    }
    try {
      await skriver.avslutt("feil");
    } catch (e) {
      logg("svar-jobb: kunne ikke avslutte jobben:", skrubb(String(e)));
    }
  };

  try {
    await o.arbeid(skriver);
    if (!skriver.avsluttet) {
      await avsluttMedFeil("Svarjobben avsluttet uten svar. Prøv spørsmålet på nytt.");
      return "feilet";
    }
    return "kjort";
  } catch (e) {
    const melding = skrubb(String(e));
    logg("svar-jobb: løpet feilet:", melding);
    await avsluttMedFeil(melding);
    return "feilet";
  } finally {
    stoppIntervall(timer);
  }
}
