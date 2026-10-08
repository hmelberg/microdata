// Felles 400-tolking for de to OpenAI-formene (review-runden 2026-10-08).
// Egne leverandører er vilkårlige: DeepSeek tar maks 8192 output-tokens,
// gpt-4o/4o-mini 16384, og ikke-resonnerende modeller avviser effort. I stedet
// for å kjenne hver modell, tolker vi 400-detaljen og prøver ÉN gang til med
// noe leverandøren faktisk godtar.

/** Default output-tak for egne leverandører. Anthropic-løpet bruker 32000
 * (se svar-lop.ts), men det avvises av mange OpenAI-kompatible modeller.
 * 16384 er gpt-4o-familiens tak; lavere tak fanges av retry-en under. */
export const EGEN_LEVERANDOR_MAX_TOKENS = 16384;

/** 400 som handler om output-taket (for høyt, utenfor gyldig område). */
export function erTokenTakFeil(detail: string): boolean {
  return /max_(?:completion_|output_)?tokens|token limit|maximum context length|(?:at most|maximum(?: of)?) \d+ (?:\w+ )?tokens/i
    .test(detail);
}

/** Øvre grense oppgitt i feilmeldingen («at most 16384», «[1, 8192]»), ellers null. */
export function tokenTakFraFeil(detail: string): number | null {
  const m = /(?:at most|maximum(?: value)?(?: of| is)?|range of \w+ is \[\s*\d+\s*,|<=)\s*(\d{3,7})/i.exec(detail);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Body for ETT nytt forsøk etter en token-tak-400: senk taket til det
 * feilmeldingen oppgir, ellers utelat parameteren (leverandørens default er
 * alltid gyldig). null når det ikke er noe å endre.
 */
export function senketTak(
  body: Record<string, unknown>,
  felt: string,
  detail: string,
): Record<string, unknown> | null {
  if (!(felt in body)) return null;
  const naa = Number(body[felt]);
  const tak = tokenTakFraFeil(detail);
  const ny: Record<string, unknown> = { ...body };
  if (tak !== null && tak < naa) ny[felt] = tak;
  else delete ny[felt];
  return ny;
}

/** 400 som handler om resonneringsnivået (modellen er ikke en resonnerer). */
export function erEffortFeil(detail: string): boolean {
  return /reasoning|effort/i.test(detail);
}
