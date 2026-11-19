#!/usr/bin/env python3
"""Hent og bygg katalogmetadata for FHI-databankene på microdata.no.

Databanker:
  no.fhi.npr              — Norsk pasientregister (somatiske sykehus)
  no.fhi.kreftregisteret  — Kreftregisteret

To steg:

  python3 tools/fhi_metadata.py fetch [--cache DIR]
      Laster ned variabelsidene fra microdata.no/discovery og lagrer den
      innebygde JSON-en (__NEXT_DATA__ → props.pageProps.ds) per variabel i
      cache-katalogen (default: .cache/fhi_raw — ikke versjonert).

  python3 tools/fhi_metadata.py build [--cache DIR]
      Leser cachen og skriver
        * oppføringer i variable_metadata.json (erstatter alle eksisterende
          oppføringer med databank no.fhi.*), og
        * codelists/<NAVN>.json for kodelister med mer enn INLINE_MAX koder
          (ICD-10, prosedyrekoder, morfologi …). Disse lastes lat: prompten
          viser bare et utvalg + antall, og variabel_info-verktøyet søker i
          den fulle listen ved behov.

Kodelistene på microdata.no er versjonert (første versjon + delta per
periode). Vi bygger UNIONEN av alle koder over alle perioder (siste
etikett vinner), slik at både gamle og nye koder kan slås opp.

Variabellisten under er hentet fra variabeloversikten 2026-11-19. Nye
variabler legges til i NPR_VARS / KRG_VARS og bygges på nytt.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
META_PATH = ROOT / "variable_metadata.json"
CODELIST_DIR = ROOT / "codelists"
DEFAULT_CACHE = ROOT / ".cache" / "fhi_raw"

BANK_VERSION = "1"
NPR_BANK = "no.fhi.npr"
KRG_BANK = "no.fhi.kreftregisteret"

NPR_VARS = [
    "SOM_EP_AAR", "SOM_EP_HOVEDTILSTAND1", "SOM_EP_HOVEDTILSTAND2",
    "SOM_EP_INNDATO", "SOM_EP_INNMATEHAST", "SOM_EP_OMSORGSNIVA",
    "SOM_EP_PERSONID", "SOM_EP_SH_REG", "SOM_EP_UTDATO",
    "SOM_PROS_EPISODEID", "SOM_PROS_PERSONID", "SOM_PROS_PROSEDYREKODE",
]
KRG_VARS = [
    "P_PERSONIDMICRODATA", "P_PERSONSTATUS", "P_STATUSAR",
    "S_ALDERDIAGNOSE", "S_ANNENBEH", "S_BASIS", "S_CM", "S_CN", "S_CT",
    "S_DIAGNOSEAR", "S_DIAGNOSEDATO", "S_DS", "S_HELSEREGION", "S_HORMONBEH",
    "S_KIR", "S_KJEMO", "S_LOKICD7", "S_LOKICD7SPES", "S_MORFOLOGIICDO3",
    "S_MORFOLOGISKGRAD", "S_MORFOLOGISKVERIFISERT", "S_PM", "S_PN", "S_PT",
    "S_SEERSTADIUM", "S_SIDE", "S_STRALEBEH", "S_TOPOGRAFIICD10",
    "S_TOPOGRAFIICDO3", "S_TUMORATFERD",
]

# Variabler som deler én kodelistefil (samme kodeverk). Filen inneholder bare
# {"kodeverk", "labels"} og slås sammen inn i hver variabel ved lat lasting.
SHARED_CODELIST = {
    "SOM_EP_HOVEDTILSTAND1": "NPR_ICD10",
    "SOM_EP_HOVEDTILSTAND2": "NPR_ICD10",
}
KODEVERK = {
    "NPR_ICD10": "ICD-10 (norsk versjon, koder uten punktum)",
    "SOM_PROS_PROSEDYREKODE": "NCMP/NCSP/NCRP prosedyrekoder",
    "S_TOPOGRAFIICD10": "ICD-10 (kreftsete)",
    "S_TOPOGRAFIICDO3": "ICD-O-3 topografi",
    "S_MORFOLOGIICDO3": "ICD-O-3 morfologi",
    "S_LOKICD7": "ICD-7 (Kreftregisterets lokalisasjon)",
    "S_LOKICD7SPES": "ICD-7 (Kreftregisterets lokalisasjon, spesifisert)",
}

# Kuraterte utvalg for katalograden (viser kodeformat + vanlige koder). Andre
# store lister får et jevnt fordelt utvalg (_sample).
_ICD10_SAMPLE = ["A099", "C509", "E119", "F329", "I10", "I219", "I489", "J189", "J449", "S720", "U071", "Z380"]
SAMPLE_CODES = {
    "SOM_EP_HOVEDTILSTAND1": _ICD10_SAMPLE,
    "SOM_EP_HOVEDTILSTAND2": _ICD10_SAMPLE,
    "SOM_PROS_PROSEDYREKODE": ["JKA21", "NFB40", "NGB20", "JFB30", "LCD10"],
    "S_TOPOGRAFIICD10": ["C18", "C189", "C20", "C25", "C34", "C349", "C43", "C50", "C509", "C61", "C64", "D059"],
}

# Kodelister med flere koder enn dette legges i codelists/<NAVN>.json.
INLINE_MAX = 40
SAMPLE_SIZE = 8

# Kuraterte bruksnotater som modellen ikke kan lese ut av metadataen alene.
# Legges til i beskrivelsen (og dermed i katalograden + variabel_info).
HINTS = {
    "SOM_EP_AAR": "Streng ('2016'–'2025'). Bruk til å avgrense ved import: values(\"2023\").",
    "SOM_EP_HOVEDTILSTAND1": "ICD-10-kode UTEN punktum, 3–5 tegn (f.eks. 'I219', 'E119', 'C509'). Grupper på kategori med substr(x, 1, 3).",
    "SOM_EP_HOVEDTILSTAND2": "Sekundær hovedtilstand; ICD-10-kode UTEN punktum som HOVEDTILSTAND1. Ofte missing.",
    "SOM_EP_INNDATO": "Dato-verdi (Instant). Bruk datofunksjoner: year(), month(), isoformatdate().",
    "SOM_EP_UTDATO": "Dato-verdi (Instant). Liggetid = utdato - inndato (dager).",
    "SOM_EP_PERSONID": "Person-ref: kobler episoden til person (samme ID som PERSONID_1 i SSB-data). Bruk values_from(<persondatasett>) for å hente episoder bare for en gitt populasjon.",
    "SOM_PROS_PERSONID": "Person-ref: kobler prosedyren til person.",
    "SOM_PROS_EPISODEID": "Episode-ref: kobler prosedyren til NPR-episoden (verdien er episodens ID).",
    "SOM_PROS_PROSEDYREKODE": "Prosedyrekode (NCMP/NCSP/NCRP), 5–7 tegn (f.eks. 'JKA21' laparoskopisk kolecystektomi).",
    "P_PERSONIDMICRODATA": "Person-ref: kobler krefttilfellet til person (samme ID som PERSONID_1 i SSB-data).",
    "P_STATUSAR": "Årstall (streng) for død/emigrasjon/slutt på oppfølging.",
    "S_DIAGNOSEAR": "Diagnoseår som heltall — bruk til å avgrense krefttilfeller i tid.",
    "S_DIAGNOSEDATO": "Dato-verdi (Instant). Bruk year()/month().",
    "S_TOPOGRAFIICD10": "ICD-10 kreftsete UTEN punktum (f.eks. 'C50' bryst, 'C61' prostata, 'C18'–'C20' tarm, 'C34' lunge). Grupper med substr(x, 1, 3).",
    "S_TOPOGRAFIICDO3": "ICD-O-3 topografi uten punktum (f.eks. 'C509').",
    "S_MORFOLOGIICDO3": "ICD-O-3 morfologi, 5 sifre: 4 sifre histologi + 1 siffer atferd (3 = malign).",
    "S_LOKICD7": "Kreftsete etter ICD-7 (Kreftregisterets historiske hovedkode).",
}

DTYPE_MAP = {
    "String": ("string", "Alfanumerisk"),
    "Long": ("int", "Numerisk (Heltall)"),
    "Double": ("float", "Numerisk (Desimaltall)"),
    "Instant": ("date:epoch", "Dato (Instant)"),
}
TEMPORALITY = {"FIXED": "Fast", "STATUS": "Tverrsnitt", "ACCUMULATED": "Akkumulert", "EVENT": "Forløp"}

_STOP = {
    "somatiske", "sykehus", "episode", "prosedyre", "knyttet", "ved", "til", "for",
    "og", "med", "som", "den", "det", "av", "på", "eller", "mer", "informasjon",
    "variabelen", "gå", "inn", "besøk", "kreftregisterets", "metadatabase",
}

VAR_KEYWORDS = {
    "SOM_EP_HOVEDTILSTAND1": ["diagnose", "hoveddiagnose", "icd-10", "icd10"],
    "SOM_EP_HOVEDTILSTAND2": ["diagnose", "bidiagnose", "icd-10", "icd10"],
    "SOM_PROS_PROSEDYREKODE": ["prosedyrekode", "operasjon", "ncmp", "ncsp", "kirurgi"],
    "SOM_EP_INNDATO": ["innleggelse", "dato"],
    "SOM_EP_UTDATO": ["utskrivning", "dato", "liggetid"],
    "SOM_EP_OMSORGSNIVA": ["døgn", "poliklinisk", "dagbehandling", "innleggelse"],
    "S_TOPOGRAFIICD10": ["kreftform", "kreftsete", "icd-10", "diagnose"],
    "S_DIAGNOSEDATO": ["dato", "kreftdiagnose"],
    "P_PERSONSTATUS": ["overlevelse", "død"],
}

EXTRA_KEYWORDS = {
    NPR_BANK: ["npr", "pasientregister", "sykehus", "helse"],
    KRG_BANK: ["kreft", "kreftregisteret", "krg", "helse"],
}


def _url(bank: str, name: str) -> str:
    return f"https://microdata.no/discovery/variable/{bank}/{BANK_VERSION}/{name}"


def fetch(cache: Path) -> None:
    cache.mkdir(parents=True, exist_ok=True)
    for bank, names in ((NPR_BANK, NPR_VARS), (KRG_BANK, KRG_VARS)):
        for name in names:
            req = urllib.request.Request(_url(bank, name), headers={"User-Agent": "Mozilla/5.0"})
            html = urllib.request.urlopen(req, timeout=60).read().decode("utf-8")
            m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
            if not m:
                raise SystemExit(f"{name}: fant ikke __NEXT_DATA__ på {_url(bank, name)}")
            ds = json.loads(m.group(1))["props"]["pageProps"].get("ds")
            if not ds:
                raise SystemExit(f"{name}: tom variabelside (feil navn eller databankversjon?)")
            (cache / f"{name}.json").write_text(
                json.dumps({"bank": bank, "ds": ds}, ensure_ascii=False), encoding="utf-8")
            print(f"hentet {bank}/{name}")
            time.sleep(0.3)


def _clean_description(text: str) -> str:
    """Fjern «For mer informasjon …»-setninger og markdown-lenker."""
    text = re.sub(r"For mer informasjon[^\n]*", "", text or "")
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    keep = []
    for line in re.split(r"\n+", text):
        line = line.strip()
        if not line or line.lower().startswith("for mer informasjon"):
            continue
        keep.append(line)
    return re.sub(r"\s+", " ", " ".join(keep)).strip()


def _union_codelist(represented: list[dict]) -> tuple[dict[str, str], list[str]]:
    """Union av alle koder over alle perioder; siste etikett vinner."""
    labels: dict[str, str] = {}
    missing: list[str] = []
    for rv in represented:
        vd = rv.get("valueDomain") or {}
        for entry in vd.get("codeList") or []:
            labels[str(entry["code"])] = re.sub(r"\s+", " ", str(entry["category"])).strip()
        delta = vd.get("delta") or {}
        for bucket in ("insert", "replace"):
            for entry in (delta.get(bucket) or {}).values():
                if isinstance(entry, dict) and "code" in entry:
                    labels[str(entry["code"])] = re.sub(r"\s+", " ", str(entry["category"])).strip()
        for mv in vd.get("missingValues") or []:
            if str(mv) not in missing:
                missing.append(str(mv))
    return labels, missing


def _sort_codes(labels: dict[str, str]) -> dict[str, str]:
    def key(code: str):
        return (0, int(code), code) if re.fullmatch(r"-?\d+", code) else (1, 0, code)
    return {k: labels[k] for k in sorted(labels, key=key)}


def _sample(labels: dict[str, str], missing: list[str]) -> dict[str, str]:
    """Jevnt fordelt utvalg av gyldige koder — viser kodeformatet over hele listen."""
    valid = [k for k, v in labels.items()
             if k not in missing and not v.lower().startswith(("ugyldig", "ikke rapportert"))]
    if len(valid) <= SAMPLE_SIZE:
        picks = valid
    else:
        step = len(valid) / SAMPLE_SIZE
        picks = [valid[int(i * step + step / 2)] for i in range(SAMPLE_SIZE)]
    return {k: labels[k] for k in picks}


def _keywords(bank: str, label: str, desc: str) -> list[str]:
    words = re.findall(r"[a-zæøåA-ZÆØÅ0-9-]{3,}", f"{label} {desc}".lower())
    out = {w for w in words if w not in _STOP and not w.isdigit()}
    out.update(EXTRA_KEYWORDS[bank])
    return sorted(out)


def _iso(days: int | None) -> str | None:
    if days is None:
        return None
    return (_dt.date(1970, 1, 1) + _dt.timedelta(days=int(days))).isoformat()


def _updated(value) -> str | None:
    """updatedAt er epoch-sekunder (eldre sider: ISO-streng)."""
    if isinstance(value, (int, float)):
        return _dt.datetime.fromtimestamp(value, _dt.timezone.utc).date().isoformat()
    return str(value)[:10] if value else None


def build_entry(bank: str, ds: dict) -> tuple[dict, dict | None]:
    mv = ds["measureVariable"]
    represented = mv.get("representedVariables") or []
    latest = represented[-1] if represented else {}
    name = mv["name"]
    data_type, micro_dt = DTYPE_MAP.get(mv.get("dataType"), ("string", str(mv.get("dataType"))))
    temporalitet = TEMPORALITY.get(ds.get("temporality"), ds.get("temporality") or "")
    ident = (ds.get("identifierVariables") or [{}])[0]
    enhetstype = ((ident.get("keyType") or {}).get("label")) or "Person"

    desc = _clean_description(latest.get("description", "")) or mv.get("label", name)
    if not desc.endswith("."):
        desc += "."
    keywords = sorted(set(_keywords(bank, mv.get("label", ""), desc)) | set(VAR_KEYWORDS.get(name, [])))
    hint = HINTS.get(name)
    if hint:
        # Hintet først: katalograden kapper beskrivelsen ved ~200 tegn.
        desc = f"{hint} {desc}"
    key_for = (mv.get("keyType") or {}).get("label")
    if key_for:
        desc = f"{desc} Nøkkelvariabel for: {key_for}."
    # Gyldighetsperiode ∞ (som på microdata.no) — Fast-variabler importeres uten dato.
    description = (f"{desc} Enhetstype: {enhetstype}. Temporalitet: {temporalitet}. "
                   f"Gyldighetsperiode: ∞.")

    entry: dict = {
        "type": "register",
        "data_type": data_type,
        "description": description,
        "short_title": mv.get("label", name),
        "temporalitet": temporalitet,
        "enhetstype": enhetstype,
        "microdata_datatype": micro_dt,
        "updated_at": _updated(ds.get("updatedAt")),
        "databank": bank,
        "topics": ds.get("subjectFields") or [],
        "keywords": keywords,
        "populasjon": re.sub(r"\s+", " ", ds.get("populationDescription") or "").strip() or None,
        "enhet_id": ident.get("name"),
        "source_url": _url(bank, name),
    }
    if key_for:
        entry["nokkel_for"] = key_for
    if data_type == "date:epoch":
        entry["date_years"] = [2016, 2025] if bank == NPR_BANK else [1953, 2025]

    labels, missing = _union_codelist(represented)
    codelist = None
    if labels:
        labels = _sort_codes(labels)
        if missing:
            entry["missing_values"] = missing
        if len(labels) <= INLINE_MAX:
            entry["labels"] = labels
        else:
            file_id = SHARED_CODELIST.get(name, name)
            entry["external_metadata"] = f"codelists/{file_id}.json"
            entry["codelist_size"] = len(labels)
            picks = [c for c in SAMPLE_CODES.get(name, []) if c in labels]
            entry["labels_sample"] = ({c: labels[c] for c in picks} if picks
                                      else _sample(labels, missing))
            codelist = {"file_id": file_id, "labels": labels}
    return {k: v for k, v in entry.items() if v is not None}, codelist


def build(cache: Path) -> None:
    meta = json.loads(META_PATH.read_text(encoding="utf-8"))
    variables = meta["variables"]
    removed = [k for k, v in variables.items()
               if isinstance(v, dict) and str(v.get("databank", "")).startswith("no.fhi.")]
    for k in removed:
        del variables[k]
    CODELIST_DIR.mkdir(exist_ok=True)
    added = 0
    files: dict[str, dict[str, str]] = {}
    for bank, names in ((NPR_BANK, NPR_VARS), (KRG_BANK, KRG_VARS)):
        for name in names:
            path = cache / f"{name}.json"
            if not path.exists():
                raise SystemExit(f"mangler {path} — kjør `fetch` først")
            raw = json.loads(path.read_text(encoding="utf-8"))
            entry, codelist = build_entry(raw["bank"], raw["ds"])
            variables[name] = entry
            if codelist is not None:
                merged = files.setdefault(codelist["file_id"], {})
                merged.update(codelist["labels"])
            added += 1
    for file_id, labels in files.items():
        # Del-kodelister: unionen av alle variablene som peker hit.
        body = {"kodeverk": KODEVERK.get(file_id, ""), "labels": _sort_codes(labels)}
        for name, fid in SHARED_CODELIST.items():
            if fid == file_id:
                variables[name]["codelist_size"] = len(labels)
        # Kompakt: én kode per linje holder store lister (ICD-10 ~20k) små og diffbare.
        lines = [f"  {json.dumps(k, ensure_ascii=False)}: {json.dumps(v, ensure_ascii=False)}"
                 for k, v in body["labels"].items()]
        text = ('{\n  "kodeverk": ' + json.dumps(body["kodeverk"], ensure_ascii=False)
                + ',\n  "labels": {\n' + ",\n".join("  " + ln for ln in lines) + "\n  }\n}\n")
        json.loads(text)  # sanity
        (CODELIST_DIR / f"{file_id}.json").write_text(text, encoding="utf-8")
    META_PATH.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"fjernet {len(removed)} gamle FHI-oppføringer ({', '.join(removed) or '–'}); "
          f"skrev {added} nye")


def main(argv: list[str]) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["fetch", "build", "all"])
    ap.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    a = ap.parse_args(argv)
    if a.cmd in ("fetch", "all"):
        fetch(a.cache)
    if a.cmd in ("build", "all"):
        build(a.cache)


if __name__ == "__main__":
    main(sys.argv[1:])
