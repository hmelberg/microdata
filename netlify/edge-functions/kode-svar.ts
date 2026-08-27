import { streamAnthropic } from "./_lib/anthropic.ts";
import { extractByokKey, gate, upstreamErrorResponse, type IpContext } from "./_lib/auth.ts";
import { resolveLlm } from "./_lib/llm-choice.ts";
import { streamProvider } from "./_lib/providers/single.ts";

import { buildCachedPrefix } from "./_lib/prefiks.ts";
// ====================================================================
// kode-svar — "Spør raskt": single-shot, no-repair code assistant.
//
// Mirrors the dm-vurder edge function (auth, rate-limit, SSE streaming)
// but for microdata.no code generation / Q&A. The large, stable prefix
// (rules + full variable catalog + command reference) is sent as a cached
// `system` block; only the user's question varies per request. No retrieval,
// no tool-use, no server-side validation/repair — the browser validates the
// result locally via Pyodide+m2py. Contrast with the Anvil /query pipeline.
// ====================================================================

interface RequestBody {
  // multi-provider-runden 2026-08-27: valgfri egen leverandør + kvalitetsnivå.
  provider?: unknown;
  quality?: unknown;
  question: string;
  lang?: "no" | "en";
  script?: string;   // optional editor script for context (read-only here)
}

// ── Static rule blocks — condensed copy of microdata-api prompts.py.
//    Source of truth: ./prompts/kode-svar.md (kept in sync with prompts.py).

export default async (request: Request, context: IpContext): Promise<Response> => {
  const gateResp = await gate(request, { endpoint: "kode-svar", maxBodyBytes: 50_000, allowByok: true, allowLlmKey: true }, context);
  if (gateResp) return gateResp;

  let body: RequestBody;
  try {
    body = await request.json();
  } catch (_) {
    return new Response("Invalid JSON", { status: 400 });
  }
  const question = (body.question ?? "").trim();
  if (!question) {
    return new Response("Missing question", { status: 400 });
  }

  const byokKey = extractByokKey(request);
  const choice = resolveLlm(request, body, "kode-svar");
  if (choice instanceof Response) return choice;

  const origin = new URL(request.url).origin;
  const system = await buildCachedPrefix(origin);

  const lang = body.lang === "en" ? "en" : "no";
  const scriptContext = (body.script ?? "").trim();
  const userTurn = [
    `# Brukerforespørsel`,
    ``,
    `**Språk:** ${lang}`,
    ``,
    scriptContext
      ? `**Gjeldende skript i editor (kontekst):**\n\`\`\`microdata\n${scriptContext}\n\`\`\`\n`
      : ``,
    `**Spørsmål:** ${question}`,
  ].filter((s) => s !== ``).join("\n");

  try {
    const opts = {
      apiKey: choice.apiKey,
      model: choice.model,
      prompt: userTurn,
      system,
      cacheTtl: "1h" as const,
      maxTokens: 8192,
    };
    const stream = choice.provider
      ? await streamProvider(choice.provider, opts, choice)
      : await streamAnthropic({ ...opts, effort: choice.effort });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  } catch (e) {
    return upstreamErrorResponse(e, byokKey);
  }
};

