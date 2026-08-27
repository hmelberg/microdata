// Generic non-streaming agentic loop for custom providers (spec 2026-07-23-
// llm-provider-tiers A3). Mirrors runAgenticStream's SSE protocol exactly
// (progress/heartbeat/continue/text/done/error) so js/ai-chat.js is untouched
// by provider choice; the provider call is a runTurn callback so this module
// knows no wire formats. State stays in Anthropic message format — adapters
// translate at their boundary.
import type { AgenticResumeState, RetryDeps } from "../anthropic.ts";

export interface ProviderTurnResult {
  text: string;
  toolUses: { id: string; name: string; input: Record<string, unknown> }[];
  searchNotes: string[];
  stop: "tool_use" | "end";
  usage: { inputTokens: number; outputTokens: number };
  responseId?: string;
}

export interface TurnOpts {
  system: string;
  tools: unknown[];
  maxTokens: number;
  deps?: RetryDeps;
}

export type RunTurn = (state: AgenticResumeState, opts: TurnOpts) => Promise<ProviderTurnResult>;

export interface ProviderAgenticOptions {
  runTurn: RunTurn;
  system: string;
  userContent: string;
  tools: unknown[];
  executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
  progressLabel?: (name: string, input: Record<string, unknown>) => string;
  maxTokens?: number;
  maxClientToolCalls?: number;
  maxTurns?: number;
  /** Veggklokke-budsjett per invokasjon (ms). turnsPerCall teller TURER,
   *  men trege turer (lange LLM-strømmer + trege verktøykall) kan sprenge
   *  plattformens harde grense FØR tur-telleren — Netlify dreper da
   *  invokasjonen («edge function timed out», målt 2026-08-14) i stedet
   *  for at vi rekker et ryddig continue. Sjekkes FØR hver ny tur (aldri
   *  før den første — én turs fremdrift garanteres per invokasjon). */
  veggklokkeMs?: number;
  resume?: AgenticResumeState;
  turnsPerCall?: number;
  continueExtra?: () => Record<string, unknown>;
  // Klientutførte verktøy (run_code, get_pack — kontekstrunden fase 2 §4,
  // speiler anthropic.ts sin runAgenticStream): verktøykall med disse
  // navnene utføres IKKE av executeTool. run_code emitteres som
  // {type:"run_code", script} og get_pack som {type:"get_pack", id}, begge
  // fulgt av {type:"continue", state}. Klienten re-POST-er med resume +
  // run_result (run_code) eller get_pack_result (get_pack).
  clientTools?: string[];
  runResult?: string;
  getPackResult?: { id: string; text: string };
  maxRunCode?: number;
  // get_pack har EGEN budsjett-teller (state.getPackCalls) — se
  // anthropic.ts sin AgenticOptions.maxGetPack for begrunnelsen
  // (review-fiks 2026-08-06: delt teller med run_code tømte
  // kjørebudsjettet på pakke-hentinger alene).
  maxGetPack?: number;
  deps?: RetryDeps;
}

const HEARTBEAT_MS = 10_000;

