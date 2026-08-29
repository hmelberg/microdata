// Modell- og effort-valg (spec 2026-08-27-multi-provider-byok §4).
//
// Ett sted for HELE presedensen: env-overstyring > brukerens kvalitetsvalg >
// per-kallsted-default. Kallstedene skal aldri gjøre dette selv — grunnen er
// regel 1 under, som er en 400-feil og ikke en smakssak.
//
// 1. effort FEILER på Haiku 4.5. Picker-passet og «fast»-nivået kjører begge
//    Haiku, og må derfor ALDRI sende effort. Håndheves her, ikke i fem
//    kallsteder som hver kan glemme det.
// 2. output_config.effort er NØSTET i request-body, aldri toppnivå. Se
//    anthropic.ts — denne modulen leverer bare verdien.
// 3. Modell-ID-er bærer ikke datosuffiks (claude-haiku-4-5, ikke
//    claude-haiku-4-5-20251001).

export type Quality = "fast" | "balanced" | "best";

export type CallSite = "dm-vurder" | "tolk-resultat" | "svar";

export interface ModelChoice {
  model: string;
  effort?: string;
}

/** Brukerens valg fra body. Alt annet enn de tre literalene → null (default). */
export function coerceQuality(u: unknown): Quality | null {
  return u === "fast" || u === "balanced" || u === "best" ? u : null;
}

// Kvalitetsnivåene. «fast» har med vilje ingen effort — se regel 1.
const TIERS: Record<Quality, ModelChoice> = {
  fast: { model: "claude-haiku-4-5" },
  // Effort er ADAPTIVT: modellen velger selv om den skal tenke. Målt
  // 2026-08-28 mot claude-sonnet-5: med effort satt kan tenkefasen ta 26-31 s
  // der API-et sender NØYAKTIG INGENTING (thinking_delta kommer én gang, med
  // 0 tegn, helt til slutt — tenketeksten er kryptert og finnes ikke å vise).
  // Uten effort strømmer samme modell fra 1,12 s. «Balansert» skal føles
  // balansert, ikke stum, så den kjører uten.
  balanced: { model: "claude-sonnet-5" },
  // «Grundig» beholder tenkingen — der er ventetiden brukerens eget valg, og
  // Haiku-forordet (Task 9) fyller den med noe å lese.
  best: { model: "claude-opus-5", effort: "high" },
};

// Per kallsted når brukeren ikke har valgt noe. tolk-resultat tolker output
// som ALLEREDE er beregnet — den trenger ikke samme dybde som kodegenerering.
const DEFAULTS: Record<CallSite, ModelChoice> = {
  "dm-vurder": { model: "claude-sonnet-5", effort: "medium" },
  "tolk-resultat": { model: "claude-sonnet-5", effort: "medium" },
  // Uten effort, av samme grunn som `balanced` over — dette ER default-veien
  // for enhver klient som ikke sender `quality`.
  "svar": { model: "claude-sonnet-5" },
};

/** Env-navnet som overstyrer modellen for dette kallstedet, i prioritert rekkefølge. */
function envKeysFor(site: CallSite): string[] {
  if (site === "svar") return ["SVAR_MODEL", "ANTHROPIC_MODEL"];
  return ["ANTHROPIC_MODEL"];
}

/**
 * Velg modell + effort. `env` injiseres slik at testene aldri rører Denos miljøoppslag.
 *
 * Merk at en env-overstyring bytter MODELLEN, ikke effort-nivået: driftaren
 * som pinner en modell mener ikke dermed at brukerens kvalitetsvalg skal
 * ignoreres. Unntaket er picker, som aldri har effort uansett.
 */
export function chooseModel(
  site: CallSite,
  quality: Quality | null,
  env: (k: string) => string | undefined,
): ModelChoice {
  const base = quality ? TIERS[quality] : DEFAULTS[site];
  let model = base.model;
  for (const key of envKeysFor(site)) {
    const v = env(key);
    if (v) { model = v; break; }
  }
  return base.effort === undefined ? { model } : { model, effort: base.effort };
}

