#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Eval-runner for den agentiske AI-pipelinen /api/svar (microstat.melberg.app).

Kjører spørsmål mot prod-endepunktet og følger run_code/continue-løkka med
SIMULERT kjøring: runneren kjører ALDRI script selv — den svarer med en
simulert run_result-streng (default "OK. OUTPUT (truncated):\\n(simulert
kjøring)", overstyrbar per spørsmål via --run-result eller
RUN_RESULT_OVERRIDES).

Full transkript skrives til docs/eval/kjoringer/<YYYY-MM-DD-HHMM>.md.

Runneren feller INGEN PASS/FAIL-dommer mot kriteriene i evalsettet — det er
menneske-/Claude-jobb. Den merker bare tekniske utfall:
  OK        svar levert
  ERROR     error-event eller HTTP-/nettverksfeil
  TIMEOUT   ingen respons innen --timeout sekunder
  TOMT      done, men tomt svar
  MAKS-HOPP løkka nådde 15 hopp uten done

Kun standardbibliotek (Python 3).

Bruk:
  python3 scripts/eval_svar.py --sporsmal "…" [--quality fast] [--mode microdata] [-n 1]
  python3 scripts/eval_svar.py --evalsett [--bare 1,2,9] [--quality balanced]
  python3 scripts/eval_svar.py --evalsett --dry
