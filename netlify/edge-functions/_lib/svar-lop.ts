// _lib/svar-lop.ts — bygger det agentiske svar-løpet: velger leverandørgren
// og returnerer strømmen. Flyttet ut av svar.ts (ren flytting, spec
// 2026-08-28-background-transport oppgave 4) slik at både edge-handleren og
// Node-bakgrunnsfunksjonen kan bygge NØYAKTIG samme løp — de to sidene MÅ
// ikke divergere.
//
// Denne fila importeres av Node-bakgrunnsfunksjonen (senere oppgave): ingen
// `https://`-importer, ingen `Deno.*`-tilgang. Kallsiden gir env-tilgang og
// journalstore via journalHendelse-parameteren — bygg dem ALDRI lokalt her.
import { type AgenticResumeState, runAgenticStream } from "./anthropic.ts";
import { upstreamErrorResponse } from "./auth.ts";
import { type LlmChoice } from "./llm-choice.ts";
import { runProviderAgenticStream } from "./providers/agentic.ts";
import { makeOpenAiCompatTurn } from "./providers/openai-compat.ts";
import { makeOpenAiResponsesTurn } from "./providers/openai-responses.ts";
import { filtrerRunCode } from "./run-disiplin.ts";
import {
  buildSvarSystem, coerceUserInstructions, progressLabel, questionTurn,
  RUN_CODE_TOOL, svarBudsjett, VARIABEL_INFO_TOOL,
  type SvarKvalitet, type SvarSystemDeps,
} from "./svar-instruks.ts";
import { type GenMode } from "./prefiks.ts";
import { variabelInfo } from "./tools/variabel-info.ts";

export interface LopInput {
  origin: string;
  question: string;
  mode: GenMode;
  script?: string;
  instructions?: unknown;
  choice: LlmChoice;
  erPersonlig: boolean;
  resumeState?: AgenticResumeState;
  runResultTilLopet?: string;
  runOkCalls: number;
  kvalitet: SvarKvalitet;
  journalHendelse: (type: string, detalj?: string) => void;
  turnDeadlineMs: number;
  // Ikke i den opprinnelige kontrakt-lista (task-4-brief §Interfaces) — men
  // upstreamErrorResponse(e, byokKey) i den flyttede if/else-kjeden trenger
  // den (401 vs. 502-skillet), og den finnes ikke andre steder her. svar.ts
  // regner den allerede ut fra requesten og sender den alltid; PÅKREVD (ikke
  // valgfri) — en glemt byokKey degraderer BYOK-feilmeldinger stille, og det
  // er akkurat den typen feil ingen merker før en bruker med egen nøkkel får
  // en ubrukelig melding (ruling 2, task-4-report 2026-08-29).
  byokKey: string | null;
  /** Test-injeksjon: erstatter buildSvarSystem. Speiler SvarSystemDeps.prefix-
   * mønsteret. Finnes fordi 502-veien ellers er uendelig utestbar:
   * buildCachedPrefix (prefiks.ts:1197-1220) fanger hver fetch-feil og
   * degraderer med vilje, så den kaster aldri av seg selv. */
  buildSystem?: (
    origin: string,
    mode: GenMode,
    deps: SvarSystemDeps,
  ) => Promise<string> | string;
}

export async function byggLop(inp: LopInput): Promise<ReadableStream<Uint8Array> | Response> {
  const {
    origin, question, mode, script, instructions, choice, erPersonlig,
    resumeState, runResultTilLopet, runOkCalls, kvalitet, journalHendelse,
    turnDeadlineMs, byokKey, buildSystem,
  } = inp;
  const budsjett = svarBudsjett(kvalitet);
  const tools = filtrerRunCode([RUN_CODE_TOOL, VARIABEL_INFO_TOOL], runOkCalls);

  let system: string;
  try {
    system = await (buildSystem ?? buildSvarSystem)(origin, mode, {
      userInstructions: coerceUserInstructions(instructions),
    });
  } catch (e) {
    console.error("svar: prefiks-bygging feilet:", e);
    return new Response("Systemreferansen er utilgjengelig", { status: 502 });
  }

  const executeTool = async (name: string, input: Record<string, unknown>): Promise<string> => {
    if (name === "variabel_info") {
      return await variabelInfo(origin, String(input.navn ?? ""));
    }
    throw new Error(`ukjent verktøy: ${name}`);
  };

  const commonOpts = {
    system,
    userContent: questionTurn(question, script),
    tools,
    executeTool,
    progressLabel,
    // 32000, ikke 8192. Taket koster INGENTING i seg selv — du betaler for
    // genererte tokens, ikke for taket — og 8192 var lavt nok til å bli spist
    // opp av tenkefasen alene: målt i prod 2026-08-29 brukte én balansert tur
    // nøyaktig 8192 på tenking og leverte null tekst. Anthropics egen veiledning
    // for strømmende kall er ~64000; 32000 gir romslig margin og holdes uansett
    // i sjakk av tur-fristen (5 min) og av at max_tokens nå gir forklart feil.
    maxTokens: 32000,
    maxClientToolCalls: budsjett.clientCalls,
    clientTools: ["run_code"],
    maxRunCode: budsjett.runCalls,
    runResult: runResultTilLopet,
    resume: resumeState,
    continueExtra: () => ({ run_ok_calls: runOkCalls }),
    // Feiljournal-avlytting: error-events fra løkka. Providers-veien (askstat-
    // identisk fil) kjenner ikke onEmit og ignorerer nøkkelen — bevisst.
    onEmit: (ev: Record<string, unknown>) => {
      if (ev.type === "error") journalHendelse("feil", String(ev.message ?? ""));
    },
  };
  const providerDeps = { timeoutMs: 180_000, retries: 1 };
  let inner: ReadableStream<Uint8Array>;
  try {
    if (choice.provider?.type === "openai-compat") {
      inner = runProviderAgenticStream({
        ...commonOpts,
        deps: providerDeps,
        runTurn: makeOpenAiCompatTurn(choice.provider),
      });
    } else if (choice.provider?.type === "openai-responses") {
      inner = runProviderAgenticStream({
        ...commonOpts,
        deps: providerDeps,
        runTurn: makeOpenAiResponsesTurn(choice.provider),
      });
    } else {
      // KUN den anthropic-native grenen får verboseUpstream: providers-veien
      // (runProviderAgenticStream/_lib/providers/*) er byte-identisk med
      // askstat og skal ikke divergere for et microdata-tillegg.
      inner = runAgenticStream({
        ...commonOpts,
        deps: { verboseUpstream: erPersonlig, turnDeadlineMs },
        apiKey: choice.apiKey,
        model: choice.provider ? choice.provider.model : choice.model,
        cacheTtl: "1h",
        effort: choice.effort,
        apiBase: choice.provider?.type === "anthropic-compat" ? choice.provider.baseUrl : undefined,
      });
    }
  } catch (e) {
    return upstreamErrorResponse(e, byokKey);
  }

  // EAGER, ikke lat (målt 2026-08-29 med --trace-leaks): ReadableStream kjører
  // start() synkront ved konstruksjon — WHATWG-spec, ikke pull() — så
  // runAgenticStream åpner fetch mot Anthropic, retry-timeren og heartbeat-
  // intervallet FØR denne funksjonen returnerer, uansett om noen leser strømmen.
  // Konsekvensen for kalleren: har du fått en strøm herfra, ER kallet i gang.
  // Kaster du den uten å konsumere den, lever fetchen og timerne videre til
  // invokasjonen dør. Bakgrunnsjobben må derfor alltid drenere den.
  return inner;
}
