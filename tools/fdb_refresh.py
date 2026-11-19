#!/usr/bin/env python3
"""Oppdater SSB FDB-katalogen i variable_metadata.json til siste databankversjon.

  python3 tools/fdb_refresh.py [--cache DIR] [--offline] [--dry-run]

Henter (1) endringsloggen for no.ssb.fdb (microdata.no/discovery/dataStore/…)
og (2) alle variabelstrukturer i gjeldende versjon (variabeloversikten, 20 per
side), og så:

  * oppdaterer «Gyldighetsperiode: A – B» i beskrivelsen etter samme regel som
    katalogen opprinnelig ble bygd med: Tverrsnitt = første–siste tverrsnitts-
    dato, Akkumulert/Forløp = dekningsstart–stopp. Fast-variabler og beskrivelser
    uten periode røres ikke (emulatorens dato-validering leser denne teksten);
  * fjerner variabler som ikke finnes i gjeldende versjon;
  * legger til nye variabler (kodelister > 40 koder går til codelists/<NAVN>.json).

Kuraterte felt (realism, distribution, labels, min/max …) beholdes. Variabler
med egne byggere (BEFOLKNING_GRUNNKRETS → tools/grunnkrets_metadata.py) hoppes
over ved tillegg. Skriv ut versjonen i prompten (prefiks.ts) ved behov.
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

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fhi_metadata import (CODELIST_DIR, INLINE_MAX, META_PATH, _clean_description,  # noqa: E402
                          _sample, _sort_codes, _union_codelist, _updated)

BANK = "no.ssb.fdb"
DEFAULT_CACHE = Path(__file__).resolve().parent.parent / ".cache" / "ssb_raw"
OWN_BUILDERS = {"BEFOLKNING_GRUNNKRETS"}
TEMPORALITY = {"FIXED": "Fast", "STATUS": "Tverrsnitt", "ACCUMULATED": "Akkumulert", "EVENT": "Forløp"}
DTYPES = {
    "String": ("string", "Alfanumerisk"),
    "Long": ("int", "Numerisk (heltall)"),
    "Double": ("float", "Numerisk (desimaltall)"),
    "Instant": ("date:epoch", "Dato (Instant)"),
}
_PERIOD = re.compile(r"Gyldighetsperiode:\s*\d{4}-\d{2}-\d{2}\s*[–—-]\s*\d{4}-\d{2}-\d{2}")


def _get(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    html = urllib.request.urlopen(req, timeout=60).read().decode("utf-8")
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    return json.loads(m.group(1))["props"]["pageProps"]


def fetch(cache: Path) -> tuple[dict, dict]:
    cache.mkdir(parents=True, exist_ok=True)
    store = _get(f"https://microdata.no/discovery/dataStore/{BANK}")["dataStore"]
    structures: dict = {}
    page = 0
    while True:
        data = _get(f"https://microdata.no/discovery/variables?dataStore={BANK}&pageIndex={page}")["data"]
        for ds in data["dataStructures"]:
            structures[ds["name"]] = ds
        page += 1
        if not data["dataStructures"] or len(structures) >= int(data["hitCount"]) or page > 200:
            break
        time.sleep(0.2)
    (cache / "fdb_store.json").write_text(json.dumps(store, ensure_ascii=False), encoding="utf-8")
    (cache / "fdb_structures.json").write_text(json.dumps(structures, ensure_ascii=False), encoding="utf-8")
    return store, structures


def _iso(days: int) -> str:
    return (_dt.date(1970, 1, 1) + _dt.timedelta(days=int(days))).isoformat()


def period_for(ds: dict) -> str | None:
    """«A – B» etter katalogens regel, eller None (Fast / ukjent)."""
    temp = ds.get("temporality")
    if temp == "STATUS":
        dates = ds.get("temporalStatusDates") or []
        return f"{_iso(min(dates))} – {_iso(max(dates))}" if dates else None
    if temp in ("ACCUMULATED", "EVENT"):
        tc = ds.get("temporalCoverage") or {}
        if "start" in tc and "stop" in tc:
            return f"{_iso(tc['start'])} – {_iso(tc['stop'])}"
    return None


def new_entry(ds: dict) -> tuple[dict, dict | None]:
    mv = ds["measureVariable"]
    rep = mv.get("representedVariables") or []
    name = mv["name"]
    data_type, micro = DTYPES.get(mv.get("dataType"), ("string", str(mv.get("dataType"))))
    temp = TEMPORALITY.get(ds.get("temporality"), "")
    ident = (ds.get("identifierVariables") or [{}])[0]
    enhet = (ident.get("keyType") or {}).get("label") or "Person"
    desc = _clean_description((rep[-1] if rep else {}).get("description", "")) or mv.get("label", name)
    period = period_for(ds)
    tail = f" Enhetstype: {enhet}. Temporalitet: {temp}."
    tail += f" Gyldighetsperiode: {period}." if period else " Gyldighetsperiode: ∞."
    words = re.findall(r"[a-zæøå0-9-]{4,}", f"{mv.get('label', '')}".lower())
    entry = {
        "type": "register",
        "data_type": data_type,
        "description": desc.rstrip(".") + "." + tail,
        "short_title": mv.get("label", name),
        "temporalitet": temp,
        "enhetstype": enhet,
        "microdata_datatype": micro,
        "updated_at": _updated(ds.get("updatedAt")),
        "databank": BANK,
        "topics": ds.get("subjectFields") or [],
        "keywords": sorted(set(words)),
    }
    labels, missing = _union_codelist(rep)
    codelist = None
    if labels:
        labels = _sort_codes(labels)
        if len(labels) <= INLINE_MAX:
            entry["labels"] = labels
        else:
            entry["external_metadata"] = f"codelists/{name}.json"
            entry["codelist_size"] = len(labels)
            entry["labels_sample"] = _sample(labels, missing)
            codelist = {"kodeverk": "", "labels": labels}
    return entry, codelist


def refresh(store: dict, structures: dict, dry_run: bool, cache: Path) -> None:
    meta = json.loads(META_PATH.read_text(encoding="utf-8"))
    variables = meta["variables"]
    latest = store["versions"][0]["version"].split(".")[0]
    ours = {k for k, v in variables.items() if v.get("databank") == BANK}

    removed = sorted(ours - set(structures) - OWN_BUILDERS)
    added = sorted(set(structures) - ours - OWN_BUILDERS)
    changed = []
    for name in sorted(ours & set(structures)):
        entry = variables[name]
        period = period_for(structures[name])
        desc = entry.get("description", "")
        if not period or not _PERIOD.search(desc):
            continue
        new_desc = _PERIOD.sub(f"Gyldighetsperiode: {period}", desc)
        if new_desc != desc:
            changed.append((name, _PERIOD.search(desc).group(0)[19:], period))
            entry["description"] = new_desc
            upd = _updated(structures[name].get("updatedAt"))
            if upd:
                entry["updated_at"] = upd

    for name in removed:
        del variables[name]
    for name in added:
        # Variabeloversikten utelater kodelister — hent detaljsiden for nye variabler.
        detail = cache / f"{name}.json"
        if detail.exists():
            ds = json.loads(detail.read_text(encoding="utf-8"))
        else:
            ds = _get(f"https://microdata.no/discovery/variable/{BANK}/{latest}/{name}")["ds"]
            detail.write_text(json.dumps(ds, ensure_ascii=False), encoding="utf-8")
            time.sleep(0.2)
        entry, codelist = new_entry(ds)
        variables[name] = entry
        if codelist and not dry_run:
            (CODELIST_DIR / f"{name}.json").write_text(
                json.dumps(codelist, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"{BANK}: siste versjon {latest}; {len(changed)} perioder oppdatert, "
          f"{len(added)} lagt til ({', '.join(added) or '–'}), "
          f"{len(removed)} fjernet ({', '.join(removed) or '–'})")
    for name, old, new in changed[:15]:
        print(f"  {name}: {old} → {new}")
    if len(changed) > 15:
        print(f"  … {len(changed) - 15} til")
    if not dry_run:
        META_PATH.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str]) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    ap.add_argument("--offline", action="store_true", help="bruk cachet nedlasting")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    if a.offline:
        store = json.loads((a.cache / "fdb_store.json").read_text(encoding="utf-8"))
        structures = json.loads((a.cache / "fdb_structures.json").read_text(encoding="utf-8"))
    else:
        store, structures = fetch(a.cache)
    refresh(store, structures, a.dry_run, a.cache)


if __name__ == "__main__":
    main(sys.argv[1:])
