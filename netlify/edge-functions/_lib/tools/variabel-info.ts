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
  databank?: string;
  populasjon?: string;
  full_beskrivelse?: string;
  databank_min_versjon?: number;
  nokkel_for?: string;
  external_metadata?: string;
  codelist_size?: number;
  labels?: Record<string, string>;
}

export interface VariabelInfoDeps {
  fetchImpl?: typeof fetch;
}

const MAX_TREFF = 10;
const MAX_SVAR = 8000;
const MAX_KODER = 80;
const MAX_KODE_TREFF = 60;

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
    m.full_beskrivelse ? `Om variabelen: ${m.full_beskrivelse}` : "",
    m.databank_min_versjon ? `Finnes fra databankversjon ${m.databank_min_versjon} (require ${m.databank ?? "no.ssb.fdb"}:${m.databank_min_versjon} eller nyere).` : "",
    `Type: ${m.type ?? "?"} · Datatype: ${m.microdata_datatype ?? m.data_type ?? "?"} · ` +
      `Temporalitet: ${m.temporalitet ?? "?"} · Enhetstype: ${m.enhetstype ?? "?"}` +
      (m.databank ? ` · Databank: ${m.databank}` : ""),
    m.nokkel_for ? `Nøkkelvariabel for: ${m.nokkel_for}` : "",
    m.populasjon ? `Populasjon: ${m.populasjon}` : "",
  ];
  return linjer.filter(Boolean).join("\n");
}

function kodelisteBlokk(json: unknown, kodeSok = ""): string {
  const labels = (json as { labels?: Record<string, string> })?.labels;
  if (!labels || typeof labels !== "object") return "";
  // Valgfri gyldighet per kode ({kode: [fraÅr, tilÅr|null]}) — årsavhengige
  // kodeverk som grunnkrets (følger kommunereformene).
  const gyldig = (json as { gyldig?: Record<string, [number, number | null]> })?.gyldig;
  const linje = ([k, v]: [string, string]) => {
    const g = gyldig?.[k];
    return g ? `  ${k} = ${v} (${g[0]}–${g[1] ?? ""})` : `  ${k} = ${v}`;
  };
  const entries = Object.entries(labels);
  const q = kodeSok.trim().toLowerCase();
  if (q) {
    // Kode-prefiks ELLER fritekst i etiketten (case-insensitivt). Prefiks-treff
    // først, så de mest spesifikke koden-familiene kommer øverst.
    const prefiks = entries.filter(([k]) => k.toLowerCase().startsWith(q));
    const tekst = entries.filter(([k, v]) =>
      !k.toLowerCase().startsWith(q) && String(v).toLowerCase().includes(q)
    );
    const treff = [...prefiks, ...tekst];
    if (treff.length === 0) {
      return `KODELISTE (${entries.length} koder): ingen koder matcher «${kodeSok}». ` +
        "Prøv et kortere kode-prefiks eller et annet ord.";
    }
    const viste = treff.slice(0, MAX_KODE_TREFF).map(linje);
    const hale = treff.length > MAX_KODE_TREFF
      ? `  … ${treff.length - MAX_KODE_TREFF} treff til (avkortet — snevre inn søket)`
      : "";
    return [`KODELISTE — treff på «${kodeSok}» (${treff.length} av ${entries.length}):`, ...viste, hale]
      .filter(Boolean).join("\n");
  }
  const viste = entries.slice(0, MAX_KODER).map(linje);
  const hale = entries.length > MAX_KODER
    ? `  … ${entries.length - MAX_KODER} koder til (avkortet — bruk kode_sok med kode-prefiks eller ord)`
    : "";
  return [`KODELISTE (${entries.length} koder):`, ...viste, hale].filter(Boolean).join("\n");
}

/** Kodelistefil for variabelen: external_metadata-pekeren (kan være delt
 *  mellom flere variabler, f.eks. NPR_ICD10), ellers codelists/<NAVN>.json. */
function kodelisteSti(navn: string, m: VariabelMeta): string {
  const ext = String(m.external_metadata ?? "").trim();
  if (/^codelists\/[A-Za-z0-9_]+\.json$/.test(ext)) return `/${ext}`;
  return `/codelists/${navn}.json`;
}

function cap(s: string): string {
  return s.length > MAX_SVAR ? s.slice(0, MAX_SVAR) + "\n[…avkortet]" : s;
}

/**
 * Eksakt navn → detaljblokk (+ kodeliste når kodelistefilen finnes; med
 * `kodeSok` filtreres kodelisten på kode-prefiks eller etikett-tekst, og
 * inline-etiketter i katalogen søkes når ingen fil finnes);
 * ellers case-insensitivt substring-søk over navn/beskrivelse/nøkkelord →
 * inntil 10 énlinjes treff. Kaster aldri på «ikke funnet» — modellen skal få
 * et ærlig svar, ikke en verktøyfeil.
 */
export async function variabelInfo(
  origin: string,
  navnEllerSok: string,
  deps: VariabelInfoDeps = {},
  kodeSok = "",
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sok = (navnEllerSok ?? "").trim();
  if (!sok) return "Ingen variabel matcher (tomt søk). Oppgi variabelnavn eller søkeord.";
  const vars = await hentVars(origin, fetchImpl);

  const eksakt = vars[sok] ?? vars[sok.toUpperCase()];
  if (eksakt) {
    const navn = vars[sok] ? sok : sok.toUpperCase();
    let blokk = detaljBlokk(navn, eksakt);
    let klBlokk = "";
    try {
      const kl = await fetchImpl(`${origin}${kodelisteSti(navn, eksakt)}`);
      if (kl.ok) klBlokk = kodelisteBlokk(await kl.json(), kodeSok);
    } catch (_e) {
      // kodeliste er bonus — detaljblokken står seg alene
    }
    if (!klBlokk && eksakt.labels && Object.keys(eksakt.labels).length > 0) {
      klBlokk = kodelisteBlokk({ labels: eksakt.labels }, kodeSok);
    }
    if (klBlokk) blokk += "\n" + klBlokk;
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
