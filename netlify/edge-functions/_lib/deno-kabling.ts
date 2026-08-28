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

// MERK: `jobbStore()` hører hjemme her, men opprettes først i Task 6 — den
// importerer `BlobbStore` fra `jobb-blobb.ts`, som ikke finnes før Task 2.

const rateLimitDep = (endpoint: string, ip: string) =>
  checkRateLimit(endpoint, ip, rateLimitStore);

/** Env-kablet port brukt av edge-handlerne. */
export function gate(request: Request, opts: GateOptions, context?: IpContext) {
  return runGate(request, opts, {
    sharedToken: denoEnv("M2PY_ACCESS_TOKEN"),
    personalToken: denoEnv("M2PY_ACCESS_TOKEN_PERSONAL"),
    checkRateLimit: rateLimitDep,
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