"""

import argparse
import datetime
import json
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

API_URL = "https://microstat.melberg.app/api/svar"
TAIL_URL = "https://microstat.melberg.app/api/svar-tail"
MAKS_HOPP = 15
MAKS_OVERLEVERINGER = 40  # speiler AiTransport.nesteTailSteg i js/ai-transport.js
DEFAULT_RUN_RESULT = "OK. OUTPUT (truncated):\n(simulert kjøring)"
GYLDIGE_MODUSER = ("microdata", "python", "r")

REPO_ROT = Path(__file__).resolve().parent.parent
EVALSETT_STI = REPO_ROT / "docs" / "eval" / "svar-evalsett.md"
KJORINGER_KATALOG = REPO_ROT / "docs" / "eval" / "kjoringer"

# Per-spørsmål-overstyring av simulert run_result i evalsett-modus,
# nøklet på # fra tabellen. F.eks. {5: "FEIL:\nukjent variabel 'fylke'"}.
RUN_RESULT_OVERRIDES: dict = {}


# ---------------------------------------------------------------- passord

def les_passord() -> str:
    """Les API-passordet fra .env i repo-rot. Printes ALDRI."""
    env_fil = REPO_ROT / ".env"
    verdier = {}
    if env_fil.exists():
        for linje in env_fil.read_text(encoding="utf-8").splitlines():
            linje = linje.strip()
            if not linje or linje.startswith("#") or "=" not in linje:
                continue
            nokkel, _, verdi = linje.partition("=")
            verdier[nokkel.strip()] = verdi.strip().strip('"').strip("'")
    pw = verdier.get("M2PY_ACCESS_TOKEN_PERSONAL")
    if pw:
        return pw
    pw = verdier.get("M2PY_ACCESS_TOKEN")
    if pw:
        print(
            "ADVARSEL: M2PY_ACCESS_TOKEN_PERSONAL mangler i .env — faller "
            "tilbake på M2PY_ACCESS_TOKEN (delt passord, ratelimitet per hopp).",
            file=sys.stderr,
        )
        return pw
    sys.exit(
        "FEIL: fant verken M2PY_ACCESS_TOKEN_PERSONAL eller M2PY_ACCESS_TOKEN "
        f"i {env_fil}"
    )


# ---------------------------------------------------------------- SSE-klient

def _parse_sse_data(buf: list) -> dict:
    try:
        return json.loads("\n".join(buf))
    except json.JSONDecodeError:
        return {"type": "_parsefeil", "raw": "\n".join(buf)[:500]}


def _sse_events(req: urllib.request.Request, timeout: float):
    """Åpne forespørselen og yield parsede SSE-events (data: {...}-linjer)
    som dicts. Delt av post_sse (POST /api/svar) og tail-hoppene under
    (GET /api/svar-tail) — protokollen er den samme, bare metoden skiller."""
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        databuf = []
        for raalinje in resp:
            linje = raalinje.decode("utf-8", errors="replace").rstrip("\r\n")
            if linje == "":
                if databuf:
                    yield _parse_sse_data(databuf)
                    databuf = []
            elif linje.startswith("data:"):
                databuf.append(linje[5:].lstrip())
            # andre SSE-felt (event:, id:, kommentarer) ignoreres
        if databuf:
            yield _parse_sse_data(databuf)


def post_sse(payload: dict, passord: str, timeout: float):
    """POST JSON og yield parsede SSE-events (data: {...}-linjer) som dicts."""
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        API_URL,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + passord,
            "Accept": "text/event-stream",
        },
    )
    yield from _sse_events(req, timeout)


def post_sse_med_tail(payload: dict, passord: str, timeout: float):
    """Som post_sse, men følger {type:'tail'}-overleveringer helt til en
    "ekte" event avslutter hoppet — mirrorer consumeMedTail i js/ai-chat.js.
    jobb-tail.ts gir seg selv etter 45 s (fristMs, komfortabelt under
    Netlifys ~60 s-vegg) og sender {type:'tail', job, cursor} i stedet for
    å fullføre; uten dette faller det eventet gjennom hver eneste gren i
    kjor_sporsmal, og et spørsmål som svarer sent (balanced/best — akkurat
    arbeidsmengden denne branchen finnes for) rapporteres som ERROR selv om
    jobben lever videre i bakgrunnen (se Fix 1 i sluttfiks-planen)."""
    neste = None
    for ev in post_sse(payload, passord, timeout):
        if ev.get("type") == "tail":
            neste = ev
            continue
        yield ev
    overleveringer = 0
    while neste:
        overleveringer += 1
        if overleveringer > MAKS_OVERLEVERINGER:
            yield {"type": "_parsefeil", "raw": "for mange tail-overleveringer"}
            return
        url = (f"{TAIL_URL}?job={urllib.parse.quote(str(neste.get('job', '')))}"
               f"&from={urllib.parse.quote(str(neste.get('cursor', 0)))}")
        neste = None
        req = urllib.request.Request(
            url,
            method="GET",
            headers={
                "Authorization": "Bearer " + passord,
                "Accept": "text/event-stream",
            },
        )
        for ev in _sse_events(req, timeout):
            if ev.get("type") == "tail":
                neste = ev
                continue
            yield ev


# ---------------------------------------------------------------- kjøreløkka

def kjor_sporsmal(sp: dict, passord: str, quality: str, timeout: float) -> dict:
    """Kjør ett spørsmål gjennom run_code/continue-løkka. Returnerer resultatdict."""
    start = time.monotonic()
    hopp = []
    svarbuf = []
    kjoringer = 0
    utfall = "MAKS-HOPP"
    feilmelding = None
    usage = None

    payload = {"question": sp["question"], "mode": sp["mode"], "quality": quality}

    for hoppnr in range(1, MAKS_HOPP + 1):
        h = {
            "nr": hoppnr,
            "eventtyper": [],
            "progress": [],
            "scripts": [],
            "feil": [],
            "notater": [],
            "run_result_sendt": payload.get("run_result"),
        }
        t0 = time.monotonic()
        neste_resume = None
        pending_script = False

        try:
            for ev in post_sse_med_tail(payload, passord, timeout):
                t = ev.get("type", "?")
                h["eventtyper"].append(t)
                if t == "progress":
                    tekst = ev.get("text", "")
                    if ev.get("replace") and h["progress"]:
                        h["progress"][-1] = tekst
                    else:
                        h["progress"].append(tekst)
                elif t == "delta":
                    svarbuf.append(ev.get("text", ""))
                elif t == "turn_discard":
                    forkastet = "".join(svarbuf)
                    if forkastet:
                        h["notater"].append(
                            f"turn_discard: forkastet {len(forkastet)} tegn svarbuffer"
                        )
                    svarbuf = []
                elif t == "run_code":
                    h["scripts"].append(ev.get("script", ""))
                    kjoringer += 1
                    pending_script = True
                elif t == "continue":
                    neste_resume = {
                        "state": ev.get("state"),
                        "run_ok_calls": ev.get("run_ok_calls"),
                    }
                elif t == "done":
                    usage = {k: v for k, v in ev.items() if k != "type"}
                    utfall = "OK"
                elif t == "error":
                    feilmelding = str(ev.get("message", ""))
                    h["feil"].append(feilmelding)
                    utfall = "ERROR"
                elif t == "_parsefeil":
                    h["feil"].append(f"uparsbar SSE-data: {ev.get('raw', '')}")
        except (TimeoutError, socket.timeout):
            utfall = "TIMEOUT"
            feilmelding = f"timeout etter {timeout:.0f} s"
            h["feil"].append(feilmelding)
        except urllib.error.HTTPError as e:
            kropp = ""
            try:
                kropp = e.read().decode("utf-8", errors="replace")[:500]
            except Exception:
                pass
            utfall = "ERROR"
            feilmelding = f"HTTP {e.code}: {kropp}".strip()
            h["feil"].append(feilmelding)
        except urllib.error.URLError as e:
            if isinstance(getattr(e, "reason", None), (TimeoutError, socket.timeout)):
                utfall = "TIMEOUT"
                feilmelding = f"timeout etter {timeout:.0f} s"
            else:
                utfall = "ERROR"
                feilmelding = f"nettverksfeil: {e.reason}"
            h["feil"].append(feilmelding)

        h["varighet"] = time.monotonic() - t0
        hopp.append(h)

        if utfall in ("OK", "ERROR", "TIMEOUT"):
            break
        if neste_resume is None:
            utfall = "ERROR"
            feilmelding = "strømmen sluttet uten done/continue/error"
            h["feil"].append(feilmelding)
            break

        payload = {
            "question": sp["question"],
            "mode": sp["mode"],
            "quality": quality,
            "resume": neste_resume,
        }
        if pending_script:
            payload["run_result"] = sp.get("run_result") or DEFAULT_RUN_RESULT

    svar = "".join(svarbuf).strip()
    if utfall == "OK" and not svar:
        utfall = "TOMT"

    return {
        "sp": sp,
        "utfall": utfall,
        "feilmelding": feilmelding,
        "svar": svar,
        "hopp": hopp,
        "kjoringer": kjoringer,
        "usage": usage,
        "sekunder": time.monotonic() - start,
    }


# ---------------------------------------------------------------- evalsett

def parse_evalsett(sti: Path) -> list:
    """Parse markdown-tabellen (#, Modus, Spørsmål, Forventning) i evalsettet."""
    if not sti.exists():
        sys.exit(f"FEIL: fant ikke evalsettet: {sti}")
    sporsmal = []
    for linje in sti.read_text(encoding="utf-8").splitlines():
        s = linje.strip()
        if not s.startswith("|"):
            continue
        celler = [c.strip() for c in s.strip("|").split("|")]
        if len(celler) < 4:
            continue
        if all(set(c) <= set("-: ") for c in celler):
            continue  # skillelinje
        try:
            num = int(celler[0])
        except ValueError:
            continue  # headerrad o.l.
        modus = celler[1].lower()
        if modus not in GYLDIGE_MODUSER:
            print(
                f"ADVARSEL: ukjent modus '{celler[1]}' for #{num} — bruker microdata",
                file=sys.stderr,
            )
            modus = "microdata"
        sporsmal.append(
            {
                "num": num,
                "mode": modus,
                # backticks er tabellformattering, ikke del av spørsmålet
                "question": celler[2].replace("`", ""),
                "forventning": celler[3],
                "run_result": RUN_RESULT_OVERRIDES.get(num),
            }
        )
    return sporsmal


# ---------------------------------------------------------------- transkript

def _kodeblokk(tekst: str, sprak: str = "") -> str:
    fence = "```"
    while fence in tekst:
        fence += "`"
    return f"{fence}{sprak}\n{tekst}\n{fence}"


def _tabellcelle(tekst: str, maks: int = 60) -> str:
    tekst = tekst.replace("|", "\\|").replace("\n", " ")
    if len(tekst) > maks:
        tekst = tekst[: maks - 1] + "…"
    return tekst


def _eventtelling(typer: list) -> str:
    teller = Counter(typer)
    return ", ".join(f"{t} ×{n}" if n > 1 else t for t, n in teller.items()) or "(ingen)"


def lag_transkript(resultater: list, meta: dict) -> str:
    linjer = [
        f"# Eval-kjøring /api/svar — {meta['tidspunkt']}",
        "",
        f"- Endepunkt: {API_URL}",
        f"- Quality: {meta['quality']}",
        f"- Kilde: {meta['kilde']}",
        "- Simulert kjøring: runneren kjører ALDRI script — run_code besvares "
        "med en simulert run_result-streng.",
        "- Utfall er KUN teknisk (svar levert / error / timeout / tomt) — "
        "PASS/FAIL mot kriteriene felles manuelt.",
        "",
        "## Oppsummering",
        "",
        "| # | Spørsmål | Modus | Hopp | Kjøringer | Utfall | Sek |",
        "|---|----------|-------|------|-----------|--------|-----|",
    ]
    for r in resultater:
        sp = r["sp"]
        linjer.append(
            f"| {sp['num']} | {_tabellcelle(sp['question'])} | {sp['mode']} "
            f"| {len(r['hopp'])} | {r['kjoringer']} | {r['utfall']} "
            f"| {r['sekunder']:.1f} |"
        )
    linjer.append("")

    for r in resultater:
        sp = r["sp"]
        linjer += [
            f"## {sp['num']}. {sp['question']}",
            "",
            f"- Modus: {sp['mode']} · Utfall: **{r['utfall']}** · "
            f"Hopp: {len(r['hopp'])} · Kjøringer: {r['kjoringer']} · "
            f"Tid: {r['sekunder']:.1f} s",
        ]
        if sp.get("forventning"):
            linjer.append(f"- Forventning (fra evalsettet): {sp['forventning']}")
        if r["feilmelding"]:
            linjer.append(f"- ⚠️ Feil: {r['feilmelding']}")
        if r["usage"]:
            linjer.append(f"- Usage (done-event): `{json.dumps(r['usage'], ensure_ascii=False)}`")
        linjer.append("")

        for h in r["hopp"]:
            linjer += [
                f"### Hopp {h['nr']} ({h['varighet']:.1f} s)",
                "",
                f"Eventtyper: {_eventtelling(h['eventtyper'])}",
                "",
            ]
            if h["run_result_sendt"] is not None:
                linjer += [
                    "Sendte simulert run_result:",
                    "",
                    _kodeblokk(h["run_result_sendt"]),
                    "",
                ]
            if h["progress"]:
                linjer += ["Progress:", ""]
                linjer += [f"- {p}" for p in h["progress"]]
                linjer.append("")
            for notat in h["notater"]:
                linjer += [f"- {notat}", ""]
            for i, script in enumerate(h["scripts"], 1):
                merkelapp = f" ({i}/{len(h['scripts'])})" if len(h["scripts"]) > 1 else ""
                linjer += [f"run_code-script{merkelapp}:", "", _kodeblokk(script), ""]
            for feil in h["feil"]:
                linjer += [f"⚠️ {feil}", ""]

        linjer += ["### Sluttsvar", "", r["svar"] or "*(tomt svar)*", ""]

    return "\n".join(linjer) + "\n"


def transkript_sti(tidspunkt: datetime.datetime) -> Path:
    KJORINGER_KATALOG.mkdir(parents=True, exist_ok=True)
    basis = tidspunkt.strftime("%Y-%m-%d-%H%M")
    sti = KJORINGER_KATALOG / f"{basis}.md"
    n = 2
    while sti.exists():
        sti = KJORINGER_KATALOG / f"{basis}-{n}.md"
        n += 1
    return sti


# ---------------------------------------------------------------- CLI

def main() -> int:
    p = argparse.ArgumentParser(
        description="Eval-runner for /api/svar (microstat.melberg.app). "
        "Simulerer run_code-kjøringer; kjører aldri script selv."
    )
    p.add_argument("--sporsmal", help="ad-hoc: still ett spørsmål")
    p.add_argument("--mode", default="microdata", choices=GYLDIGE_MODUSER,
                   help="modus for --sporsmal (default microdata)")
    p.add_argument("--quality", default="balanced", choices=["fast", "balanced", "best"])
    p.add_argument("-n", dest="antall", type=int, default=1,
                   help="antall gjentak av --sporsmal (default 1)")
    p.add_argument("--evalsett", action="store_true",
                   help=f"kjør spørsmålene fra {EVALSETT_STI.relative_to(REPO_ROT)}")
    p.add_argument("--bare", help="komma-separerte #-numre fra evalsettet, f.eks. 1,2,9")
    p.add_argument("--dry", action="store_true",
                   help="parse evalsettet og print spørsmålene uten å kalle API-et")
    p.add_argument("--run-result", dest="run_result",
                   help="simulert run_result-streng for run_code (overstyrer default)")
    p.add_argument("--timeout", type=float, default=300,
                   help="sekunder per hopp før TIMEOUT (default 300)")
    args = p.parse_args()

    if not args.sporsmal and not args.evalsett and not args.dry:
        p.error("angi --sporsmal \"…\" eller --evalsett (evt. --dry)")

    # Bygg spørsmålslista
    if args.sporsmal:
        sporsmal = [
            {
                "num": i,
                "mode": args.mode,
                "question": args.sporsmal,
                "forventning": None,
                "run_result": args.run_result,
            }
            for i in range(1, args.antall + 1)
        ]
    else:
        sporsmal = parse_evalsett(EVALSETT_STI)
        if args.bare:
            try:
                onsket = {int(x) for x in args.bare.split(",") if x.strip()}
            except ValueError:
                p.error("--bare må være komma-separerte tall, f.eks. 1,2,9")
            funnet = {sp["num"] for sp in sporsmal}
            for mangler in sorted(onsket - funnet):
                print(f"ADVARSEL: #{mangler} finnes ikke i evalsettet", file=sys.stderr)
            sporsmal = [sp for sp in sporsmal if sp["num"] in onsket]
        if args.run_result:
            for sp in sporsmal:
                sp["run_result"] = sp["run_result"] or args.run_result

    if not sporsmal:
        sys.exit("FEIL: ingen spørsmål å kjøre")

    if args.dry:
        print(f"Evalsett: {len(sporsmal)} spørsmål (quality={args.quality})")
        for sp in sporsmal:
            print(f"  #{sp['num']} [{sp['mode']}] {sp['question']}")
            if sp.get("forventning"):
                print(f"      forventning: {sp['forventning']}")
        return 0

    passord = les_passord()
    tidspunkt = datetime.datetime.now()
    sti = transkript_sti(tidspunkt)
    meta = {
        "tidspunkt": tidspunkt.strftime("%Y-%m-%d %H:%M"),
        "quality": args.quality,
        "kilde": "ad-hoc (--sporsmal)" if args.sporsmal
        else str(EVALSETT_STI.relative_to(REPO_ROT)),
    }

    resultater = []
    for i, sp in enumerate(sporsmal, 1):
        print(f"[{i}/{len(sporsmal)}] #{sp['num']} [{sp['mode']}] {sp['question']}")
        r = kjor_sporsmal(sp, passord, args.quality, args.timeout)
        resultater.append(r)
        print(
            f"    → {r['utfall']} ({len(r['hopp'])} hopp, {r['kjoringer']} "
            f"kjøringer, {r['sekunder']:.1f} s)"
        )
        # skriv transkriptet etter hvert spørsmål så delresultater overlever avbrudd
        sti.write_text(lag_transkript(resultater, meta), encoding="utf-8")

    print(f"\nTranskript: {sti}")
    return 0 if all(r["utfall"] == "OK" for r in resultater) else 1


if __name__ == "__main__":
    sys.exit(main())
