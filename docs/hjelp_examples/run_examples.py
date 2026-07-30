#!/usr/bin/env python3
"""Kjører hjelpesidenes microdata-eksempler og skriver resultatet til output/.

Hjelpesiden skal vise faktiske resultater, ikke plausible. Dette skriptet er
kilden: hvert eksempel kjøres mot m2py (og py2m/r2m for oversetter-eksemplene),
og teksten det skriver limes rett inn i <pre class="result"> i hjelp.html.
tests/test_hjelp_examples.py sammenligner de to, så et eksempel som slutter å
stemme blir fanget.

Kjør:  python3 docs/hjelp_examples/run_examples.py
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
OUTDIR = HERE / "output"
NODE_HARNESS = HERE / "run_examples_js.mjs"


def build_frame():
    """Deterministisk demoramme. Frøet er låst — endrer du det, endres hvert
    resultattall på hjelpesiden. Samme kolonner/frø som safestat sin
    demoramme (kjonn, alder, lonn — n=5000, seed=42), siden m2py.py er
    synkronisert derfra."""
    import numpy as np
    import pandas as pd

    rng = np.random.default_rng(42)
    n = 5000
    return pd.DataFrame({
        "kjonn": rng.choice([1, 2], n),
        "alder": rng.integers(20, 70, n),
        "lonn": rng.normal(520000, 130000, n).round(0),
    })


# ─────────────────────────────────────────────────────────────────────────────
# #kommandoer / #avsloring: m2py kjørt headless — samme mønster som
# tests/test_if_condition.py — MicroInterpreter med et manuelt injisert
# datasett, _execute_instruction(parser.parse_line(...)), output_log leses ut
# som tekst. Avsløringskontroll slås PÅ eksplisitt via modul-globalen appen
# selv styrer (M2PY_DISCLOSURE_CONTROL), fordi modul-defaulten er AV
# (m2py.py:1-13) — de reglene siden beskriver (populasjonsminimum,
# liten-endring-regelen, pseudonymvern, missing-sammenligning) er de som
# gjelder når brukeren har PÅ (appens standardinnstilling).
MICRODATA_EXAMPLES = [
    {
        # #hurtigstart: DC av (appens faktiske standard, m2py.py:8-9) — den
        # aller første kommandoen en leser prøver skal ikke kreve at de vet
        # noe om avsløringskontroll ennå.
        "id": "hurtigstart",
        "dc": False,
        "lines": ["generate alder_pluss10 = alder + 10"],
    },
    {
        "id": "kommandoer-helt-skript",
        "dc": True,
        "lines": [
            "generate lonn_1000 = lonn / 1000",
            "collapse (mean) lonn_1000 -> snittlonn_1000, by(kjonn)",
        ],
    },
    {
        # Min populasjon 1000: "keep if alder > 68" etterlater 109 enheter.
        "id": "avsloring-min-populasjon",
        "dc": True,
        "lines": ["keep if alder > 68"],
    },
    {
        # Endringer må påvirke >=10 enheter: grensa 933381 er valgt slik at
        # nøyaktig 7 av 5000 rader i denne seede rammen ligger over den.
        "id": "avsloring-liten-endring",
        "dc": True,
        "lines": ["generate hoyeste = 1 if lonn > 933381"],
    },
    {
        # Pseudonym-variabler (navn som slutter på _FNR) kan ikke brukes i
        # generate/replace/sammenligninger — bare som nøkkel i collapse(by)
        # eller merge(on).
        "id": "avsloring-pseudonym",
        "dc": True,
        "lines": [
            "generate BEFOLKNING_MOR_FNR = alder",
            "generate test = BEFOLKNING_MOR_FNR + 1",
        ],
    },
    {
        # Sammenligning med `.` (Stata-syntaks `x == .`) er ikke gyldig i
        # microdata.no — bruk sysmiss(x) i stedet. Denne regelen er distinkt
        # fra populasjonsminimum: den avvises FØR filtrering/telling skjer.
        "id": "avsloring-missing-sammenligning",
        "dc": True,
        "lines": ["generate test = (lonn == .)"],
    },
]


def run_microdata_example(example: dict, df) -> str:
    """Kjør en sekvens av microdata-linjer på et fersk MicroInterpreter og
    returner alle output_log-meldingene."""
    if str(REPO) not in sys.path:
        sys.path.insert(0, str(REPO))
    import m2py
    from m2py import MicroInterpreter

    saved = getattr(m2py, "M2PY_DISCLOSURE_CONTROL", None)
    m2py.M2PY_DISCLOSURE_CONTROL = "1" if example.get("dc", True) else "0"
    try:
        it = MicroInterpreter(metadata_path=None)
        it.datasets["testdata"] = df.copy()
        it.active_name = "testdata"
        parts = []
        for line in example["lines"]:
            it.output_log.clear()
            it._execute_instruction(it.parser.parse_line(line))
            parts.extend(str(m).strip() for m in it.output_log if str(m).strip())
        return "\n".join(parts)
    finally:
        if saved is None:
            try:
                del m2py.M2PY_DISCLOSURE_CONTROL
            except AttributeError:
                pass
        else:
            m2py.M2PY_DISCLOSURE_CONTROL = saved


# ─────────────────────────────────────────────────────────────────────────────
# #kommandoer «Kontrollflyt»: for/end-løkker kan IKKE kjøres linje for linje
# gjennom _execute_instruction (det mønsteret over) — 'for' samler kroppen
# sin og itererer via MicroInterpreter._run_script_body (m2py.py:8010), som
# krever hele skriptteksten på én gang. Verifisert: linje-for-linje-kjøring av
# en for/end-blokk gir "FEIL: 'for' er ikke gyldig her" i stedet for å løkke.
# Bruker derfor run_script() direkte for dette ene eksempelet.
def run_microdata_script_example(script: str, dc: bool = True) -> str:
    if str(REPO) not in sys.path:
        sys.path.insert(0, str(REPO))
    import m2py
    from m2py import MicroInterpreter

    saved = getattr(m2py, "M2PY_DISCLOSURE_CONTROL", None)
    m2py.M2PY_DISCLOSURE_CONTROL = "1" if dc else "0"
    try:
        it = MicroInterpreter(metadata_path=None)
        it.datasets["testdata"] = build_frame().copy()
        it.active_name = "testdata"
        it.output_log.clear()
        it.run_script(script, echo_commands=False)
        return "\n".join(str(m).strip() for m in it.output_log if str(m).strip())
    finally:
        if saved is None:
            try:
                del m2py.M2PY_DISCLOSURE_CONTROL
            except AttributeError:
                pass
        else:
            m2py.M2PY_DISCLOSURE_CONTROL = saved


# ─────────────────────────────────────────────────────────────────────────────
# #oversettere: py2m og r2m kjørt på ekte kode gjennom de faktiske
# oversetterne — ikke en håndskrevet "slik ser det omtrent ut".
def run_py2m_example() -> str:
    sys.path.insert(0, str(REPO / "py2m"))
    from py2m import transform

    src = 'df = df[df["alder"] > 25]\ndf.groupby("kjonn")["lonn"].mean()\n'
    result = transform(src)
    return result.script()


def run_r2m_example() -> str:
    """Kaller Rscript direkte — r2m/test_r2m.R viser at translate() må kjøres
    med cwd=r2m/ (kildefilene source()'es relativt til r2m/r2m/*.R)."""
    code = ('df <- df %>% filter(alder > 25)\n'
            'df %>% group_by(kjonn) %>% summarise(snitt = mean(lonn))')
    # Bygg R-strenglitteralen for hånd — Python sin repr() bruker feil
    # anførselstegn-konvensjon for R.
    r_literal = '"' + code.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n') + '"'
    r_expr = (
        'source("r2m/expr.R"); source("r2m/expanders.R"); '
        'source("r2m/commands.R"); source("r2m/translator.R"); '
        f'result <- translate({r_literal}); cat(result$script)'
    )
    rscript = shutil.which("Rscript")
    if rscript is None:
        raise SystemExit("Rscript ikke funnet i PATH — kreves for r2m-eksempelet")
    proc = subprocess.run([rscript, "-e", r_expr], cwd=REPO / "r2m",
                           capture_output=True, text=True, check=True)
    return proc.stdout.strip()


def main() -> int:
    OUTDIR.mkdir(parents=True, exist_ok=True)
    df = build_frame()

    for ex in MICRODATA_EXAMPLES:
        text = run_microdata_example(ex, df)
        (OUTDIR / f"{ex['id']}.txt").write_text(text + "\n", encoding="utf-8")
        print(f"  {ex['id']}: {len(text)} tegn")

    forloop_script = "for i in 2018 : 2020\n  generate innt_$i = lonn + $i\nend"
    forloop_text = run_microdata_script_example(forloop_script, dc=False)
    (OUTDIR / "kommandoer-forlokke.txt").write_text(forloop_text + "\n", encoding="utf-8")
    print(f"  kommandoer-forlokke: {len(forloop_text)} tegn")

    py2m_text = run_py2m_example()
    (OUTDIR / "oversettere-py2m.txt").write_text(py2m_text + "\n", encoding="utf-8")
    print(f"  oversettere-py2m: {len(py2m_text)} tegn")

    r2m_text = run_r2m_example()
    (OUTDIR / "oversettere-r2m.txt").write_text(r2m_text + "\n", encoding="utf-8")
    print(f"  oversettere-r2m: {len(r2m_text)} tegn")

    node = shutil.which("node")
    if node is None:
        raise SystemExit(
            "node ikke funnet i PATH — kreves for felles-lagre/felles-forklar/"
            "felles-widgets-eksemplene (run_examples_js.mjs)"
        )
    subprocess.run([node, str(NODE_HARNESS)], cwd=REPO, check=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
