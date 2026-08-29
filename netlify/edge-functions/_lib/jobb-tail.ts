// _lib/jobb-tail.ts — leser en svarjobb fra Blobs og strømmer den ut som SSE.
// Delt av /api/svar (fra markør 0) og /api/svar-tail (fra en overlevert markør).
//
// Taileren har selv 60-sekundersveggen over seg — den er en helt vanlig
// edge-invokasjon. Forskjellen fra før er at overleveringen nå er
// DETERMINISTISK: den henger på tailerens egen klokke, ikke på uforutsigbar
// modell-latens. Derfor kan den ikke lenger overraske oss midt i et svar.
import {
  type BlobbStore, lesChunks, lesHead, slettJobb,
} from "./jobb-blobb.ts";

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
};

export interface TailOpts {
  store: BlobbStore;
  jobId: string;
  fra: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Overlever på 45 s — komfortabelt under plattformens ~60 s. */
  fristMs?: number;
  /** Hvor lenge vi venter på at bakgrunnsjobben skal skrive sin første head. */
  ventPaaHeadMs?: number;
  pollMs?: number;
}

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;

/** En jobb som står «kjorer» lenger enn dette er død — bakgrunnsfunksjonen ble
 * drept (OOM, plattformdrap) etter at head var skrevet, men før avslutt.
 * Uten denne grensen overleverer taileren hvert 45. sekund i det uendelige og
 * klienten kobler seg på like lenge. 16 min er like over background-taket på
 * 15, så en levende jobb rekker alltid å bli ferdig først. */
const MAKS_JOBB_MS = 16 * 60 * 1000;

export function tailStream(opts: TailOpts): ReadableStream<Uint8Array> {
  const {
    store, jobId, fra,
    now = () => Date.now(),
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    fristMs = 45_000,
    ventPaaHeadMs = 10_000,
    pollMs = 120,
  } = opts;

  const enc = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const send = (s: string) => controller.enqueue(enc.encode(s));
      const start = now();
      let cursor = fra;
      try {
        while (true) {
          const head = await lesHead(store, jobId);
          if (!head) {
            if (now() - start >= ventPaaHeadMs) {
              send(sse({
                type: "error",
                message: "Svarjobben startet aldri. Prøv spørsmålet på nytt.",
              }));
              return;
            }
            await sleep(pollMs);
            continue;
          }
          if (head.seq > cursor) {
            for (const c of await lesChunks(store, jobId, cursor, head.seq)) {
              if (c) send(c);
            }
            cursor = head.seq;
          }
          // Ferdig OG drenert: lukk — men IKKE slett (Task 7 review-funn).
          // Klientens nettglipp-retry re-GETer fra samme markør etter et
          // nettbrudd. Den forlatte server-taileren fra FØR bruddet har ingen
          // cancel()-handler og poller videre; den kan drenere ferdig og
          // slette jobben i det ~1-sekundsvinduet før retryen når fram. Da
          // finner retryen ingen head, og HELE svaret er tapt — ikke bare
          // halen. Vinduet er smalt, men konsekvensen er total, så den
          // timesvise feieren (rydd-jobber) blir eneste rydder av ferdige
          // jobber: retry blir dermed idempotent uansett hvor mange ganger
          // klienten kobler seg på igjen. Dødjobb-veien under BEHOLDER
          // slettingen — den jobben er faktisk død, og klienten skal ikke
          // prøve igjen.
          if (head.state !== "kjorer" && cursor >= head.seq) {
            return;
          }
          // Dødjobb-vakt: en jobb som har stått «kjorer» lenger enn
          // MAKS_JOBB_MS kommer aldri til å bli ferdig — bakgrunnsprosessen
          // som skulle kalt avslutt() finnes ikke lenger. Rydd og forklar i
          // stedet for å overlevere til enda en tailer som ville ventet like
          // forgjeves.
          if (head.state === "kjorer" && now() - head.start > MAKS_JOBB_MS) {
            send(sse({
              type: "error",
              message: "Svarjobben stanset uventet (over 16 minutter uten å bli ferdig). Prøv spørsmålet på nytt.",
            }));
            await slettJobb(store, jobId);
            return;
          }
          // Fristen nådd: overlever markøren. Jobben ryddes IKKE — den lever
          // videre i bakgrunnen, og neste tailer plukker den opp.
          if (now() - start >= fristMs) {
            send(sse({ type: "tail", job: jobId, cursor }));
            return;
          }
          await sleep(pollMs);
        }
      } catch (e) {
        send(sse({ type: "error", message: String(e) }));
      } finally {
        controller.close();
      }
    },
  });
}
