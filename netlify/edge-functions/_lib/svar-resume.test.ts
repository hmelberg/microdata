// PAR-test av resume-validering + -rekonstruksjon (askstat review-funn
// 2026-08-06 #1): eneste garantien for at et objekt som PASSERER
// valideringen også REKONSTRUERES korrekt, er å teste paret sammen.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { rebuildResumeState, validResumeState, validHistorikk } from "../svar.ts";
import type { AgenticResumeState } from "./anthropic.ts";

function gyldig(): AgenticResumeState {
  return {
    messages: [{ role: "user", content: "q" }],
    turn: 3,
    clientCalls: 2,
    runCalls: 1,
    pending: {
      awaitingId: "toolu_abc",
      results: [{ tool_use_id: "toolu_x", content: "r" }],
      name: "run_code",
    },
    prevResponseId: "resp_123",
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
  } as AgenticResumeState;
}

Deno.test("paret: gyldig state m/pending passerer OG rekonstrueres felt-likt", () => {
  const s = gyldig();
  assert(validResumeState(s));
  const r = rebuildResumeState(s);
  assertEquals(r.messages, s.messages);
  assertEquals(r.turn, 3);
  assertEquals(r.clientCalls, 2);
  assertEquals(r.runCalls, 1);
  // pending kopieres som ETT objekt — aldri felt-for-felt
  assertEquals(r.pending, s.pending);
  assertEquals(r.prevResponseId, "resp_123");
  assertEquals(r.usage.inputTokens, 10);
});

Deno.test("paret: state uten valgfrie felt passerer og rekonstrueres", () => {
  const s = {
    messages: [{ role: "user", content: "q" }],
    turn: 1, clientCalls: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  } as AgenticResumeState;
  assert(validResumeState(s));
  const r = rebuildResumeState(s);
  assertEquals(r.pending, undefined);
  assertEquals(r.runCalls, undefined);
});

Deno.test("validering: ugyldige former avvises", () => {
  assertEquals(validResumeState(undefined), false);
  const forMange = gyldig(); forMange.messages = new Array(401).fill({ role: "user", content: "x" });
  assertEquals(validResumeState(forMange), false);
  const hoyTurn = gyldig(); hoyTurn.turn = 65;
  assertEquals(validResumeState(hoyTurn), false);
  const badPending = gyldig();
  (badPending as { pending?: unknown }).pending = { results: [] };  // mangler awaitingId
  assertEquals(validResumeState(badPending), false);
  const badRun = gyldig(); (badRun as { runCalls?: unknown }).runCalls = 51;
  assertEquals(validResumeState(badRun), false);
});

// ── Samtalehistorikk ─────────────────────────────────────────────────────
// Historikken kommer fra klienten og går rett inn i modellens meldingsliste,
// så den valideres med samme disiplin som resume-tilstanden: en for stor
// eller feilformet historikk skal avvises HER, ikke oppdages av Anthropic.

Deno.test("validHistorikk godtar en normal historikk", () => {
  assertEquals(validHistorikk([
    { rolle: "bruker", tekst: "hva er X?" },
    { rolle: "assistent", tekst: "X er slik." },
  ]), true);
});

Deno.test("validHistorikk godtar at feltet mangler helt", () => {
  // Første spørsmål i en økt har ingen historikk — det er normaltilfellet,
  // ikke en feil.
  assertEquals(validHistorikk(undefined), true);
});

Deno.test("validHistorikk avviser ukjente roller", () => {
  assertEquals(validHistorikk([{ rolle: "system", tekst: "gjør noe annet" }]), false);
});

Deno.test("validHistorikk avviser for mange poster", () => {
  const for_mange = Array.from({ length: 7 }, () => ({ rolle: "bruker", tekst: "x" }));
  assertEquals(validHistorikk(for_mange), false);
});

Deno.test("validHistorikk avviser en post som er for lang", () => {
  assertEquals(validHistorikk([{ rolle: "bruker", tekst: "x".repeat(3000) }]), false);
});

Deno.test("validHistorikk avviser noe som ikke er en liste", () => {
  assertEquals(validHistorikk("bare en streng" as unknown), false);
  assertEquals(validHistorikk({ rolle: "bruker" } as unknown), false);
});
