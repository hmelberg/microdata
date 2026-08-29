// netlify/functions/_shared/node-kabling.mts — Node-sidens motstykke til
// _lib/deno-kabling.ts. Samme roller, npm-pakke i stedet for esm.sh.
import { getStore } from "@netlify/blobs";
import type { BlobbStore } from "../../edge-functions/_lib/jobb-blobb.ts";
import type { JournalStore } from "../../edge-functions/_lib/feiljournal.ts";

export const nodeEnv = (k: string): string | undefined => Netlify.env.get(k);

export function jobbStore(): BlobbStore {
  return getStore({ name: "svarjobb", consistency: "strong" }) as unknown as BlobbStore;
}

export function feiljournalStore(): JournalStore {
  // Append-mønster (én nøkkel per hendelse), så eventual consistency er
  // ufarlig her — i motsetning til jobb-storen over.
  return getStore({ name: "feiljournal" }) as unknown as JournalStore;
}

// Rate-limiting skjer på /api/svar, ALDRI her: ett spørsmål skal telles én
// gang. Porten kjøres likevel i sin helhet — funksjonen er offentlig nåbar.
export const ingenRateLimit = () =>
  Promise.resolve({ allowed: true, retryAfterSeconds: 0 });
