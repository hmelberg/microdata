# tests/test_review_fixes_regression.py
# Regresjonstester for motorfeil i regresjons-/analysekommandoene:
#   B1  i.var-dummyer behandlet manglende verdier som referansekategori
#   B2  robust/cluster() krasjet for logit/probit/poisson/negative-binomial
#   B3  statsmodels-fallback for regress-panel FE undervurderte SE (df N-K
#       i stedet for N-K-G) og effects() ga entitetssnittet av y
#   B4  anova a##b ga tom tabell; cox ignorerte ukjente kovariater stille
import re
import sys

import numpy as np
import pandas as pd
import pytest

import m2py
from m2py import MicroInterpreter, RegressionHandler

sm = pytest.importorskip("statsmodels.api")


def _run(df, *lines, name="d"):
    it = MicroInterpreter(metadata_path=None)
    it.datasets[name] = df.copy()
    it.active_name = name
    it.run_script("\n".join(lines))
    return "\n".join(str(m) for m in it.output_log)


# ── B1: i.var — manglende verdier skal ikke bli referansekategorien ─────────

def _factor_df(seed=2, n=200, n_missing=60):
    rng = np.random.default_rng(seed)
    g = rng.integers(1, 4, n).astype(float)
    y = g * 1.0 + rng.normal(size=n)
    x = rng.normal(size=n)
    g[:n_missing] = np.nan
    return pd.DataFrame({"y": y, "g": g, "x": x})


def test_factor_dummies_are_missing_where_base_is_missing():
    df = _factor_df()
    _vars, computed, _ = RegressionHandler()._expand_factor_design(["i.g"], df)
    for name, s in computed.items():
        assert s[df["g"].isna()].isna().all(), name
        assert s[df["g"].notna()].notna().all(), name


def test_regress_factor_drops_rows_with_missing_factor():
    out = _run(_factor_df(), "regress y i.g")
    assert "FEIL" not in out, out
    m = re.search(r"No\. Observations:\s+(\d+)", out)
    assert m and int(m.group(1)) == 140, out


def test_regress_factor_interaction_drops_rows_with_missing_factor():
    out = _run(_factor_df(), "regress y i.g##c.x")
    m = re.search(r"No\. Observations:\s+(\d+)", out)
    assert m and int(m.group(1)) == 140, out


def test_rdd_factor_drops_rows_with_missing_factor():
    df = _factor_df()
    df["r"] = np.linspace(-1, 1, len(df))
    summary, _ = RegressionHandler().execute(
        "rdd", df.copy(), {"dep": "y", "runvar": "r", "exog": ["i.g"]}, {})
    m = re.search(r"N: venstre=(\d+), høyre=(\d+)", summary)
    assert m, summary
    assert int(m.group(1)) + int(m.group(2)) == 140, summary


def test_cox_factor_drops_rows_with_missing_factor():
    pytest.importorskip("lifelines")
    from lifelines import CoxPHFitter
    rng = np.random.default_rng(3)
    n = 300
    g = rng.integers(1, 4, n).astype(float)
    t = rng.exponential(1 / g) + 0.01
    e = (rng.random(n) < 0.8).astype(float)
    g[:90] = np.nan
    df = pd.DataFrame({"e": e, "t": t, "g": g})
    res, _ = m2py.SurvivalHandler()._cox(df, ["e", "t", "i.g"], {})
    # Referanse: Cox på komplette rader
    sub = df.dropna().copy()
    d = pd.get_dummies(sub["g"], prefix="g", drop_first=True).astype(float)
    ref = CoxPHFitter().fit(pd.concat([sub[["e", "t"]], d], axis=1),
                            duration_col="t", event_col="e")
    np.testing.assert_allclose(res.loc["coef"].values.astype(float),
                               ref.params_.values, rtol=1e-6)


# ── B2: robust / cluster for ikke-OLS-modeller ─────────────────────────────

def _binary_df(seed=2, n=300):
    rng = np.random.default_rng(seed)
    x = rng.normal(size=n)
    y = (x + rng.normal(size=n) > 0).astype(float)
    return pd.DataFrame({"y": y, "x": x, "c": rng.integers(0, 20, n),
                         "k": rng.poisson(2, n).astype(float)})


