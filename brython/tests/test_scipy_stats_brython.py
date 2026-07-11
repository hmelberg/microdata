import sys, os, math
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import scipy_stats_brython as st

# ── spesialfunksjoner: eksakte identiteter (scipy-frie) ────────────────────

def test_gammainc_p_exponential_identity():
    # P(1, x) = 1 - e^-x  (eksakt)
    for x in (0.1, 0.5, 1.0, 2.0, 5.0, 10.0):
        assert abs(st._gammainc_p(1.0, x) - (1.0 - math.exp(-x))) < 1e-12

def test_gammainc_p_bounds_and_monotone():
    assert st._gammainc_p(2.5, 0.0) == 0.0
    vals = [st._gammainc_p(2.5, x) for x in (0.5, 1.0, 2.0, 4.0, 8.0, 20.0)]
    assert all(b > a for a, b in zip(vals, vals[1:]))
    assert vals[-1] > 0.9999

def test_betainc_uniform_identity():
    # I_x(1, 1) = x  (eksakt)
    for x in (0.0, 0.1, 0.25, 0.5, 0.9, 1.0):
        assert abs(st._betainc(1.0, 1.0, x) - x) < 1e-12

def test_betainc_symmetry():
    # I_x(a, b) = 1 - I_(1-x)(b, a)
    assert abs(st._betainc(2.5, 4.0, 0.3) - (1.0 - st._betainc(4.0, 2.5, 0.7))) < 1e-12

def test_norm_ppf_std_known_values():
    assert abs(st._norm_ppf_std(0.5)) < 1e-12
    assert abs(st._norm_ppf_std(0.975) - 1.959963984540054) < 1e-9
    assert abs(st._norm_ppf_std(0.025) + 1.959963984540054) < 1e-9
    # roundtrip mot erfc-basert cdf
    for p in (0.001, 0.1, 0.3, 0.7, 0.99, 0.9999):
        x = st._norm_ppf_std(p)
        assert abs(0.5 * math.erfc(-x / math.sqrt(2.0)) - p) < 1e-12

def test_invert_cdf_recovers_known_function():
    # invertér F(x) = 1 - e^-x på [0, ∞)
    cdf = lambda x: 1.0 - math.exp(-x)
    for p in (0.1, 0.5, 0.9, 0.999):
        assert abs(st._invert_cdf(cdf, p, 0.0, 1.0) - (-math.log(1.0 - p))) < 1e-9

def test_tolist_duck_typing():
    class FakeSeries:
        def tolist(self):
            return [1, 2]
    assert st._tolist(FakeSeries()) == [1, 2]
    assert st._tolist(range(3)) == [0, 1, 2]
    assert st._tolist((4, 5)) == [4, 5]

# ── fordelinger: eksakte identiteter og rundturer (scipy-frie) ──────────────

def test_norm_cdf_ppf_pdf():
    assert abs(st.norm.cdf(0.0) - 0.5) < 1e-15
    assert abs(st.norm.cdf(1.959963984540054) - 0.975) < 1e-12
    assert abs(st.norm.ppf(0.975) - 1.959963984540054) < 1e-9
    assert abs(st.norm.pdf(0.0) - 1.0 / math.sqrt(2.0 * math.pi)) < 1e-15
    # loc/scale: standardisering
    assert abs(st.norm.cdf(120.0, loc=100.0, scale=10.0) - st.norm.cdf(2.0)) < 1e-15
    assert abs(st.norm.sf(1.0) - (1.0 - st.norm.cdf(1.0))) < 1e-15

def test_t_cauchy_identity_and_symmetry():
    # t med df=1 er Cauchy: cdf(x) = 1/2 + arctan(x)/pi  (eksakt)
    for x in (-3.0, -1.0, 0.0, 0.5, 2.0):
        assert abs(st.t.cdf(x, 1) - (0.5 + math.atan(x) / math.pi)) < 1e-12
    assert abs(st.t.cdf(-1.7, 7) + st.t.cdf(1.7, 7) - 1.0) < 1e-12
    assert abs(st.t.ppf(0.975, 1000) - 1.96) < 1e-2

def test_chi2_exponential_identity():
    # chi2 med df=2 er eksponentiell(1/2): cdf(x) = 1 - e^(-x/2)  (eksakt)
    for x in (0.5, 1.0, 3.0, 8.0):
        assert abs(st.chi2.cdf(x, 2) - (1.0 - math.exp(-x / 2.0))) < 1e-12
    assert st.chi2.cdf(0.0, 4) == 0.0

def test_f_symmetry_identity():
    # X ~ F(d, d)  =>  1/X ~ F(d, d), så cdf(1, d, d) = 0.5  (eksakt)
    for d in (2, 5, 10):
        assert abs(st.f.cdf(1.0, d, d) - 0.5) < 1e-12

def test_ppf_cdf_roundtrips():
    for p in (0.01, 0.1, 0.5, 0.9, 0.99):
        assert abs(st.t.cdf(st.t.ppf(p, 7), 7) - p) < 1e-9
        assert abs(st.chi2.cdf(st.chi2.ppf(p, 5), 5) - p) < 1e-9
        assert abs(st.f.cdf(st.f.ppf(p, 4, 9), 4, 9) - p) < 1e-9
