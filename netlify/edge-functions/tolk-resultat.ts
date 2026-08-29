import { detectLanguage } from "./_lib/parse-script-context.ts";
import { streamAnthropic } from "./_lib/anthropic.ts";
import { extractByokKey, upstreamErrorResponse, type IpContext } from "./_lib/auth.ts";
import { resolveLlm } from "./_lib/llm-choice.ts";
import { streamProvider } from "./_lib/providers/single.ts";
import { denoEnv, gate } from "./_lib/deno-kabling.ts";
import { coerceKilde, tolkSystem, tolkUserTemplate } from "./_lib/tolk-prompt.ts";

interface RequestBody {
  // multi-provider-runden 2026-08-27: valgfri egen leverandør + kvalitetsnivå.
  provider?: unknown;
  quality?: unknown;
  script?: string;
  output: string;
  språk?: "auto" | "microdata" | "python" | "r";
  ui_lang?: "no" | "en";   // svarspråk (UI-språket); default norsk
  // Hvor utskriften kommer fra: appens egen kjøring på syntetiske øvingsdata
  // («emulator», default) eller ekte microdata.no-resultater brukeren har limt
  // inn / lastet opp («ekte»). Styrer HELE innrammingen — se _lib/tolk-prompt.ts.
  kilde?: unknown;
}

// Promptene (system + brukermal, i emulator- og ekte-innramming) ligger i
// _lib/tolk-prompt.ts — flyttet dit 2026-08-29 da ekte-innrammingen kom til, og
// testbare der. Source of truth for ordlyden er fortsatt prompts/tolk-resultat.md.

function languageInstruction(requested: string, detected: string): string {
  if (requested === "microdata") return "Output er fra microdata.no-DSL.";
  if (requested === "python") return "Output er fra Python.";
  if (requested === "r") return "Output er fra R.";
  return `Detektert språk: ${detected}.`;
}

export default async (request: Request, context: IpContext): Promise<Response> => {
  const gateResp = await gate(request, { endpoint: "tolk-resultat", maxBodyBytes: 120_000, allowByok: true, allowLlmKey: true }, context);
  if (gateResp) return gateResp;

  let body: RequestBody;
  try {
    body = await request.json();
  } catch (_) {
    return new Response("Invalid JSON", { status: 400 });
  }
  if (!body.output || typeof body.output !== "string" || !body.output.trim()) {
    return new Response("Missing output", { status: 400 });
  }

  const byokKey = extractByokKey(request);
  const choice = resolveLlm(request, body, "tolk-resultat", denoEnv);
  if (choice instanceof Response) return choice;

  // Truncate defensively so a huge output can't blow the prompt.
  const MAX_CHARS = 30_000;
  const script = (body.script ?? "").slice(0, MAX_CHARS);
  const output = body.output.slice(0, MAX_CHARS);
  const requested = body.språk ?? "auto";
  const uiLang = body.ui_lang === "en" ? "en" : "no";
  const outputLanguage = uiLang === "en"
    ? `Answer in English (overriding the Norwegian scaffold above). Translate the
section headings as: «Hva analysen gjorde» → «What the analysis did»,
«Resultater» → «Results», «Forbehold» → «Caveats».`
    : "Svar på norsk.";
  const detected = detectLanguage(output || script);
  const kilde = coerceKilde(body.kilde);

  const prompt = tolkUserTemplate(kilde)
    .replaceAll("{{OUTPUT_LANGUAGE}}", () => outputLanguage)
    .replaceAll("{{LANGUAGE}}", () => languageInstruction(requested, detected))
    .replaceAll("{{SCRIPT}}", () => script || "(ingen kommandoer sendt)")
    .replaceAll("{{OUTPUT}}", () => output);

  try {
    const opts = {
      apiKey: choice.apiKey,
      model: choice.model,
      prompt,
      maxTokens: 1800,
      system: tolkSystem(kilde),
      cacheTtl: "1h" as const,
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
