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

export type CallSite =
  | "kode-svar"
  | "kode-svar-v2"
  | "picker"
  | "dm-vurder"
  | "tolk-resultat"
  | "data-svar";

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
  balanced: { model: "claude-sonnet-5", effort: "high" },
  best: { model: "claude-opus-5", effort: "xhigh" },
};

// Per kallsted når brukeren ikke har valgt noe. tolk-resultat tolker output
// som ALLEREDE er beregnet — den trenger ikke samme dybde som kodegenerering.
const DEFAULTS: Record<CallSite, ModelChoice> = {
  "kode-svar": { model: "claude-sonnet-5", effort: "high" },
  "kode-svar-v2": { model: "claude-sonnet-5", effort: "high" },
  "picker": { model: "claude-haiku-4-5" },
  "dm-vurder": { model: "claude-sonnet-5", effort: "high" },
  "tolk-resultat": { model: "claude-sonnet-5", effort: "medium" },
  "data-svar": { model: "claude-sonnet-5", effort: "high" },
};

/** Env-navnet som overstyrer modellen for dette kallstedet, i prioritert rekkefølge. */
function envKeysFor(site: CallSite): string[] {
  if (site === "picker") return ["PICKER_MODEL"];
  if (site === "data-svar") return ["DATA_SVAR_MODEL", "ANTHROPIC_MODEL"];
  return ["ANTHROPIC_MODEL"];
}

/**
 * Velg modell + effort. `env` injiseres slik at testene aldri rører Deno.env.
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
  // picker er sitt eget spor: alltid det billige passet, aldri effort.
  if (site === "picker") {
    const override = env("PICKER_MODEL");
    return { model: override || DEFAULTS.picker.model };
  }

  const base = quality ? TIERS[quality] : DEFAULTS[site];
  let model = base.model;
  for (const key of envKeysFor(site)) {
    const v = env(key);
    if (v) { model = v; break; }
  }
  return base.effort === undefined ? { model } : { model, effort: base.effort };
}
