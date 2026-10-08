# tests/test_review_fixes_conditions.py
# Regresjonstester for motorfunn i review-runden (betingelser og funksjoner):
# A1 `if` med uttrykk på høyresiden (x == y + 1) ble sammenlignet mot en
#    streng-literal, A2 recode/int() ga nullable Int64 → pd.NA i masker,
# A3 `recode x (9 = .)` skrev literal '.', A4 strengfunksjoner gjorde missing
#    til 'nan', round brukte banker's rounding, binomial* krasjet på Series.
import warnings

import numpy as np
import pandas as pd
import pytest

import functions
from m2py import MicroInterpreter


def _run(df, *lines, name="d"):
    warnings.filterwarnings("ignore")
    it = MicroInterpreter(metadata_path=None)
    if df is not None:
        it.datasets[name] = df.copy()
        it.active_name = name
    it.run_script("\n".join(lines))
    return it


def _errors(it):
    return [str(m) for m in it.output_log if "FEIL" in str(m)]


# ── A1: uttrykk på høyresiden av en betingelse ──────────────────────────────

def _xy():
    # x == y + 1 i rad 0, 1 og 3
    return pd.DataFrame({"x": [1., 2, 3, 4], "y": [0., 1, 5, 3]})


def test_keep_if_rhs_expression():
    it = _run(_xy(), "keep if x == y + 1")
    assert it.datasets["d"]["x"].tolist() == [1, 2, 4]


def test_drop_if_rhs_expression():
    it = _run(_xy(), "drop if x == y + 1")
    assert it.datasets["d"]["x"].tolist() == [3]


def test_keep_if_ne_function_rhs():
    it = _run(_xy(), "keep if x != round(y)")
    # round(y) == y; x != y i alle rader
    assert len(it.datasets["d"]) == 4
    it = _run(_xy(), "keep if y != round(x)")
    assert len(it.datasets["d"]) == 4
    it = _run(pd.DataFrame({"x": [1., 2, 3], "y": [1.2, 5, 3.4]}), "keep if x != round(y)")
    assert it.datasets["d"]["x"].tolist() == [2]


def test_generate_if_rhs_expression():
    it = _run(_xy(), "generate z = 1 if x == y + 1")
    z = it.datasets["d"]["z"]
    assert z.iloc[[0, 1, 3]].tolist() == [1, 1, 1]
    assert pd.isna(z.iloc[2])


def test_simple_conditions_still_work():
    df = pd.DataFrame({"x": [1., -2, np.nan, 4], "s": ["a", "b", "c", "a"]})
    # `x == .` skal fortsatt gå via hurtigstien uten feil (semantikken er
    # uendret av A1-fiksen)
    assert not _errors(_run(df, "keep if x == ."))
    assert _run(df, "keep if x == -2").datasets["d"]["x"].tolist() == [-2]
    assert _run(df, "keep if x > -3").datasets["d"]["x"].tolist() == [1, -2, 4]
    assert len(_run(df, 'keep if s == "a"').datasets["d"]) == 2
    assert len(_run(df, "keep if x == 1.0").datasets["d"]) == 1


def test_parse_condition_rejects_expression_rhs():
    it = MicroInterpreter(metadata_path=None)
    assert it._parse_condition("x == y + 1") is None
    assert it._parse_condition("x != round(y)") is None
    assert it._parse_condition("x == (y+1)") is None
    assert it._parse_condition("x == 3") == ("x", "==", 3)
    assert it._parse_condition("x == -3") == ("x", "==", -3)
    assert it._parse_condition("x == 2.5") == ("x", "==", 2.5)
    assert it._parse_condition("x == y") == ("x", "==", "y")
    assert it._parse_condition('s == "a b"') == ("s", "==", "a b")
    assert it._parse_condition("x == .")[2] == "."


# ── A2: recode/int() må ikke gi pd.NA i betingelser ─────────────────────────

def _x_na():
    return pd.DataFrame({"x": [1., 2, np.nan] * 10})


def test_drop_after_recode_keeps_missing_rows():
    it = _run(_x_na(), "recode x (1=1)", "drop if x > 1")
    # microdata/Python-semantikk: missing > 1 er usant, så missing beholdes
    assert len(it.datasets["d"]) == len(_run(_x_na(), "drop if x > 1").datasets["d"]) == 20


def test_keep_ne_after_recode():
    it = _run(_x_na(), "recode x (1=1)", "keep if x != 2")
    assert len(it.datasets["d"]) == len(_run(_x_na(), "keep if x != 2").datasets["d"])


def test_generate_if_after_recode_no_crash():
    it = _run(_x_na(), "recode x (1=1)", "generate w = 1 if x == 1")
    assert not _errors(it)
    w = it.datasets["d"]["w"]
    assert (w == 1).sum() == 10 and w.isna().sum() == 20


def test_recode_dtype_no_nullable_int():
    it = _run(_x_na(), "recode x (1=1)")
    assert it.datasets["d"]["x"].dtype == np.float64
    it = _run(pd.DataFrame({"x": [1., 2, 3]}), "recode x (1=5)")
    assert it.datasets["d"]["x"].dtype == np.int64
    assert it.datasets["d"]["x"].tolist() == [5, 2, 3]


