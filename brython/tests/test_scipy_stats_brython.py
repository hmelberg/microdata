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