@pytest.mark.parametrize("cmd", [
    "logit y x, robust",
    "logit y x, cluster(c)",
    "probit y x, robust",
    "probit y x, cluster(c)",
    "poisson k x, robust",
    "poisson k x, cluster(c)",
    "negative-binomial k x, robust",
    "negative-binomial k x, cluster(c)",
    "logit y x, or robust",
])
def test_robust_and_cluster_do_not_crash(cmd):
    out = _run(_binary_df(), cmd)
    assert "FEIL" not in out, out


def test_logit_robust_matches_statsmodels_hc1():
    df = _binary_df()
    X = sm.add_constant(df[["x"]])
    base = sm.Logit(df["y"], X).fit(disp=0)
    got = RegressionHandler()._apply_cov(base, {"robust": True}, df)
    ref = sm.Logit(df["y"], X).fit(disp=0, cov_type="HC1")
    np.testing.assert_allclose(got.bse.values, ref.bse.values, rtol=1e-8)
    assert not np.allclose(got.bse.values, base.bse.values)


def test_poisson_cluster_matches_statsmodels_cluster():
    df = _binary_df()
    X = sm.add_constant(df[["x"]])
    base = sm.GLM(df["k"], X, family=sm.families.Poisson()).fit()
    got = RegressionHandler()._apply_cov(base, {"cluster": "c"}, df)
    ref = sm.GLM(df["k"], X, family=sm.families.Poisson()).fit(
        cov_type="cluster", cov_kwds={"groups": df["c"].values})
    np.testing.assert_allclose(got.bse.values, ref.bse.values, rtol=1e-8)


def test_cluster_groups_aligned_with_estimation_sample():
    # Manglende y i noen rader: gruppene må følge radene etter dropna.
    df = _binary_df()
    df.loc[df.index[:40], "y"] = np.nan
    clean = df.dropna()
    X = sm.add_constant(clean[["x"]])
    ref = sm.Probit(clean["y"], X).fit(disp=0, cov_type="cluster",
                                       cov_kwds={"groups": clean["c"].values})
    summary, _ = RegressionHandler().execute("probit", df, ["y", "x"], {"cluster": "c"})
    se_x = float(re.search(r"^x\s+\S+\s+(\S+)", summary, re.M).group(1))
    assert se_x == pytest.approx(ref.bse["x"], abs=1e-3)


def test_ols_robust_unchanged():
    df = _binary_df()
    X = sm.add_constant(df[["x"]])
    base = sm.OLS(df["k"], X).fit()
    got = RegressionHandler()._apply_cov(base, {"robust": True}, df)
    ref = base.get_robustcov_results(cov_type="HC1")
    np.testing.assert_allclose(got.bse, ref.bse, rtol=1e-12)
    got_c = RegressionHandler()._apply_cov(base, {"cluster": "c"}, df)
    ref_c = base.get_robustcov_results(cov_type="cluster", groups=df["c"].values)
    np.testing.assert_allclose(got_c.bse, ref_c.bse, rtol=1e-12)


def test_mlogit_robust_does_not_crash():
    df = _binary_df()
    df["m"] = (df["c"] % 3).astype(float)
    out = _run(df, "mlogit m x, robust")
    assert "FEIL" not in out, out


# ── B3: regress-panel FE-fallback (uten linearmodels) ───────────────────────

def _panel_df(seed=1, G=200):
    rng = np.random.default_rng(seed)
    pid = np.repeat(np.arange(G), 2)
    tid = np.tile([2010, 2011], G)
    a = rng.normal(size=G)[pid]
    x = rng.normal(size=G * 2) + a
    y = 2 * x + a + rng.normal(size=G * 2)
    return pd.DataFrame({"PERSONID_1": pid, "tid": tid, "y": y, "x": x})


@pytest.fixture
def no_linearmodels(monkeypatch):
    monkeypatch.setitem(sys.modules, "linearmodels", None)
    monkeypatch.setitem(sys.modules, "linearmodels.panel", None)


def _coef_row(summary, name="x"):
    m = re.search(rf"^{name}\s+(\S+)\s+(\S+)", summary, re.M)
    return float(m.group(1)), float(m.group(2))


