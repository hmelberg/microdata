"""control(): variablene er MED i modellen, men koeffisientene vises ikke.

Manualen dokumenterer opsjonen for regress ("regress lønn høy_utd gift,
control(i.bosted, i.næring)") og viser til den fra regress-mml. Fram til
2026-08-30 ble den parset og deretter STILLE ignorert i begge — resultatet
så riktig ut, men var en annen modell enn brukeren ba om.
"""
import re

import numpy as np
import pandas as pd
import pytest

from m2py import MicroInterpreter

pytest.importorskip("statsmodels.api")


def _df(n=400, seed=2):
    rng = np.random.default_rng(seed)
    bosted = rng.integers(1, 4, n)
    x = rng.normal(0, 1, n)
    x1 = rng.normal(0, 1, n)
    return pd.DataFrame({
        "y": 2 + 1.5 * x + 0.8 * x1 + bosted * 0.9 + rng.normal(0, 1, n),
        "x": x, "x1": x1, "bosted": bosted, "naering": rng.integers(1, 3, n),
        "region": rng.integers(1, 5, n),
    })


def _run(line, df=None):
    it = MicroInterpreter(metadata_path=None)
    it.datasets["d"] = (_df() if df is None else df).copy()
    it.active_name = "d"
    it._execute_instruction(it.parser.parse_line(line))
    return "\n".join(str(m) for m in it.output_log)


def _coef(out, term):
    m = re.search(rf"^\s*{re.escape(term)}\s+(-?\d+\.\d+)", out, re.M)
    return float(m.group(1)) if m else None


class TestControlSkjulerMenBeholderIModellen:
    def test_kontrollvariabelen_vises_ikke(self):
        out = _run("regress y x, control(x1)")
        assert _coef(out, "x") is not None
        assert _coef(out, "x1") is None
        assert "control" in out.lower()          # ikke bare stille ignorert

    def test_kontrollvariabelen_paavirker_estimatet(self):
        """Beviset på at den faktisk er med i modellen: koeffisienten på x
        skal være den samme som når x1 står i variabellista, ikke den samme
        som når x1 er utelatt."""
        df = _df()
        med = _coef(_run("regress y x x1", df), "x")
        uten = _coef(_run("regress y x", df), "x")
        ctrl = _coef(_run("regress y x, control(x1)", df), "x")
        assert ctrl == pytest.approx(med)
        assert ctrl != pytest.approx(uten)

    def test_faktorsyntaks_i_control_skjules_helt(self):
        df = _df()
        out = _run("regress y x, control(i.bosted)", df)
        assert "bosted_2" not in out and "bosted_3" not in out
        med = _coef(_run("regress y x i.bosted", df), "x")
        assert _coef(out, "x") == pytest.approx(med)

    def test_flere_kontrollvariabler_med_komma(self):
        df = _df()
        out = _run("regress y x, control(x1, i.naering)", df)
        assert _coef(out, "x1") is None and "naering_2" not in out
        med = _coef(_run("regress y x x1 i.naering", df), "x")
        assert _coef(out, "x") == pytest.approx(med)

    def test_outputen_sier_hvilke_variabler_som_er_kontrollert(self):
        out = _run("regress y x, control(x1)")
        assert "control" in out.lower() and "x1" in out

    def test_navnekollisjon_filtrerer_ikke_for_mye(self):
        """control(x) skal skjule x, men ikke x1 — radfilteret må matche hele
        variabelnavnet, ikke et prefiks."""
        df = _df()
        out = _run("regress y x1, control(x)", df)
        assert _coef(out, "x") is None
        med = _coef(_run("regress y x1 x", df), "x1")
        assert _coef(out, "x1") == pytest.approx(med)

    def test_kategoriverdi_med_mellomrom_skjules_ogsaa(self):
        """i.kat med verdien "c d" gir dummyen `kat_c d`. Radfilteret tok
        tidligere første ord som navn, så denne raden slapp gjennom."""
        df = _df()
        df["kat"] = np.array(["a", "b", "c d"])[np.arange(len(df)) % 3]
        out = _run("regress y x, control(i.kat)", df)
        assert "kat_c d" not in out and "kat_b" not in out
        assert _coef(out, "x") is not None

    def test_ukjent_kontrollvariabel_feiler_hoeyt(self):
        out = _run("regress y x, control(finnesikke)")
        assert "FEIL" in out and "finnesikke" in out


class TestControlIFlernivaamodell:
    def test_skjuler_men_beholder(self):
        df = _df()
        out = _run("regress-mml y x by region, control(x1)", df)
        assert _coef(out, "x") is not None and _coef(out, "x1") is None
        med = _coef(_run("regress-mml y x x1 by region", df), "x")
        assert _coef(out, "x") == pytest.approx(med, rel=1e-6)

    def test_predict_varianten_tar_ogsaa_control(self):
        it = MicroInterpreter(metadata_path=None)
        it.datasets["d"] = _df()
        it.active_name = "d"
        it._execute_instruction(it.parser.parse_line(
            "regress-mml-predict y x by region, control(x1) predicted(p)"))
        assert "p" in it.datasets["d"].columns


class TestFlernivaaGruppestoerrelser:
    def test_nedre_nivaa_telles_noestet_i_oevre(self):
        """Klasse-ID-er gjenbrukes på tvers av skoler (klasse 1-5 i hver
        skole). Modellen behandler dem som ulike grupper, og headeren må gjøre
        det samme: 4 skoler x 5 klasser = 20 grupper, ikke 5."""
        df = _df()
        df["skole"] = np.arange(len(df)) % 4 + 1
        df["klasse"] = (np.arange(len(df)) // 4) % 5 + 1
        out = _run("regress-mml y x by skole klasse", df)
        assert re.search(r"klasse — 20 grupper \(min 20, maks 20", out), out
        assert re.search(r"skole — 4 grupper \(min 100, maks 100", out), out


class TestControlAvvisesDerDenIkkeStoettes:
    @pytest.mark.parametrize("line", [
        "logit yb x, control(x1)",
        "poisson cnt x, control(x1)",
        "ivregress y (x = x1), control(bosted)",
        "ivregress-predict y (x = x1), control(bosted)",
        "rdd y x, cutoff(0) control(x1)",
        "oaxaca y x by naering, control(x1)",
    ])
    def test_stille_ignorering_er_erstattet_av_klar_feil(self, line):
        df = _df()
        df["yb"] = (df["y"] > df["y"].median()).astype(int)
        df["cnt"] = np.arange(len(df)) % 5
        out = _run(line, df)
        assert "FEIL" in out and "control" in out
