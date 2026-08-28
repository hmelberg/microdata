// /api/svar — samlet pipeline: ETT agentisk løp med run_code som klientutført
// verktøy og variabel_info som edge-utført oppslag. Erstatter kode-svar,
// kode-svar-v2 og data-svar (samlet svar-pipeline, spec 2026-08-28).
// Strukturmal: askstats svar.ts, minus ruter/packs/keys/discover — microdata
// har ikke askstats finn-data-problem; kunnskapen er front-lastet i prefiksen
// og detaljer hentes med variabel_info.
import { timingSafeEqual, extractByokKey, type IpContext } from "./_lib/auth.ts";
import { type AgenticResumeState } from "./_lib/anthropic.ts";
import { coerceQuality, resolveLlm } from "./_lib/llm-choice.ts";
import {
  coerceRunOkCalls, klassifiserRunResult, medPaaminnelse,
} from "./_lib/run-disiplin.ts";
import { type GenMode } from "./_lib/prefiks.ts";
import { journalfor } from "./_lib/feiljournal.ts";
import { denoEnv, feiljournalStore, gate } from "./_lib/deno-kabling.ts";
import { SSE_HEADERS } from "./_lib/jobb-tail.ts";
import { byggLop } from "./_lib/svar-lop.ts";

interface ResumeBody { state?: AgenticResumeState; run_ok_calls?: unknown; }
interface RequestBody {
  question?: string;
  mode?: unknown;
  script?: string;
  quality?: unknown;
  instructions?: unknown;
  provider?: unknown;
  resume?: ResumeBody;
  run_result?: unknown;
}

// Resume-bodies bærer hele samtaletilstanden (tool-results, kjøringsoutput).
const MAX_BODY_BYTES = 2_000_000;

const coerceMode = (m: unknown): GenMode => (m === "python" || m === "r") ? m : "microdata";

// Eksportert for par-testen (_lib/svar-resume.test.ts): valideringen og
// rekonstruksjonen testes SAMMEN — askstat review-funn 2026-08-06 #1.
export function validResumeState(s: AgenticResumeState | undefined): s is AgenticResumeState {
  if (!s || !Array.isArray(s.messages) || s.messages.length < 1 || s.messages.length > 400) return false;
  if (!Number.isInteger(s.turn) || s.turn < 1 || s.turn > 64) return false;
  if (!Number.isInteger(s.clientCalls) || s.clientCalls < 0 || s.clientCalls > 200) return false;
  if (s.runCalls !== undefined && (!Number.isInteger(s.runCalls) || s.runCalls < 0 || s.runCalls > 50)) return false;
  if (s.prevResponseId !== undefined &&
    (typeof s.prevResponseId !== "string" || s.prevResponseId.length > 200)) return false;
  if (s.pending !== undefined) {
    const p = s.pending as Record<string, unknown>;
    if (!p || typeof p.awaitingId !== "string" || p.awaitingId.length > 200 ||
      !Array.isArray(p.results) || (p.results as unknown[]).length > 20) return false;
    if (p.name !== undefined && (typeof p.name !== "string" || p.name.length > 20)) return false;
  }
  return typeof s.usage === "object" && s.usage !== null;
}

// `pending` kopieres som ETT objekt, ALDRI felt-for-felt (i motsetning til
// `usage`, som bevisst whitelister tallfelt) — en felt-for-felt-omskriving
// ville stille droppet felter og latt runden dø.
export function rebuildResumeState(s: AgenticResumeState): AgenticResumeState {
  const u = s.usage as Record<string, unknown>;
  return {
    messages: s.messages,
    turn: s.turn,
    clientCalls: s.clientCalls,
    runCalls: s.runCalls,
    pending: s.pending,
    prevResponseId: s.prevResponseId,
    usage: {
      inputTokens: Number(u.inputTokens) || 0,
      outputTokens: Number(u.outputTokens) || 0,
      cacheReadTokens: Number(u.cacheReadTokens) || 0,
      cacheCreationTokens: Number(u.cacheCreationTokens) || 0,
    },
  };
}

