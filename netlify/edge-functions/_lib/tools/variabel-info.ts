// variabel_info tool: on-demand detalj for registervariabler — full beskrivelse,
// type, temporalitet og kodeliste. Erstatter kode-svar-v2s eget picker-pass
// (samlet svar-pipeline, spec 2026-08-28 §2): modellen slår opp når den
// trenger det, i stedet for at et eget Haiku-pass gjetter utvalget på forhånd.
// Datakildene er de samme statiske filene nettstedet serverer
// (variable_metadata.json, codelists/<NAVN>.json), hentet samme-origin med
// in-isolat-cache — samme mønster som prefiks.ts.

interface VariabelMeta {
  type?: string;
  data_type?: string;
  microdata_datatype?: string;
  description?: string;
  short_title?: string;
  temporalitet?: string;
  enhetstype?: string;
  keywords?: string[];
}

export interface VariabelInfoDeps {
  fetchImpl?: typeof fetch;
}

const MAX_TREFF = 10;
const MAX_SVAR = 8000;
const MAX_KODER = 80;

let _metaCache: { origin: string; vars: Record<string, VariabelMeta> } | null = null;

/** Kun for tester: nullstill in-isolat-cachen. */
export function _resetVariabelCache(): void {
  _metaCache = null;
}

async function hentVars(
  origin: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, VariabelMeta>> {
  if (_metaCache && _metaCache.origin === origin) return _metaCache.vars;
  const resp = await fetchImpl(`${origin}/variable_metadata.json`);
  if (!resp.ok) throw new Error(`variable_metadata.json: HTTP ${resp.status}`);
  const json = await resp.json();
  const vars = (json?.variables ?? {}) as Record<string, VariabelMeta>;
  _metaCache = { origin, vars };
  return vars;
}

function detaljBlokk(navn: string, m: VariabelMeta): string {
  const linjer = [
    `## ${navn} — ${m.short_title ?? ""}`.trimEnd(),
    m.description ? m.description : "",
    `Type: ${m.type ?? "?"} · Datatype: ${m.microdata_datatype ?? m.data_type ?? "?"} · ` +
      `Temporalitet: ${m.temporalitet ?? "?"} · Enhetstype: ${m.enhetstype ?? "?"}`,
  ];
  return linjer.filter(Boolean).join("\n");
}

function kodelisteBlokk(json: unknown): string {
  const labels = (json as { labels?: Record<string, string> })?.labels;
  if (!labels || typeof labels !== "object") return "";
  const entries = Object.entries(labels);
  const viste = entries.slice(0, MAX_KODER).map(([k, v]) => `  ${k} = ${v}`);
  const hale = entries.length > MAX_KODER
    ? `  … ${entries.length - MAX_KODER} koder til (avkortet)`
    : "";
  return ["KODELISTE:", ...viste, hale].filter(Boolean).join("\n");
}

function cap(s: string): string {
  return s.length > MAX_SVAR ? s.slice(0, MAX_SVAR) + "\n[…avkortet]" : s;
}

/**
 * Eksakt navn → detaljblokk (+ kodeliste når /codelists/<NAVN>.json finnes);
 * ellers case-insensitivt substring-søk over navn/beskrivelse/nøkkelord →
 * inntil 10 énlinjes treff. Kaster aldri på «ikke funnet» — modellen skal få
 * et ærlig svar, ikke en verktøyfeil.
 */
export async function variabelInfo(
  origin: string,
  navnEllerSok: string,
  deps: VariabelInfoDeps = {},
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sok = (navnEllerSok ?? "").trim();
  if (!sok) return "Ingen variabel matcher (tomt søk). Oppgi variabelnavn eller søkeord.";
  const vars = await hentVars(origin, fetchImpl);

  const eksakt = vars[sok] ?? vars[sok.toUpperCase()];
  if (eksakt) {
    const navn = vars[sok] ? sok : sok.toUpperCase();
    let blokk = detaljBlokk(navn, eksakt);
    try {
      const kl = await fetchImpl(`${origin}/codelists/${navn}.json`);
      if (kl.ok) {
        const klBlokk = kodelisteBlokk(await kl.json());
        if (klBlokk) blokk += "\n" + klBlokk;
      }
    } catch (_e) {
      // kodeliste er bonus — detaljblokken står seg alene
    }
    return cap(blokk);
  }

  const q = sok.toLowerCase();
  const treff = Object.entries(vars).filter(([navn, m]) =>
    navn.toLowerCase().includes(q) ||
    (m.description ?? "").toLowerCase().includes(q) ||
    (m.short_title ?? "").toLowerCase().includes(q) ||
    (m.keywords ?? []).some((k) => k.toLowerCase().includes(q))
  ).slice(0, MAX_TREFF);
  if (treff.length === 0) {
    return `Ingen variabel matcher «${sok}». Prøv et annet søkeord, eller sjekk katalogen i systemreferansen.`;
  }
  const linjer = treff.map(([navn, m]) =>
    `${navn} — ${m.short_title ?? ""} (${m.enhetstype ?? "?"}, ${m.temporalitet ?? "?"})`
  );
  return cap(
    `Treff på «${sok}» (${treff.length}${treff.length === MAX_TREFF ? "+" : ""}):\n` +
      linjer.join("\n") +
      "\nKall variabel_info med eksakt navn for detaljer og kodeliste.",
  );
}
