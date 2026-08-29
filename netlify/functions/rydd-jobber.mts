// netlify/functions/rydd-jobber.mts — timesvis feiing av svarjobb-blobs.
//
// IKKE bare et nett under tailerens egen opprydding: jobb-tail.ts sluttet
// (Task 7-reviewfunn, kommentert der ved «IKKE slett») å slette en jobb når
// den drenerer ferdig, nettopp for at en klients nettglipp-retry (samme
// markør, samme jobId) skal finne jobben igjen i stedet for å tape hele
// svaret i det smale vinduet mellom drenering og retry. Konsekvensen: INGEN
// annen kode rydder lenger en FERDIG jobb noensinne — denne feieren er nå
// den ENESTE rydderen av dem, ikke bare en backstop for foreldreløse jobber
// (fanen lukket midt i et svar, ingen tailer kommer noensinne tilbake).
// Begge tilfeller — foreldreløs og bare ferdig — fanges av samme regel under:
// for gammel, eller hodet mangler helt.
import type { Config } from "@netlify/functions";
import { lesHead, slettJobb } from "../edge-functions/_lib/jobb-blobb.ts";
import { jobbStore } from "./_shared/node-kabling.mts";

const MAKS_ALDER_MS = 60 * 60 * 1000;

export default async (): Promise<void> => {
  const store = jobbStore();
  const { blobs } = await store.list({ prefix: "" });
  const jobber = new Set(blobs.map((b) => b.key.split("/")[0]));
  const na = Date.now();
  let slettet = 0;
  for (const jobId of jobber) {
    const head = await lesHead(store, jobId);
    // Head mangler (halvskrevet jobb — kastet før første flush) eller er
    // eldre enn en time → bort med den. Én time er god margin over BÅDE
    // 16-minutters dødjobb-vakten i jobb-tail.ts og enhver realistisk
    // nettglipp-retry, så feieren aldri konkurrerer med en jobb som
    // fremdeles kan bli hentet.
    if (!head || na - head.start > MAKS_ALDER_MS) {
      await slettJobb(store, jobId);
      slettet++;
    }
  }
  console.log(`rydd-jobber: slettet ${slettet} av ${jobber.size} jobber`);
};

export const config: Config = { schedule: "@hourly" };
