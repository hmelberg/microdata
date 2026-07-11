# Differensialtester mot ekte scipy — kjøres kun der scipy finnes (dev-maskin).
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import pytest
scipy_stats = pytest.importorskip('scipy.stats')
import scipy_stats_brython as st

XS = (-3.0, -1.5, -0.4, 0.0, 0.7, 1.96, 3.2)
PS = (0.005, 0.05, 0.25, 0.5, 0.8, 0.975, 0.999)

def test_norm_diff():
    for x in XS:
        assert st.norm.pdf(x) == pytest.approx(scipy_stats.norm.pdf(x), abs=1e-9)
        assert st.norm.cdf(x) == pytest.approx(scipy_stats.norm.cdf(x), abs=1e-9)
        assert st.norm.sf(x) == pytest.approx(scipy_stats.norm.sf(x), abs=1e-9)
    for p in PS:
        assert st.norm.ppf(p) == pytest.approx(scipy_stats.norm.ppf(p), abs=1e-9)

def test_t_diff():
    for df in (1, 3, 10, 30):
        for x in XS:
            assert st.t.pdf(x, df) == pytest.approx(scipy_stats.t.pdf(x, df), abs=1e-9)
            assert st.t.cdf(x, df) == pytest.approx(scipy_stats.t.cdf(x, df), abs=1e-9)
        for p in PS:
            assert st.t.ppf(p, df) == pytest.approx(scipy_stats.t.ppf(p, df), abs=1e-7)

def test_chi2_diff():
    for df in (1, 2, 5, 20):
        for x in (0.1, 0.8, 2.0, 5.0, 15.0, 40.0):
            assert st.chi2.pdf(x, df) == pytest.approx(scipy_stats.chi2.pdf(x, df), abs=1e-9)
            assert st.chi2.cdf(x, df) == pytest.approx(scipy_stats.chi2.cdf(x, df), abs=1e-9)
        for p in PS:
            assert st.chi2.ppf(p, df) == pytest.approx(scipy_stats.chi2.ppf(p, df), rel=1e-7)

def test_f_diff():
    for dfn, dfd in ((1, 10), (3, 7), (5, 2), (10, 10)):
        for x in (0.2, 0.9, 1.5, 3.0, 8.0):
            assert st.f.pdf(x, dfn, dfd) == pytest.approx(scipy_stats.f.pdf(x, dfn, dfd), abs=1e-9)
            assert st.f.cdf(x, dfn, dfd) == pytest.approx(scipy_stats.f.cdf(x, dfn, dfd), abs=1e-9)
        for p in PS:
            assert st.f.ppf(p, dfn, dfd) == pytest.approx(scipy_stats.f.ppf(p, dfn, dfd), rel=1e-6)
