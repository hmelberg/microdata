// _lib/deno-kabling.ts — ALT som binder edge-laget til Deno og til Netlify
// Blobs' esm.sh-distribusjon bor HER, og bare her. Grunnen er ikke smak:
// bakgrunnsfunksjonen kjører på Node og bundles med esbuild, som ikke kan løse
// URL-importer. Havner en `https://`-import i en modul Node-siden importerer,
// dør hele funksjonen ved bygg. `_lib/kjoretid.test.ts` vokter dette.
// @ts-ignore - @netlify/blobs via esm.sh for Deno/Edge-kompatibilitet
import { getStore } from "https://esm.sh/@netlify/blobs@7";
import {
  type GateOptions, type IpContext, runAdminGate, runGate,
} from "./auth.ts";
import { checkRateLimit, type RateStore } from "./rate-limit.ts";
import { type JournalStore } from "./feiljournal.ts";
import { type BlobbStore } from "./jobb-blobb.ts";

export const denoEnv = (k: string): string | undefined => Deno.env.get(k);

type StoreFabrikk = (opts: { name: string; consistency?: string }) => unknown;

export function rateLimitStore(name: string): RateStore {
  // Strong consistency er PÅKREVD: med default (eventual) lykkes skrivingene,
  // men lesingene ser dem aldri, så telleren står tom og grensen slår aldri inn.
  return (getStore as unknown as StoreFabrikk)({ name, consistency: "strong" }) as RateStore;
}

export function feiljournalStore(): JournalStore {
  // Append-mønster (én nøkkel per hendelse, ingen read-modify-write), så
  // eventual consistency er ufarlig her — i motsetning til de to andre.
  return (getStore as unknown as StoreFabrikk)({ name: "feiljournal" }) as JournalStore;
}

export function jobbStore(): BlobbStore {
  // Strong consistency er PÅKREVD, ikke valgfritt: med default (eventual)
  // lykkes skriverens setJSON-kall, men taileren leser en gammel (eller
  // ingen) head og henger for alltid — samme felle som rateLimitStore over,
  // og en som alt har kostet dette prosjektet fire repoers stille-tomme
  // tellere (se MEMORY.md «Netlify Blobs: eventual consistency dreper rate
  // limits»). Her er skadebildet verre: ikke en glemt grense, men en klient
  // som poller i det uendelige mot en jobb som faktisk er ferdig.
  return (getStore as unknown as StoreFabrikk)({
    name: "svarjobb",
    consistency: "strong",
  }) as BlobbStore;
}

const rateLimitDep = (endpoint: string, ip: string) =>
  checkRateLimit(endpoint, ip, rateLimitStore);

// Speiler ingenRateLimit i node-kabling.mts (samme resonnement, samme rolle,
// annen runtime): /api/svar-tail er ALDRI rate-limitet. En tail er ikke et
// nytt spørsmål — det er samme spørsmål som allerede talte mot 60/t-grensen
// på /api/svar, bare neste avspillingsvindu. Uten dette no-opet fikk
// svar-tail sin EGEN 60/t-bøtte (nøkkelen er `${endpoint}:${ip}`, og
// "svar-tail" er en annen endpoint-streng enn "svar") — en 13-minutters jobb
// bruker ~17 håndoverleveringer à 45 s, så den fjerde lange jobben innen én
// time traff 429 midt i strømmen (Task 6 review-funn 1).
const ingenRateLimit = () =>
  Promise.resolve({ allowed: true, retryAfterSeconds: 0 });

/** Env-kablet port brukt av edge-handlerne. */
export function gate(request: Request, opts: GateOptions, context?: IpContext) {
  return runGate(request, opts, {
    sharedToken: denoEnv("M2PY_ACCESS_TOKEN"),
    personalToken: denoEnv("M2PY_ACCESS_TOKEN_PERSONAL"),
    checkRateLimit: rateLimitDep,
  }, context);
}

/** Env-kablet port for /api/svar-tail — se ingenRateLimit over. */
export function tailGate(request: Request, opts: GateOptions, context?: IpContext) {
  return runGate(request, opts, {
    sharedToken: denoEnv("M2PY_ACCESS_TOKEN"),
    personalToken: denoEnv("M2PY_ACCESS_TOKEN_PERSONAL"),
    checkRateLimit: ingenRateLimit,
  }, context);
}

/** Env-kablet adminport (hent). */
export function adminGate(request: Request, opts: GateOptions, context?: IpContext) {
  return runAdminGate(request, opts, {
    sharedToken: denoEnv("M2PY_ACCESS_TOKEN"),
    personalToken: denoEnv("M2PY_ACCESS_TOKEN_PERSONAL"),
    checkRateLimit: rateLimitDep,
  }, context);
}