export function runProviderAgenticStream(opts: ProviderAgenticOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const maxClientCalls = opts.maxClientToolCalls ?? 12;
  const maxTurns = opts.maxTurns ?? 24;
  const turnsPerCall = opts.turnsPerCall ?? 1;

  return new ReadableStream({
    async start(controller) {
      const emit = (obj: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

      const state: AgenticResumeState = opts.resume ?? {
        messages: [{ role: "user", content: opts.userContent }],
        turn: 0,
        clientCalls: 0,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      };
      const clientToolNames = new Set(opts.clientTools ?? []);
      const maxRunCode = opts.maxRunCode ?? 2;
      // Default 5 (pakkesplitting 2026-08-07: et spørsmål kan trenge 2–3
      // enkeltkilder pluss re-henting). BYOK-løpet synkroniseres med anthropic.ts.
      const maxGetPack = opts.maxGetPack ?? 5;

      try {
        // Resume etter run_code/get_pack: flett klientens resultat inn som
        // tool_result sammen med eventuelle server-verktøyresultater fra samme tur.
        if (state.pending) {
          let pendingContent: string;
          if (state.pending.name === "get_pack") {
            const gp = opts.getPackResult;
            if (!gp || typeof gp.text !== "string" || typeof gp.id !== "string") {
              throw new Error("resume med ventende get_pack mangler get_pack_result");
            }
            if (gp.id !== state.pending.expectedId) {
              throw new Error("get_pack_result.id samsvarer ikke med utestående forespørsel");
            }
            // Server-side vern (review-funn 2026-08-06), speiler
            // anthropic.ts: tom text ville gitt en tom tool_result-
            // content-blokk, avvist med 400 av de fleste Chat Completions-
            // API-er — dødelig for hele svaret.
            pendingContent = gp.text.slice(0, 40_000) || "(fant ikke pakken — svar med det du har)";
          } else {
            if (typeof opts.runResult !== "string") {
              throw new Error("resume med ventende run_code mangler run_result");
            }
            pendingContent = opts.runResult;
          }
          const merged = [...state.pending.results,
            { tool_use_id: state.pending.awaitingId, content: pendingContent }];
          state.messages.push({
            role: "user",
            content: merged.map((r) => ({ type: "tool_result", tool_use_id: r.tool_use_id, content: r.content })),
          });
          delete state.pending;
        }
        const frist = Date.now() + (opts.veggklokkeMs ?? 22_000);
        for (let i = 0; i < turnsPerCall; i++) {
          // Veggklokke-frist (se veggklokkeMs i opts): break lander på
          // continue-emit-en under løkka — klienten re-POSTer sømløst,
          // nøyaktig samme protokoll som når tur-budsjettet er brukt opp.
          if (i > 0 && Date.now() >= frist) break;
          if (state.turn >= maxTurns) throw new Error("tool-loopen nådde maks antall turer");
          const turnLabel = state.turn === 0
            ? "🧠 Tolker spørsmålet og planlegger"
            : `🤔 Arbeider med svaret (tur ${state.turn + 1})`;
          emit({ type: "progress", text: `${turnLabel} …`, replace: true });
          const turnStart = Date.now();
          const beat = setInterval(() => {
            const s = Math.round((Date.now() - turnStart) / 1000);
            try {
              emit({ type: "progress", text: `${turnLabel} … (${s} s)`, replace: true });
            } catch (_) { /* stream already closed */ }
          }, HEARTBEAT_MS);
          let turn: ProviderTurnResult;
          try {
            turn = await opts.runTurn(state, {
              system: opts.system,
              tools: opts.tools,
              maxTokens: opts.maxTokens ?? 8192,
              deps: opts.deps,
            });
          } finally {
            clearInterval(beat);
          }
          state.turn++;
          state.usage.inputTokens += turn.usage.inputTokens;
          state.usage.outputTokens += turn.usage.outputTokens;
          if (turn.responseId) state.prevResponseId = turn.responseId;
          for (const note of turn.searchNotes) emit({ type: "progress", text: note });

          if (turn.stop === "tool_use" && turn.toolUses.length) {
            const content: Record<string, unknown>[] = [];
            if (turn.text) content.push({ type: "text", text: turn.text });
            for (const tu of turn.toolUses) {
              content.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
            }
            state.messages.push({ role: "assistant", content });
            const results: { tool_use_id: string; content: string }[] = [];
            let clientCall: { id: string; name: string; input: Record<string, unknown> } | null = null;
            for (const tu of turn.toolUses) {
              if (clientToolNames.has(tu.name)) {
                // get_pack har EGEN teller (getPackCalls) — se
                // anthropic.ts sin kommentar (review-funn 2026-08-06).
                if (tu.name === "get_pack") {
                  state.getPackCalls = (state.getPackCalls ?? 0) + 1;
                  if (state.getPackCalls > maxGetPack) {
                    results.push({ tool_use_id: tu.id, content:
                      "get_pack-budsjettet er brukt opp — bruk det du allerede har, eller skriv sluttsvaret NÅ." });
                  } else if (clientCall) {
                    results.push({ tool_use_id: tu.id, content: "Kall ett klientverktøy (run_code/get_pack) én gang per tur." });
                  } else {
                    clientCall = { id: tu.id, name: tu.name, input: tu.input };
                  }
                } else {
                  state.runCalls = (state.runCalls ?? 0) + 1;
                  if (state.runCalls > maxRunCode) {
                    results.push({ tool_use_id: tu.id, content:
                      "Kjøre-budsjettet er brukt opp — skriv sluttsvaret NÅ basert på det du allerede vet. Vær ærlig om hva som ikke ble verifisert." });
                  } else if (clientCall) {
                    results.push({ tool_use_id: tu.id, content: "Kall ett klientverktøy (run_code/get_pack) én gang per tur." });
                  } else {
                    clientCall = { id: tu.id, name: tu.name, input: tu.input };
                  }
                }
                continue;
              }
              state.clientCalls++;
              const label = opts.progressLabel?.(tu.name, tu.input) ?? `Kjører ${tu.name} …`;
              emit({ type: "progress", text: label });
              let out: string;
              if (state.clientCalls > maxClientCalls) {
                out = "Verktøy-budsjettet er brukt opp — generer svaret NÅ med det du allerede har funnet. Vær ærlig om hva som mangler.";
              } else {
                try {
                  out = await opts.executeTool(tu.name, tu.input);
                } catch (e) {
                  out = `Verktøyfeil: ${String(e).slice(0, 300)}`;
                }
              }
              results.push({ tool_use_id: tu.id, content: out });
            }
            if (clientCall) {
              if (clientCall.name === "get_pack") {
                // Sanert (id ≤100, [A-Za-z0-9:_-]) — se anthropic.ts sin
                // kommentar (review-funn 2026-08-06: usanert id ville fått
                // svar.ts sin validResumeState til å avvise servens EGEN
                // continue-token).
                const id = String(clientCall.input.id ?? "")
                  .replace(/[^A-Za-z0-9:_-]/g, "").slice(0, 100);
                state.pending = { results, awaitingId: clientCall.id, name: "get_pack", expectedId: id };
                emit({ type: "get_pack", id });
              } else {
                state.pending = { results, awaitingId: clientCall.id, name: "run_code" };
                emit({ type: "run_code", script: String(clientCall.input.script ?? "") });
              }
              emit({ type: "continue", state, ...(opts.continueExtra?.() ?? {}) });
              controller.close();
              return;
            }
            state.messages.push({
              role: "user",
              content: results.map((r) => ({ type: "tool_result", tool_use_id: r.tool_use_id, content: r.content })),
            });
            continue;
          }

          if (turn.text) emit({ type: "text", text: turn.text });
          emit({ type: "done", ...state.usage });
          controller.close();
          return;
        }
        emit({ type: "continue", state, ...(opts.continueExtra?.() ?? {}) });
        controller.close();
        return;
      } catch (e) {
        emit({ type: "error", message: String(e) });
        controller.close();
      }
    },
  });
}