// ── resolveLlm ────────────────────────────────────────────────────────────
// Nøkkel + modell + effort + leverandør, avgjort ETT sted for alle fem
// endepunktene. Grunnen til at dette ikke gjentas per handler er invarianten
// under, som er en sikkerhetsfeil og ikke en stilsak:
//
//   En X-Llm-Key ALENE beviser ingenting. Den er leverandør-agnostisk og blir
//   aldri validert av porten (auth.ts kan ikke vite hvem den tilhører). En
//   handler som godtar allowLlmKey MÅ derfor avvise enhver forespørsel uten
//   komplett provider-config — ellers autentiserer en vilkårlig streng seg
//   inn og faller gjennom til serverens egen ANTHROPIC_API_KEY. Det er en
//   anonym bypass av hele BYOK-modellen, og den ville se ut som en vanlig
//   vellykket forespørsel i loggen.
//
// askstat håndhever den i én handler; microdata har fem, så den bor her.

import { extractByokKey, extractLlmKey, timingSafeEqual } from "./auth.ts";
import { type ProviderConfig, parseProviderConfig } from "./providers/config.ts";

export interface LlmChoice {
  apiKey: string;
  model: string;
  effort?: string;
  provider?: ProviderConfig;
}

/**
 * Returnerer valget, eller en ferdig feilrespons som handleren skal
 * returnere uendret (400 ugyldig leverandør / 401 bypass-forsøk / 500
 * manglende servernøkkel).
 *
 * NB for kallstedet: på leverandørveien er `provider.model` sannheten —
 * `choice.model` gjelder kun den anthropic-native veien. streamProvider
 * leser derfor aldri choice.model.
 */
export function resolveLlm(
  request: Request,
  body: { provider?: unknown; quality?: unknown },
  site: CallSite,
  env: (k: string) => string | undefined,
): LlmChoice | Response {
  const parsed = parseProviderConfig(body.provider, request);
  if (parsed && "error" in parsed) return parsed.error;
  const provider: ProviderConfig | undefined = parsed ?? undefined;

  const byokKey = extractByokKey(request);
  // Invarianten. Rekkefølgen er med vilje: en gyldig BYOK-nøkkel er nok i seg
  // selv, så den sjekkes først; det er BARE llm-key-uten-config som er farlig.
  if (!byokKey && extractLlmKey(request) && !provider) {
    return new Response(
      "X-Llm-Key krever komplett leverandørkonfigurasjon (provider-feltet i forespørselen)",
      { status: 401 },
    );
  }

  // To passord → to servernøkler: matcher Bearer-tokenet det PERSONLIGE
  // passordet, brukes ANTHROPIC_API_KEY_PERSONAL i stedet for den delte
  // nøkkelen. Porten har allerede autentisert forespørselen — her klassifiseres
  // den bare. Mangler den personlige nøkkelen er det 500, ALDRI stille
  // fallback til den delte (feil regning er verre enn feilmelding).
  const authHeader = request.headers.get("authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const personalPass = env("M2PY_ACCESS_TOKEN_PERSONAL");
  let serverKey = env("ANTHROPIC_API_KEY");
  if (
    !provider && !byokKey && personalPass && bearer &&
    timingSafeEqual(bearer, personalPass)
  ) {
    serverKey = env("ANTHROPIC_API_KEY_PERSONAL");
    if (!serverKey) {
      console.error("ANTHROPIC_API_KEY_PERSONAL is not set");
      return new Response("Server configuration error", { status: 500 });
    }
  }

  const apiKey = provider?.key ?? byokKey ?? serverKey;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not set");
    return new Response("Server configuration error", { status: 500 });
  }

  const choice = chooseModel(site, coerceQuality(body.quality), env);
  return provider
    ? { apiKey, model: choice.model, effort: choice.effort, provider }
    : { apiKey, model: choice.model, effort: choice.effort };
}