def test_fe_fallback_se_matches_lsdv(no_linearmodels):
    df = _panel_df()
    summary, _ = RegressionHandler().execute("regress-panel", df, ["y", "x"], {})
    b, se = _coef_row(summary)
    D = pd.get_dummies(df["PERSONID_1"].astype(str)).astype(float)
    D["x"] = df["x"]
    lsdv = sm.OLS(df["y"], D).fit()
    assert b == pytest.approx(lsdv.params["x"], abs=1e-3)
    assert se == pytest.approx(lsdv.bse["x"], abs=1e-3)


def test_fe_fallback_robust_is_entity_clustered(no_linearmodels):
    # robust i fallbacken = cluster på enhet; korreksjonen bruker K uten
    # de absorberte effektene (som Stata xtreg, fe vce(cluster)). Uendret.
    df = _panel_df()
    summary, _ = RegressionHandler().execute("regress-panel", df, ["y", "x"], {"robust": True})
    _, se = _coef_row(summary)
    g = df["PERSONID_1"]
    yw = df["y"] - df.groupby(g)["y"].transform("mean")
    xw = df[["x"]] - df.groupby(g)[["x"]].transform("mean")
    ref = sm.OLS(yw, xw).fit().get_robustcov_results(cov_type="cluster", groups=g.values)
    assert se == pytest.approx(ref.bse[0], abs=1e-3)


def test_fe_fallback_effects_are_u_i(no_linearmodels):
    df = _panel_df()
    _, extra = RegressionHandler().execute(
        "regress-panel-predict", df, ["y", "x"], {"effects": "u"})
    g = df["PERSONID_1"]
    yw = df["y"] - df.groupby(g)["y"].transform("mean")
    xw = df["x"] - df.groupby(g)["x"].transform("mean")
    b = sm.OLS(yw, xw).fit().params.iloc[0]
    ybar_i = df.groupby(g)["y"].transform("mean")
    xbar_i = df.groupby(g)["x"].transform("mean")
    const = df["y"].mean() - df["x"].mean() * b
    expected = ybar_i - xbar_i * b - const   # Stata predict, u
    np.testing.assert_allclose(extra["u"].values, expected.values, atol=1e-8)
    assert abs(extra["u"].mean()) < 1e-8


# ── B4: anova a##b og cox med ukjente kovariater ────────────────────────────

def _anova_df(seed=0, n=100):
    rng = np.random.default_rng(seed)
    return pd.DataFrame({"y": rng.normal(size=n), "a": rng.integers(0, 2, n),
                         "b": rng.integers(0, 3, n)})


def test_anova_full_factorial_expands():
    df = _anova_df()
    se = m2py.StatsEngine()
    full = se.execute("anova", df, ["y", "a##b"], {})
    explicit = se.execute("anova", df, ["y", "a", "b", "a#b"], {})
    assert not full.empty
    assert list(full.index) == list(explicit.index)
    np.testing.assert_allclose(full["F"].values[:-1], explicit["F"].values[:-1])


def test_anova_unknown_variable_raises():
    with pytest.raises(ValueError, match="finnes ikke"):
        m2py.StatsEngine().execute("anova", _anova_df(), ["y", "a", "zz"], {})


def test_cox_unknown_covariate_raises():
    pytest.importorskip("lifelines")
    rng = np.random.default_rng(4)
    df = pd.DataFrame({"e": (rng.random(50) < 0.7).astype(float),
                       "t": rng.exponential(1, 50) + 0.01,
                       "x": rng.normal(size=50)})
    with pytest.raises(ValueError, match="zz"):
        m2py.SurvivalHandler()._cox(df, ["e", "t", "x", "zz"], {})
    with pytest.raises(ValueError, match="zz"):
        m2py.SurvivalHandler()._cox(df, ["e", "t", "i.zz"], {})


def test_cox_nonpositive_durations_reported():
    pytest.importorskip("lifelines")
    rng = np.random.default_rng(5)
    n = 80
    t = rng.exponential(1, n) + 0.01
    t[:5] = 0.0
    df = pd.DataFrame({"e": (rng.random(n) < 0.7).astype(float), "t": t,
                       "x": rng.normal(size=n)})
    out = _run(df, "cox e t x")
    assert "FEIL" not in out, out
    assert "5" in out and "varighet" in out.lower(), out