export default async (request: Request, context: IpContext): Promise<Response> => {
  const gateResp = await gate(request, {
    endpoint: "svar", maxBodyBytes: MAX_BODY_BYTES, allowByok: true, allowLlmKey: true,
  }, context);
  if (gateResp) return gateResp;

  let body: RequestBody;
  try { body = await request.json(); } catch { return new Response("Invalid JSON", { status: 400 }); }
  const question = (body.question ?? "").trim();
  if (!question) return new Response("Missing question", { status: 400 });

  let resumeState: AgenticResumeState | undefined;
  if (body.resume) {
    if (!validResumeState(body.resume.state)) {
      return new Response("Invalid resume payload", { status: 400 });
    }
    resumeState = rebuildResumeState(body.resume.state);
  }

  const byokKey = extractByokKey(request);
  const choice = resolveLlm(request, body, "svar", denoEnv);
  if (choice instanceof Response) return choice;

  // Personlig-autentisert kall (Hans' private passord): oppstrøms-feildetaljer
  // følger SSE-error-eventet (skrubbet for API-nøkkelen i anthropic.ts) —
  // Netlify-live-tail er flyktig, og «Anthropic API error 400» alene er
  // udiagnostiserbart (thinking-signatur-400-en 2026-08-28 kostet en full
  // reproduksjonsrunde). Delt passord og BYOK matcher aldri her → generisk.
  const bearer = (request.headers.get("authorization") ?? "").startsWith("Bearer ")
    ? (request.headers.get("authorization") ?? "").slice(7).trim()
    : "";
  const personligToken = denoEnv("M2PY_ACCESS_TOKEN_PERSONAL") ?? "";
  const erPersonlig = bearer.length > 0 && personligToken.length > 0 &&
    timingSafeEqual(bearer, personligToken);

  // Run-disiplinen (COPIED-kontrakten): OK.-klassifiserte kjøringer teller
  // mot svar-klart-stopp — påminnelse etter første, stenging etter andre.
  let runOkCalls = coerceRunOkCalls(body.resume?.run_ok_calls);
  let runResultTilLopet = typeof body.run_result === "string"
    ? body.run_result.slice(0, 20_000)
    : undefined;
  if (runResultTilLopet !== undefined && klassifiserRunResult(runResultTilLopet) === "ok") {
    runOkCalls++;
    if (runOkCalls === 1) runResultTilLopet = medPaaminnelse(runResultTilLopet);
  }

  const origin = new URL(request.url).origin;
  const mode = coerceMode(body.mode);
  const kvalitet = coerceQuality(body.quality) ?? "balanced";

  // Feiljournalen (selvforbedringssløyfen 2026-08-28): KUN personlig-
  // autentisert trafikk journalføres — Hans' egen bruk, hans data. Alt er
  // best-effort og fire-and-glem (journalfor feiler åpent; isolatet lever så
  // lenge svarstrømmen gjør, så skrivingene rekker frem).
  const journal = erPersonlig ? feiljournalStore() : null;
  const journalHendelse = (type: string, detalj?: string): void => {
    if (journal) void journalfor(journal, { type, sporsmal: question, detalj, mode, quality: kvalitet });
  };
  if (!body.resume) journalHendelse("sporsmal");
  if (runResultTilLopet !== undefined && klassifiserRunResult(runResultTilLopet) === "feil") {
    journalHendelse("run_feil", runResultTilLopet);
  }
  const lop = await byggLop({
    origin, question, mode, script: body.script, instructions: body.instructions,
    choice, erPersonlig, resumeState, runResultTilLopet, runOkCalls,
    kvalitet, journalHendelse, turnDeadlineMs: 50_000, byokKey,
  });
  if (lop instanceof Response) return lop;
  return new Response(lop, { headers: SSE_HEADERS });
};
