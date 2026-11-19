#!/usr/bin/env python3
"""Hent og bygg katalogmetadata for BEFOLKNING_GRUNNKRETS (SSB FDB).

  python3 tools/grunnkrets_metadata.py [--cache DIR]

Grunnkrets kom i databankversjon 60 (november 2026). Kodene er 8 sifre:
kommunenummer (4) + delområde (2) + grunnkrets (2), så de følger kommune-
reformene (2020, 2024). Kodelisten skrives til codelists/BEFOLKNING_GRUNNKRETS.json
med etikett per kode og `gyldig` = [første år, siste år] (siste år = null når
koden fortsatt er i bruk). Emulatoren bruker `gyldig` til å trekke koder som
gjelder på importdatoen og som stemmer med personens kommune.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fhi_metadata import (CODELIST_DIR, META_PATH, _clean_description,  # noqa: E402
                          _updated, codelist_history)

NAME = "BEFOLKNING_GRUNNKRETS"
BANK = "no.ssb.fdb"
MIN_VERSION = "60"
DEFAULT_CACHE = Path(__file__).resolve().parent.parent / ".cache" / "ssb_raw"
URL = f"https://microdata.no/discovery/variable/{BANK}/{MIN_VERSION}/{NAME}"
SAMPLE = ["03010101", "03010303", "46010101", "50010101", "11030101", "18040101", "55010101", "31030101"]


def fetch(cache: Path) -> dict:
    cache.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
    html = urllib.request.urlopen(req, timeout=60).read().decode("utf-8")
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    ds = json.loads(m.group(1))["props"]["pageProps"]["ds"]
    (cache / f"{NAME}.json").write_text(json.dumps(ds, ensure_ascii=False), encoding="utf-8")
    return ds


def _iso(days: int) -> str:
    return (_dt.date(1970, 1, 1) + _dt.timedelta(days=int(days))).isoformat()


def build(ds: dict) -> None:
    mv = ds["measureVariable"]
    rep = mv["representedVariables"]
    hist = codelist_history(rep)
    last_year = hist[-1][0]
    labels: dict[str, str] = {}
    first: dict[str, int] = {}
    last: dict[str, int] = {}
    for i, (year, codes) in enumerate(hist):
        end = (hist[i + 1][0] - 1) if i + 1 < len(hist) else None
        for code, lab in codes:
            labels[code] = re.sub(r"\s+", " ", lab).strip()   # siste etikett vinner
            first.setdefault(code, year)
            last[code] = end if end is not None else last_year
    current = {c for c, _ in hist[-1][1]}
    codes_sorted = sorted(labels)
    gyldig = {c: [first[c], None if c in current else last[c]] for c in codes_sorted}

    status = sorted(ds.get("temporalStatusDates") or [])
    start, stop = _iso(status[0]), _iso(status[-1])
    desc = _clean_description(rep[-1].get("description", ""))
    # Kort katalogtekst (beskrivelsen fra SSB er lang og kappes uansett ved ~200 tegn).
    short = ("Små, stabile geografiske enheter (ca. 14 000), gruppert i ca. 1 550 delområder; "
             "egnet til egne områdeinndelinger (bydeler, levekårssoner).")
    hint = (f"Krever require {BANK}:{MIN_VERSION} (eller nyere). 8 sifre = kommune (4) + "
            "delområde (2) + grunnkrets (2): delområde = substr(gk, 1, 6), kommune = "
            "substr(gk, 1, 4). Kodene følger kommunereformene (2020, 2024). Kodelisten har "
            "også delområdenavn (6-sifrede koder).")
    entry = {
        "type": "register",
        "data_type": "string",
        "description": (f"{hint} {short} Enhetstype: Person. Temporalitet: Tverrsnitt. "
                        f"Gyldighetsperiode: {start} – {stop}."),
        "short_title": "Grunnkrets (bosted)",
        "temporalitet": "Tverrsnitt",
        "enhetstype": "Person",
        "microdata_datatype": "Alfanumerisk",
        "updated_at": _updated(ds.get("updatedAt")),
        "databank": BANK,
        "databank_min_versjon": int(MIN_VERSION),
        "topics": ds.get("subjectFields") or [],
        "keywords": ["grunnkrets", "delområde", "bydel", "levekårssone", "nabolag",
                     "geografi", "bosted", "småområde"],
        "populasjon": re.sub(r"\s+", " ", ds.get("populationDescription") or "").strip(),
        "full_beskrivelse": desc,
        "source_url": URL,
        "external_metadata": f"codelists/{NAME}.json",
        "codelist_size": sum(1 for c in current if len(c) == 8),
        "labels_sample": {c: labels[c] for c in SAMPLE if c in current},
    }
    meta = json.loads(META_PATH.read_text(encoding="utf-8"))
    meta["variables"][NAME] = entry
    META_PATH.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    lines = [f'    {json.dumps(c)}: {json.dumps(labels[c], ensure_ascii=False)}' for c in codes_sorted]
    glines = [f'    {json.dumps(c)}: {json.dumps(gyldig[c])}' for c in codes_sorted]
    text = ('{\n  "kodeverk": "Standard for grunnkretsinndeling (KLASS 1)",\n'
            '  "labels": {\n' + ",\n".join(lines) + "\n  },\n"
            '  "gyldig": {\n' + ",\n".join(glines) + "\n  }\n}\n")
    json.loads(text)
    (CODELIST_DIR / f"{NAME}.json").write_text(text, encoding="utf-8")
    print(f"{NAME}: {sum(1 for c in current if len(c) == 8)} gjeldende kretser, "
          f"{sum(1 for c in current if len(c) == 6)} delområder ({len(labels)} totalt over {len(hist)} perioder), "
          f"datoer {start} – {stop}")


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    ap.add_argument("--offline", action="store_true", help="bruk cachet JSON")
    a = ap.parse_args(argv)
    path = a.cache / f"{NAME}.json"
    ds = json.loads(path.read_text(encoding="utf-8")) if a.offline else fetch(a.cache)
    build(ds)


if __name__ == "__main__":
    main(sys.argv[1:])