def test_int_function_no_nullable():
    s = pd.Series([1.7, -2.5, np.nan])
    r = functions.int_(s)
    assert r.dtype == np.float64
    assert r.iloc[0] == 1 and r.iloc[1] == -2 and pd.isna(r.iloc[2])
    assert functions.int_(pd.Series([1.7, 2.2])).dtype == np.int64
    df = pd.DataFrame({"x": [0.5, 2.5, np.nan, 7.9]})
    it = _run(df, "generate q = int(x)", "keep if q < 5")
    assert not _errors(it)
    assert it.datasets["d"]["q"].tolist() == [0, 2]


def test_condition_mask_robust_to_nullable_int():
    # Int64 kan komme fra andre steder (import o.l.) — maskene må tåle pd.NA
    df = pd.DataFrame({"x": pd.array([1, 2, None] * 10, dtype="Int64")})
    assert len(_run(df, "drop if x > 1").datasets["d"]) == 20
    assert len(_run(df, "keep if x != 2").datasets["d"]) == 20
    assert len(_run(df, "keep if x == 1").datasets["d"]) == 10
    it = _run(df, "generate w = 1 if x == 1")
    assert not _errors(it)
    assert (it.datasets["d"]["w"] == 1).sum() == 10
    it = _run(df, "generate w = 1 if x == 1 & x < 5")
    assert not _errors(it)
    assert (it.datasets["d"]["w"] == 1).sum() == 10


# ── A3: recode til missing ──────────────────────────────────────────────────

def test_recode_to_dot_gives_missing():
    df = pd.DataFrame({"x": [1., 2, 9, np.nan, 5]})
    it = _run(df, "recode x (9 = .)")
    x = it.datasets["d"]["x"]
    assert pd.api.types.is_numeric_dtype(x)
    assert x.isna().tolist() == [False, False, True, True, False]
    assert x.dropna().tolist() == [1, 2, 5]


# ── A4: functions.py ────────────────────────────────────────────────────────

def test_string_functions_keep_missing():
    s = pd.Series(["Ab ", None, np.nan, "c"])
    for fn in (functions.length, functions.lower, functions.upper,
               functions.trim, functions.ltrim, functions.rtrim):
        out = fn(s)
        assert out.isna().tolist() == [False, True, True, False], fn.__name__
    for fn in (functions.startswith, functions.endswith):
        out = fn(s, "A")
        assert out.isna().tolist() == [False, True, True, False], fn.__name__
    assert functions.length(s).iloc[0] == 3
    assert functions.lower(s).iloc[0] == "ab "
    assert functions.upper(s).iloc[3] == "C"
    assert functions.trim(s).iloc[0] == "Ab"
    assert bool(functions.startswith(s, "A").iloc[0]) is True
    assert bool(functions.endswith(s, "c").iloc[3]) is True


def test_string_functions_engine_sysmiss():
    df = pd.DataFrame({"s": ["Ab", None, "c"]})
    it = _run(df, "generate l = length(s)", "generate lo = lower(s)", "generate m = sysmiss(lo)")
    d = it.datasets["d"]
    assert pd.isna(d["l"].iloc[1]) and d["l"].iloc[0] == 2
    assert d["m"].tolist() == [0, 1, 0]


def test_round_half_away_from_zero():
    s = pd.Series([0.5, 1.5, 2.5, -0.5, -2.5, 2.4, np.nan])
    r = functions.round_(s)
    assert r.iloc[:6].tolist() == [1, 2, 3, -1, -3, 2]
    assert pd.isna(r.iloc[6])
    assert functions.round_(2.5) == 3
    assert functions.round_(25, 10) == 30
    assert functions.round_(-25, 10) == -30
    assert functions.round_(0.15, 0.1) == pytest.approx(0.2)
    assert functions.round_(1.25, 0.5) == pytest.approx(1.5)
    assert functions.round_(pd.Series([0.15, 0.25]), 0.1).tolist() == pytest.approx([0.2, 0.3])


def test_binomial_vectorised():
    from scipy import stats
    n = pd.Series([5, 6, 7])
    assert functions.binomial(2, n, 0.5).tolist() == pytest.approx(
        [stats.binom.cdf(2, k, 0.5) for k in (5, 6, 7)])
    assert functions.binomialp(2, n, 0.5).tolist() == pytest.approx(
        [stats.binom.pmf(2, k, 0.5) for k in (5, 6, 7)])
    assert functions.binomialtail(pd.Series([1, 2, 3]), 7, 0.5).tolist() == pytest.approx(
        [stats.binom.sf(k, 7, 0.5) for k in (1, 2, 3)])
    assert functions.binomial(2, 5, 0.5) == pytest.approx(stats.binom.cdf(2, 5, 0.5))
    df = pd.DataFrame({"n": [5, 6, 7]})
    it = _run(df, "generate b = binomial(2, n, 0.5)")
    assert not _errors(it)
    assert it.datasets["d"]["b"].tolist() == pytest.approx(
        [stats.binom.cdf(2, k, 0.5) for k in (5, 6, 7)])


def test_string_predicate_on_missing_not_true_in_if():
    df = pd.DataFrame({"s": ["nb", None, np.nan, "Nx"]})
    assert _run(df, 'keep if startswith(s, "n")').datasets["d"]["s"].tolist() == ["nb"]
    assert pd.isna(functions.length(np.nan))
    assert pd.isna(functions.lower(None))
