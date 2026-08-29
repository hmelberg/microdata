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
import { skrivForord } from "../edge-functions/_lib/forord.ts";
import { byggLop, nyHopSamler } from "../edge-functions/_lib/svar-lop.ts";
import { journalfor } from "../edge-functions/_lib/feiljournal.ts";
import {
  feiljournalStore, ingenRateLimit, jobbStore, nodeEnv,
} from "./_shared/node-kabling.mts";

// 5 min per modelltur (Hans, 2026-08-29). Merk hva taket FAKTISK begrenser:
// forbruket er allerede takstyrt av max_tokens (8192) og turnsPerCall=1, så en
// forlatt jobb koster maks én tur uansett hvor lenge den står. Taket begrenser
// altså funksjonstid og gir raskere, forklart feil — ikke tokenforbruk. Det som
// sparer tokens er en ekte avbryt-knapp (eget løp: AbortSignal helt fram til
// fetch-en i anthropic.ts).
// 5 min mot realistisk verste tilfelle: 8192 tokens på Opus ≈ 2,3-3,4 min pluss
// tenkefase ≈ 45 s ≈ 4,2 min. Margin, men ikke stor — treffes den, sier
// feilmeldingen nå hvor lang fristen var, i stedet for å påstå «60 s».
const TUR_FRIST_MS = 300_000;

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

  // Skriveren opprettes og head skrives HER — rett etter porten og
  // jobId-valideringen, FØR resolveLlm eller byggLop. Grunnen: tailerens
  // ventPaaHeadMs (10 s, jobb-tail.ts) starter å telle idet klienten fikk
  // 202 fra /api/svar, altså FØR denne bakgrunnsinvokasjonen i det hele tatt
  // er kald-startet. Alt herfra og ned mot byggLop → buildSvarSystem →
  // buildCachedPrefix (tre sekvensielle fetch, deriblant en 652 KB
  // variable_metadata.json + JSON.parse + katalogrendring — se
  // sluttfiks-planen 2026-08-28, Fix 2) kan alene bruke opp budsjettet på en
  // kald, lavtrafikkert bakgrunnsfunksjon. Uten en tidlig head venter
  // taileren forgjeves og forteller brukeren «Svarjobben startet aldri» mens
  // en full-pris jobb kjører videre i opptil 13 minutter til.
  // Samler opp hva dette hoppet faktisk gjorde. Skrives til journalen ETTER
  // pumpen — ikke fra onEmit, som er synkron og hvis feil svelges, og som
  // dessuten kjører mens strømmen er i ferd med å lukkes.
  const hoppStart = Date.now();
  const samler = nyHopSamler();

  const skriver = lagSkriver(jobbStore(), jobId, () => Date.now());
  await skriver.start();

  // byokKey beregnes HER (ikke bare inne i resolveLlm) fordi byggLop trenger
  // sin egen kopi til upstreamErrorResponse(e, byokKey) — se svar.ts, som gjør
  // det samme. LopInput.byokKey er PÅKREVD (task-4-report-rulingen): utelates
  // den, degraderer BYOK-feilmeldinger stille til en generisk 502 i stedet for
  // 401 «Ugyldig Anthropic-nøkkel», og ingen test i dette repoet fanger det —
  // verken deno check (Node-funksjoner er utenfor Deno-sjekken) eller esbuild
  // (typefeil, ikke bundlefeil).
  const byokKey = extractByokKey(request);
  const choice = resolveLlm(request, body, "svar", nodeEnv);
  if (choice instanceof Response) {
    // Uten dette blir jobben stående som «kjorer» ved seq 0 helt til
    // dødjobb-vakten (16 min, jobb-tail.ts) rydder den — resolveLlm feiler
    // her praktisk talt aldri (svar.ts har alt validert samme body), men når
    // den gjør det, skal taileren få vite det i sekunder, ikke minutter.
    await skriver.skriv(`data: ${JSON.stringify({
      type: "error", message: `Kunne ikke starte løpet (HTTP ${choice.status})`,
    })}\n\n`);
    await skriver.avslutt("feil");
    return choice;
  }

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

  // Feiljournalen følger løpet, ikke porten: KUN `feil` oppstår INNE i løkka
  // (emittert av onEmit i svar-lop.ts, tur for tur), så et no-op her ville
  // stille tømt journalen for nettopp den hendelsen selvforbedringssløyfen
  // lever av her. `sporsmal` og `run_feil` skrives IKKE av denne funksjonen —
  // begge oppstår på handler-nivå i svar.ts (før byggLop kalles), og hører
  // hjemme der, ikke her.
  const journal = erPersonlig ? feiljournalStore() : null;
  const journalHendelse = (type: string, detalj?: string): void => {
    if (journal) {
      void journalfor(journal, { type, sporsmal: question, detalj, mode, quality: kvalitet });
    }
  };

  const lop = await byggLop({
    origin: new URL(request.url).origin,
    question, mode, script: body.script, instructions: body.instructions,
    choice, erPersonlig,
    resumeState: body.resumeState, runResultTilLopet: body.runResultTilLopet,
    runOkCalls: Number(body.runOkCalls) || 0,
    kvalitet, journalHendelse, samler,
    turnDeadlineMs: TUR_FRIST_MS, byokKey,
  });
  if (lop instanceof Response) {
    await skriver.skriv(`data: ${JSON.stringify({
      type: "error", message: `Kunne ikke bygge løpet (HTTP ${lop.status})`,
    })}\n\n`);
    await skriver.avslutt("feil");
    return new Response(null, { status: 202 });
  }

  // Bare når turen faktisk kommer til å tenke (altså «Grundig»), og bare på
  // første tur — et resume har allerede vist brukeren tekst.
  //
  // Sekvensielt, ikke parallelt: lagSkriver serialiserer alt gjennom en intern
  // kjede, så to samtidige skrivere ville IKKE flettet frames inn i hverandre
  // lenger — det er ikke grunnen. Grunnen er at parallelt ville lagt
  // samtidighet til den mest risikofylte filen i denne planen for å spare
  // ~1,5 s på en tur som uansett tar 30+, og brukeren kan ikke merke
  // forskjellen på et forord ved 1 s og ett ved 1,5 s.
  //
  // Forordet er BEVISST bare for den native Anthropic-veien. Med egen
  // leverandør er choice.apiKey brukerens FREMMEDE nøkkel (llm-choice.ts:155),
  // og messageAnthropic uten apiBase går til api.anthropic.com
  // (anthropic.ts:39-41) — et forord ville dermed sendt nøkkelen til en vert
  // brukeren ikke har valgt. En gateway har heller ingen garantert
  // haiku-ekvivalent. Forordet er pynt; det er ikke verdt en egen kodevei
  // per leverandørtype.
  if (choice.effort && !choice.provider && !body.resumeState) {
    await skrivForord(skriver, { apiKey: choice.apiKey, question: String(body.question ?? "") });
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

  // Her, ikke i onEmit: vi er fortsatt inne i handleren, så awaiten rekker
  // frem. Journalen er best-effort (journalfor feiler åpent), og skrives kun
  // for personlig-autentisert trafikk — journal er null ellers.
  if (journal) {
    await journalfor(journal, {
      type: "svar",
      sporsmal: question,
      mode,
      quality: kvalitet,
      // Valideres HER også, ikke bare på edge: denne funksjonen er offentlig
      // nåbar, og en lang streng ville ellers blåst opp journalposten.
      sporring: typeof body.sporring === "string" && body.sporring.length <= 64
        ? body.sporring
        : undefined,
      varighetMs: Date.now() - hoppStart,
      // Modellen som FAKTISK kjørte: på leverandørveien er provider.model
      // sannheten, ikke choice.model (llm-choice.ts sier det eksplisitt).
      modell: choice.provider ? choice.provider.model : choice.model,
      effort: choice.effort,
      svar: samler.tekst,
      script: samler.script,
      oppslag: samler.oppslag,
      slutt: samler.slutt || "ukjent",
      usage: samler.usage,
    });
  }
  return new Response(null, { status: 202 });
};

export const config: Config = { path: "/api/svar-jobb", background: true };
