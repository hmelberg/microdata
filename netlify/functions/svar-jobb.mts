// netlify/functions/svar-jobb.mts — det agentiske løpet, flyttet ut av
// 60-sekundersveggen og inn i et 15-minutters budsjett.
//
// SIKKERHET: denne funksjonen er OFFENTLIG NÅBAR på /api/svar-jobb. Uten
// porten under ville hvem som helst kunne brenne serverens API-nøkkel med et
// enkelt POST. Både auth-porten OG jobb-hemmeligheten er derfor påkrevd —
// hemmeligheten fordi rate-limiten bor på /api/svar, og et direkte kall hit
// ellers ville gått utenom den.
import type { Config } from "@netlify/functions";
import { extractByokKey, runGate, timingSafeEqual } from "../edge-functions/_lib/auth.ts";
import { coerceQuality, resolveLlm } from "../edge-functions/_lib/llm-choice.ts";
import { lagSkriver } from "../edge-functions/_lib/jobb-blobb.ts";
import { byggLop } from "../edge-functions/_lib/svar-lop.ts";
import { journalfor } from "../edge-functions/_lib/feiljournal.ts";
import {
  feiljournalStore, ingenRateLimit, jobbStore, nodeEnv,
} from "./_shared/node-kabling.mts";

// 13 min: under background-taket på 15, så en løpsk tur får en FORKLART feil
// i stedet for stille død.
const TUR_FRIST_MS = 780_000;

export default async (request: Request): Promise<Response> => {
  const hemmelighet = nodeEnv("SVAR_JOBB_SECRET") ?? "";
  const presentert = request.headers.get("x-jobb-nokkel") ?? "";
  if (!hemmelighet || !timingSafeEqual(presentert, hemmelighet)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const gateResp = await runGate(request, {
    endpoint: "svar-jobb", maxBodyBytes: 2_000_000,
    allowByok: true, allowLlmKey: true,
  }, {
    sharedToken: nodeEnv("M2PY_ACCESS_TOKEN"),
    personalToken: nodeEnv("M2PY_ACCESS_TOKEN_PERSONAL"),
    checkRateLimit: ingenRateLimit,
  });
  if (gateResp) return gateResp;

  const body = await request.json();
  const jobId = String(body.jobId ?? "");
  if (!/^[0-9a-f-]{36}$/.test(jobId)) {
    return new Response("Ugyldig jobId", { status: 400 });
  }

  // byokKey beregnes HER (ikke bare inne i resolveLlm) fordi byggLop trenger
  // sin egen kopi til upstreamErrorResponse(e, byokKey) — se svar.ts, som gjør
  // det samme. LopInput.byokKey er PÅKREVD (task-4-report-rulingen): utelates
  // den, degraderer BYOK-feilmeldinger stille til en generisk 502 i stedet for
  // 401 «Ugyldig Anthropic-nøkkel», og ingen test i dette repoet fanger det —
  // verken deno check (Node-funksjoner er utenfor Deno-sjekken) eller esbuild
  // (typefeil, ikke bundlefeil).
  const byokKey = extractByokKey(request);
  const choice = resolveLlm(request, body, "svar", nodeEnv);
  if (choice instanceof Response) return choice;

  // erPersonlig regnes ut HER, fra tokenet — den kommer ALDRI fra bodyen.
  // Den styrer `verboseUpstream` (skrubbede oppstrøms-feildetaljer) og
  // feiljournalen; et klientsatt flagg ville gitt hvem som helst med det
  // delte passordet innsyn ment for eieren alene.
  const authHeader = request.headers.get("authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : "";
  const personligToken = nodeEnv("M2PY_ACCESS_TOKEN_PERSONAL") ?? "";
  const erPersonlig = bearer.length > 0 && personligToken.length > 0 &&
    timingSafeEqual(bearer, personligToken);

  const question = String(body.question ?? "").trim();
  const mode = (body.mode === "python" || body.mode === "r") ? body.mode : "microdata";
  const kvalitet = coerceQuality(body.quality) ?? "balanced";

  // Feiljournalen følger løpet, ikke porten: `run_feil` og `feil` oppstår
  // INNE i løkka, så et no-op her ville stille tømt journalen for nettopp de
  // hendelsene selvforbedringssløyfen lever av. /api/svar skriver `sporsmal`.
  const journal = erPersonlig ? feiljournalStore() : null;
  const journalHendelse = (type: string, detalj?: string): void => {
    if (journal) {
      void journalfor(journal, { type, sporsmal: question, detalj, mode, quality: kvalitet });
    }
  };

  const skriver = lagSkriver(jobbStore(), jobId, () => Date.now());
  const lop = await byggLop({
    origin: new URL(request.url).origin,
    question, mode, script: body.script, instructions: body.instructions,
    choice, erPersonlig,
    resumeState: body.resumeState, runResultTilLopet: body.runResultTilLopet,
    runOkCalls: Number(body.runOkCalls) || 0,
    kvalitet, journalHendelse,
    turnDeadlineMs: TUR_FRIST_MS, byokKey,
  });
  if (lop instanceof Response) {
    await skriver.skriv(`data: ${JSON.stringify({
      type: "error", message: `Kunne ikke bygge løpet (HTTP ${lop.status})`,
    })}\n\n`);
    await skriver.avslutt("feil");
    return new Response(null, { status: 202 });
  }

  // Ren bytepumpe: strømmen ER allerede «data: {...}\n\n»-frames, så ingenting
  // parses. Grensesnittet mot ai-chat.js er dermed byte-identisk med før.
  const dec = new TextDecoder();
  try {
    for await (const chunk of lop) {
      await skriver.skriv(dec.decode(chunk, { stream: true }));
    }
    await skriver.avslutt("ferdig");
  } catch (e) {
    await skriver.skriv(`data: ${JSON.stringify({
      type: "error", message: String(e),
    })}\n\n`);
    await skriver.avslutt("feil");
  }
  return new Response(null, { status: 202 });
};

export const config: Config = { path: "/api/svar-jobb", background: true };
