// table_metadata tool: variable-level lookup for a catalog hit, so the model
// can build a MINIMAL query URL (spec: build datasets from variables).
import { findSource, type DataSource } from "../registry.ts";
import { guardedFetchImpl } from "../ssrf.ts";

export interface TableVariable {
  code: string;
  label: string;
  time: boolean;
  values: { code: string; label: string }[];
  valuesTruncated: boolean;
}

export interface TableMeta {
  source: string;
  id: string;
  title: string;
  variables: TableVariable[];
  queryUrlTemplate?: string;
}

const MAX_VALUES = 40;

// Strukturell sjekk av table_id FØR den bygges inn i en URL (port fra
// openstat, review 2026-09-26). data-svar sin table_metadata-tool gir
// modellens table_id rett hit; ".." / "?" / "#" / skjema-tegn ville ellers
// kunne styre forespørselen til andre stier på kildens vert. Første tegn
// alfanumerisk; resten et tegnsett som dekker reelle id-former.
const TABLE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9/_.@,-]*$/;
export function isValidTableId(s: string): boolean {
  if (!s || s.length > 128) return false;
  if (!TABLE_ID_RE.test(s)) return false;
  if (s.includes("..")) return false;
  return true;
}

export async function tableMetadata(
  sourceId: string,
  tableId: string,
  deps: { registry: DataSource[]; fetchImpl?: typeof fetch },
): Promise<TableMeta> {
  const src = findSource(deps.registry, sourceId);
  if (!src) throw new Error(`ukjent kilde '${sourceId}'`);
  if (!isValidTableId(tableId)) throw new Error(`ugyldig table_id '${tableId.slice(0, 80)}'`);
  if (src.tilgang !== "pxweb") {
    throw new Error(
      `table_metadata støtter bare pxweb-kilder ennå — for '${sourceId}': bruk probe på data-URL-en for å se kolonner`,
    );
  }
  // Timeout + byte-tak + SSRF-sjekk per hop (se guardedFetchImpl i ssrf.ts).
  const f = guardedFetchImpl(deps.fetchImpl ?? fetch);
  const url = new URL(`tables/${tableId}/metadata?lang=no`, src.base_url).toString();
  const res = await f(url);
  if (!res.ok) throw new Error(`metadata for ${sourceId}/${tableId} feilet: HTTP ${res.status}`);
  const json = await res.json();

  const dims = (json?.dimension ?? {}) as Record<string, {
    label?: string;
    category?: { index?: Record<string, number>; label?: Record<string, string> };
  }>;
  const timeDims = new Set<string>((json?.role?.time ?? []) as string[]);
  const variables: TableVariable[] = Object.entries(dims).map(([code, d]) => {
    const labels = d.category?.label ?? {};
    const codes = Object.keys(d.category?.index ?? labels);
    const values = codes.slice(0, MAX_VALUES).map((c) => ({ code: c, label: labels[c] ?? c }));
    return {
      code,
      label: d.label ?? code,
      time: timeDims.has(code),
      values,
      valuesTruncated: codes.length > MAX_VALUES,
    };
  });

  return {
    source: sourceId,
    id: tableId,
    title: String(json?.label ?? tableId),
    variables,
    queryUrlTemplate: src.sporrings_url_mal?.replace("{id}", tableId),
  };
}
