# Brython scipy.stats Subset Implementation Plan (Stage 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Brython-mode users run standard `from scipy import stats` teaching code — distributions (norm/t/chi2/f) and hypothesis tests — in pure Python, numerically diff-tested against real scipy.

**Architecture:** One pure-Python module `brython/scipy_stats_brython.py`. Spike-verified: Brython 3.12's `math` provides `lgamma`, `gamma`, `erf`, `erfc` (correct values), so hand-written numerics reduce to the regularized incomplete gamma/beta functions (Numerical-Recipes-style series + modified-Lentz continued fractions), Acklam's inverse-normal with one Halley refinement, and a bisection CDF-inverter for t/chi2/f ppf. Distributions are class instances (`norm`, `t`, `chi2`, `f`); tests return scipy-compatible result objects. Registers via LIB_REGISTRY with aliases `['scipy', 'scipy.stats']` (Stage-2 dotted-alias support).

**Tech Stack:** Brython 3.12 / CPython 3.13 + pytest; scipy 1.17.1 on the dev machine for diff-tests (importorskip'd); Stage-1 lazy engine; Stage-2 AST guard tests apply automatically.

## Global Constraints

- `brython/scipy_stats_brython.py` must run under BOTH CPython 3.13 and Brython 3.12 — only `import math` (spike-verified: Brython has `lgamma`/`gamma`/`erf`/`erfc`); no `ast`, no browser imports, no other intra-repo deps.
- **Brython-felle 1:** no method may reference a module-global with the same name as the method (AST guard `test_brython_scoping_trap.py` enforces). Distribution methods are `pdf/cdf/sf/ppf` — no module-level functions may use those names.
- **Brython-felle 2:** `dict.setdefault` only with string-literal keys (AST guard enforces). This module needs no setdefault at all.
- Scalar inputs only for distribution methods (no array broadcasting) — teaching scale; document in module docstring.
- scipy compatibility choices fixed by this plan: `ttest_ind(equal_var=True)` default with Welch under `equal_var=False`; `chi2_contingency(correction=True)` default applies Yates for 2×2; `mannwhitneyu` implements the asymptotic normal approximation with tie- and continuity-correction (diff-test against scipy's `method='asymptotic'`; scipy's exact small-sample method is out of scope).
- Diff tolerances: distributions `abs=1e-9` (norm ppf ~1e-12 after Halley; betainc/gammainc ~1e-12), test functions `rel=1e-8`, mannwhitneyu `rel=1e-6`.
- Norwegian user-facing error strings; test files follow repo pattern (`test_<lib>.py` scipy-free with exact identities, `test_<lib>_diff.py` with `pytest.importorskip('scipy')`).
- NO sw.js changes (new module is lazily fetched, not precached; runner/engine unchanged except LIB_REGISTRY entry).
- Development in microdata on a feature branch; port to safestat (first) then openstat at the end.

---

### Task 1: Module skeleton + special functions

**Files:**
- Create: `brython/scipy_stats_brython.py`
- Test: `brython/tests/test_scipy_stats_brython.py` (new)

**Interfaces:**
- Produces (Task 2 consumes): `_gammainc_p(a, x) -> float` (regularized lower incomplete gamma P(a,x)), `_betainc(a, b, x) -> float` (regularized incomplete beta I_x(a,b)), `_norm_ppf_std(p) -> float` (standard-normal inverse), `_invert_cdf(cdf, p, lo, hi) -> float` (bisection inverter; cdf is a 1-arg callable), `_tolist(v) -> list` (duck-typed list-ifier).

- [ ] **Step 1: Write the failing tests**

Create `brython/tests/test_scipy_stats_brython.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/hom/Documents/GitHub/microdata && python3 -m pytest brython/tests/test_scipy_stats_brython.py -q`
Expected: FAIL at import — `ModuleNotFoundError: No module named 'scipy_stats_brython'`.

- [ ] **Step 3: Implement**

Create `brython/scipy_stats_brython.py`:

```python
# scipy_stats_brython — scipy.stats-subsett i ren Python for Brython-modus.
# Importeres som `from scipy import stats` / `import scipy.stats` (aliaser i
# LIB_REGISTRY) eller direkte som scipy_stats_brython.
#
# Kun SKALARE argumenter til fordelingsmetodene (ingen array-broadcasting) —
# undervisningsskala. Numerikk: math.lgamma/erf/erfc (finnes i Brython 3.12,
# spike-verifisert 2026-07-11) + ufullstendig gamma/beta (NR-stil serie +
# modifisert Lentz-kjedebrøk), Acklams invers-normal med én Halley-korreksjon,
# og halveringsinversjon for t/chi2/f sin ppf.
#
# NB Brython-feller (se test_brython_scoping_trap.py): ingen metode refererer
# en global med metodens navn; ingen setdefault med ikke-streng-nøkler.
import math


def _tolist(v):
    """list-ifiser: lister, tupler, range og pandas_brython-Series (duck)."""
    if hasattr(v, 'tolist'):
        return list(v.tolist())
    if hasattr(v, 'values') and not isinstance(v, dict):
        vals = v.values
        return list(vals() if callable(vals) else vals)
    return list(v)


# ── spesialfunksjoner ───────────────────────────────────────────────────────

def _gammainc_p(a, x):
    """Regularisert nedre ufullstendig gamma P(a, x) (NR gammp)."""
    if a <= 0.0 or x < 0.0:
        raise ValueError('gammainc: krever a > 0 og x >= 0')
    if x == 0.0:
        return 0.0
    if x < a + 1.0:
        # serieutvikling
        ap = a
        s = 1.0 / a
        d = s
        for _ in range(500):
            ap += 1.0
            d *= x / ap
            s += d
            if abs(d) < abs(s) * 1e-15:
                break
        return s * math.exp(-x + a * math.log(x) - math.lgamma(a))
    # kjedebrøk for Q(a, x) (modifisert Lentz); P = 1 - Q
    tiny = 1e-300
    b = x + 1.0 - a
    c = 1.0 / tiny
    d = 1.0 / b
    h = d
    for i in range(1, 500):
        an = -i * (i - a)
        b += 2.0
        d = an * d + b
        if abs(d) < tiny:
            d = tiny
        c = b + an / c
        if abs(c) < tiny:
            c = tiny
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < 1e-15:
            break
    q = math.exp(-x + a * math.log(x) - math.lgamma(a)) * h
    return 1.0 - q


def _betacf(a, b, x):
    """Kjedebrøken i ufullstendig beta (NR betacf, modifisert Lentz)."""
    tiny = 1e-300
    qab = a + b
    qap = a + 1.0
    qam = a - 1.0
    c = 1.0
    d = 1.0 - qab * x / qap
    if abs(d) < tiny:
        d = tiny
    d = 1.0 / d
    h = d
    for m in range(1, 300):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        if abs(d) < tiny:
            d = tiny
        c = 1.0 + aa / c
        if abs(c) < tiny:
            c = tiny
        d = 1.0 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        if abs(d) < tiny:
            d = tiny
        c = 1.0 + aa / c
        if abs(c) < tiny:
            c = tiny
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < 1e-14:
            break
    return h


def _betainc(a, b, x):
    """Regularisert ufullstendig beta I_x(a, b)."""
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    ln_bt = (math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b)
             + a * math.log(x) + b * math.log(1.0 - x))
    bt = math.exp(ln_bt)
    if x < (a + 1.0) / (a + b + 2.0):
        return bt * _betacf(a, b, x) / a
    return 1.0 - bt * _betacf(b, a, 1.0 - x) / b


def _norm_ppf_std(p):
    """Standard-normal invers-CDF: Acklams approksimasjon + én
    Halley-korreksjon (relativ feil ~1e-15)."""
    if p <= 0.0 or p >= 1.0:
        if p == 0.0:
            return float('-inf')
        if p == 1.0:
            return float('inf')
        raise ValueError('ppf: p må ligge i [0, 1]')
    a = (-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
         1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00)
    b = (-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
         6.680131188771972e+01, -1.328068155288572e+01)
    c = (-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
         -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00)
    d = (7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
         3.754408661907416e+00)
    plow = 0.02425
    if p < plow:
        q = math.sqrt(-2.0 * math.log(p))
        x = ((((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
             / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0))
    elif p <= 1.0 - plow:
        q = p - 0.5
        r = q * q
        x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
             / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1.0))
    else:
        q = math.sqrt(-2.0 * math.log(1.0 - p))
        x = -((((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
              / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0))
    # Halley-korreksjon mot erfc-basert CDF
    e = 0.5 * math.erfc(-x / math.sqrt(2.0)) - p
    u = e * math.sqrt(2.0 * math.pi) * math.exp(x * x / 2.0)
    return x - u / (1.0 + x * u / 2.0)


def _invert_cdf(cdf, p, lo, hi):
    """Numerisk inversjon av en monotont stigende CDF ved halvering.
    hi utvides til cdf(hi) >= p."""
    if p <= 0.0 or p >= 1.0:
        if p == 0.0:
            return lo
        if p == 1.0:
            return float('inf')
        raise ValueError('ppf: p må ligge i [0, 1]')
    while cdf(hi) < p:
        hi *= 2.0
        if hi > 1e300:
            break
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if cdf(mid) < p:
            lo = mid
        else:
            hi = mid
        if hi - lo < 1e-13 * max(1.0, abs(hi)):
            break
    return 0.5 * (lo + hi)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest brython/tests/test_scipy_stats_brython.py -q`
Expected: 7 PASS. Also run the guard suite: `python3 -m pytest brython/tests/test_brython_scoping_trap.py -q` — 2 PASS (new module is scanned automatically).

- [ ] **Step 5: Commit**

```bash
git add brython/scipy_stats_brython.py brython/tests/test_scipy_stats_brython.py
git commit -m "feat(brython): scipy_stats_brython special functions — gammainc/betainc/norm-ppf/inverter"
```

---

### Task 2: Distribution objects norm / t / chi2 / f

**Files:**
- Modify: `brython/scipy_stats_brython.py` (append)
- Test: `brython/tests/test_scipy_stats_brython.py` (append) and create `brython/tests/test_scipy_stats_brython_diff.py`

**Interfaces:**
- Consumes: `_gammainc_p`, `_betainc`, `_norm_ppf_std`, `_invert_cdf` (Task 1).
- Produces (Tasks 3–4 consume): module-level instances `norm` (methods `pdf/cdf/sf/ppf` with `(x, loc=0.0, scale=1.0)`), `t` (`(x, df)`), `chi2` (`(x, df)`), `f` (`(x, dfn, dfd)`). All scalar-in/scalar-out.

- [ ] **Step 1: Write the failing tests**

Append to `brython/tests/test_scipy_stats_brython.py`:

```python
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
```

Create `brython/tests/test_scipy_stats_brython_diff.py`:

```python
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
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest brython/tests/test_scipy_stats_brython.py brython/tests/test_scipy_stats_brython_diff.py -q`
Expected: new tests FAIL with `AttributeError: module 'scipy_stats_brython' has no attribute 'norm'`.

- [ ] **Step 3: Implement**

Append to `brython/scipy_stats_brython.py`:

```python
# ── fordelinger (skalar inn/ut; instanser som i scipy) ──────────────────────

_SQRT2 = math.sqrt(2.0)
_SQRT2PI = math.sqrt(2.0 * math.pi)


class _Norm:
    def pdf(self, x, loc=0.0, scale=1.0):
        z = (x - loc) / scale
        return math.exp(-0.5 * z * z) / (scale * _SQRT2PI)

    def cdf(self, x, loc=0.0, scale=1.0):
        z = (x - loc) / scale
        return 0.5 * math.erfc(-z / _SQRT2)

    def sf(self, x, loc=0.0, scale=1.0):
        z = (x - loc) / scale
        return 0.5 * math.erfc(z / _SQRT2)

    def ppf(self, p, loc=0.0, scale=1.0):
        return loc + scale * _norm_ppf_std(p)


class _T:
    def pdf(self, x, df):
        return math.exp(math.lgamma((df + 1.0) / 2.0) - math.lgamma(df / 2.0)
                        - 0.5 * math.log(df * math.pi)
                        - ((df + 1.0) / 2.0) * math.log(1.0 + x * x / df))

    def cdf(self, x, df):
        if x == 0.0:
            return 0.5
        ib = _betainc(df / 2.0, 0.5, df / (df + x * x))
        return 1.0 - 0.5 * ib if x > 0.0 else 0.5 * ib

    def sf(self, x, df):
        return self.cdf(-x, df)          # symmetri

    def ppf(self, p, df):
        if p == 0.5:
            return 0.0
        if p < 0.5:
            return -self.ppf(1.0 - p, df)
        return _invert_cdf(lambda x: self.cdf(x, df), p, 0.0, 10.0)


class _Chi2:
    def pdf(self, x, df):
        if x <= 0.0:
            return 0.0
        return math.exp((df / 2.0 - 1.0) * math.log(x) - x / 2.0
                        - math.lgamma(df / 2.0) - (df / 2.0) * math.log(2.0))

    def cdf(self, x, df):
        if x <= 0.0:
            return 0.0
        return _gammainc_p(df / 2.0, x / 2.0)

    def sf(self, x, df):
        return 1.0 - self.cdf(x, df)

    def ppf(self, p, df):
        return _invert_cdf(lambda x: self.cdf(x, df), p, 0.0, df + 10.0)


class _F:
    def pdf(self, x, dfn, dfd):
        if x <= 0.0:
            return 0.0
        ln_b = (math.lgamma(dfn / 2.0) + math.lgamma(dfd / 2.0)
                - math.lgamma((dfn + dfd) / 2.0))
        return math.exp(0.5 * (dfn * math.log(dfn * x) + dfd * math.log(dfd)
                               - (dfn + dfd) * math.log(dfn * x + dfd))
                        - math.log(x) - ln_b)

    def cdf(self, x, dfn, dfd):
        if x <= 0.0:
            return 0.0
        return _betainc(dfn / 2.0, dfd / 2.0, dfn * x / (dfn * x + dfd))

    def sf(self, x, dfn, dfd):
        return 1.0 - self.cdf(x, dfn, dfd)

    def ppf(self, p, dfn, dfd):
        return _invert_cdf(lambda x: self.cdf(x, dfn, dfd), p, 0.0, 10.0)


norm = _Norm()
t = _T()
chi2 = _Chi2()
f = _F()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest brython/tests/test_scipy_stats_brython.py brython/tests/test_scipy_stats_brython_diff.py -q`
Expected: all PASS (12 identity tests + 4 diff tests).

- [ ] **Step 5: Commit**

```bash
git add brython/scipy_stats_brython.py brython/tests/test_scipy_stats_brython.py brython/tests/test_scipy_stats_brython_diff.py
git commit -m "feat(brython): norm/t/chi2/f distributions, diff-tested against scipy"
```

---

### Task 3: TestResult + t-tests + pearsonr

**Files:**
- Modify: `brython/scipy_stats_brython.py` (append)
- Test: both test files (append)

**Interfaces:**
- Consumes: `t` instance, `_tolist` (Tasks 1–2).
- Produces (Task 4 consumes `TestResult`): `TestResult(statistic, pvalue)` — iterable/indexable 2-tuple with `.statistic`/`.pvalue`; `ttest_1samp(a, popmean)`, `ttest_ind(a, b, equal_var=True)`, `ttest_rel(a, b)`, `pearsonr(x, y)` — all return `TestResult`.

- [ ] **Step 1: Write the failing tests**

Append to `brython/tests/test_scipy_stats_brython.py`:

```python
# ── t-tester og korrelasjon ─────────────────────────────────────────────────

def test_ttest_1samp_symmetric_data():
    res = st.ttest_1samp([-1.0, 0.0, 1.0], 0.0)
    assert abs(res.statistic) < 1e-12
    assert abs(res.pvalue - 1.0) < 1e-12
    stat, p = res                       # tuple-utpakking som i scipy
    assert stat == res.statistic and p == res.pvalue
    assert res[0] == stat and res[1] == p

def test_ttest_ind_identical_groups():
    res = st.ttest_ind([1.0, 2.0, 3.0], [1.0, 2.0, 3.0])
    assert abs(res.statistic) < 1e-12 and abs(res.pvalue - 1.0) < 1e-12

def test_ttest_rel_zero_diff_no_crash():
    # identiske par gir 0/0 — nan aksepteres, poenget er ingen krasj
    res = st.ttest_rel([5.0, 6.0, 7.0], [5.0, 6.0, 7.0])
    assert res.statistic != res.statistic     # nan
    assert res.pvalue != res.pvalue           # nan

def test_pearsonr_perfect_and_zero():
    r = st.pearsonr([1, 2, 3, 4], [2, 4, 6, 8])
    assert abs(r.statistic - 1.0) < 1e-12
    r2 = st.pearsonr([1, 2, 3, 4], [1, -1, 1, -1])
    assert abs(r2.statistic) < 0.5      # nær null, ikke eksakt
```

Append to `brython/tests/test_scipy_stats_brython_diff.py`:

```python
A = [12.9, 13.5, 12.8, 15.6, 17.2, 19.2, 12.6, 15.3, 14.4, 11.3]
B = [12.7, 13.6, 12.0, 15.2, 16.8, 20.0, 12.0, 15.9, 16.0, 11.1]
C = [14.2, 12.1, 13.8, 16.1, 15.5, 18.0, 13.1]

def test_ttest_1samp_diff():
    mine = st.ttest_1samp(A, 14.0)
    ref = scipy_stats.ttest_1samp(A, 14.0)
    assert mine.statistic == pytest.approx(ref.statistic, rel=1e-8)
    assert mine.pvalue == pytest.approx(ref.pvalue, rel=1e-8)

def test_ttest_ind_pooled_and_welch_diff():
    for ev in (True, False):
        mine = st.ttest_ind(A, C, equal_var=ev)
        ref = scipy_stats.ttest_ind(A, C, equal_var=ev)
        assert mine.statistic == pytest.approx(ref.statistic, rel=1e-8)
        assert mine.pvalue == pytest.approx(ref.pvalue, rel=1e-8)

def test_ttest_rel_diff():
    mine = st.ttest_rel(A, B)
    ref = scipy_stats.ttest_rel(A, B)
    assert mine.statistic == pytest.approx(ref.statistic, rel=1e-8)
    assert mine.pvalue == pytest.approx(ref.pvalue, rel=1e-8)

def test_pearsonr_diff():
    mine = st.pearsonr(A, B)
    ref = scipy_stats.pearsonr(A, B)
    assert mine.statistic == pytest.approx(ref.statistic, rel=1e-8)
    assert mine.pvalue == pytest.approx(ref.pvalue, rel=1e-8)
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest brython/tests/test_scipy_stats_brython.py brython/tests/test_scipy_stats_brython_diff.py -q`
Expected: new tests FAIL with `AttributeError: ... no attribute 'ttest_1samp'`.

- [ ] **Step 3: Implement**

Append to `brython/scipy_stats_brython.py`:

```python
# ── hypotesetester ──────────────────────────────────────────────────────────

class TestResult:
    """(statistic, pvalue) — oppfører seg som scipy sitt resultatobjekt:
    attributter + utpakking/indeksering som 2-tuple."""

    def __init__(self, statistic, pvalue):
        self.statistic = statistic
        self.pvalue = pvalue

    def __iter__(self):
        return iter((self.statistic, self.pvalue))

    def __getitem__(self, i):
        return (self.statistic, self.pvalue)[i]

    def __len__(self):
        return 2

    def __repr__(self):
        return 'TestResult(statistic=%r, pvalue=%r)' % (self.statistic, self.pvalue)


def _mean(v):
    return sum(v) / len(v)


def _var(v, ddof=1):
    m = _mean(v)
    return sum((x - m) ** 2 for x in v) / (len(v) - ddof)


def ttest_1samp(a, popmean):
    a = _tolist(a)
    n = len(a)
    se = math.sqrt(_var(a) / n)
    stat = (_mean(a) - popmean) / se if se > 0.0 else float('nan')
    p = 2.0 * t.sf(abs(stat), n - 1) if stat == stat else float('nan')
    return TestResult(stat, p)


def ttest_ind(a, b, equal_var=True):
    a, b = _tolist(a), _tolist(b)
    na, nb = len(a), len(b)
    va, vb = _var(a), _var(b)
    if equal_var:
        sp = ((na - 1) * va + (nb - 1) * vb) / (na + nb - 2)
        se = math.sqrt(sp * (1.0 / na + 1.0 / nb))
        dof = na + nb - 2
    else:                                # Welch
        se = math.sqrt(va / na + vb / nb)
        dof = ((va / na + vb / nb) ** 2
               / ((va / na) ** 2 / (na - 1) + (vb / nb) ** 2 / (nb - 1)))
    stat = (_mean(a) - _mean(b)) / se if se > 0.0 else float('nan')
    p = 2.0 * t.sf(abs(stat), dof) if stat == stat else float('nan')
    return TestResult(stat, p)


def ttest_rel(a, b):
    a, b = _tolist(a), _tolist(b)
    if len(a) != len(b):
        raise ValueError('ttest_rel: like lange utvalg kreves')
    return ttest_1samp([x - y for x, y in zip(a, b)], 0.0)


def pearsonr(x, y):
    x, y = _tolist(x), _tolist(y)
    if len(x) != len(y):
        raise ValueError('pearsonr: like lange utvalg kreves')
    n = len(x)
    mx, my = _mean(x), _mean(y)
    num = sum((a - mx) * (b - my) for a, b in zip(x, y))
    den = math.sqrt(sum((a - mx) ** 2 for a in x)
                    * sum((b - my) ** 2 for b in y))
    r = num / den if den > 0.0 else float('nan')
    r = max(-1.0, min(1.0, r)) if r == r else r
    if n <= 2 or r != r or abs(r) == 1.0:
        p = 0.0 if r == r and abs(r) == 1.0 else float('nan')
    else:
        stat = r * math.sqrt((n - 2) / (1.0 - r * r))
        p = 2.0 * t.sf(abs(stat), n - 2)
    return TestResult(r, p)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest brython/tests/test_scipy_stats_brython.py brython/tests/test_scipy_stats_brython_diff.py -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add brython/scipy_stats_brython.py brython/tests/test_scipy_stats_brython.py brython/tests/test_scipy_stats_brython_diff.py
git commit -m "feat(brython): ttest_1samp/ind/rel + pearsonr, diff-tested against scipy"
```

---

### Task 4: chi2_contingency + mannwhitneyu

**Files:**
- Modify: `brython/scipy_stats_brython.py` (append)
- Test: both test files (append)

**Interfaces:**
- Consumes: `chi2`, `norm` instances, `TestResult`, `_tolist`.
- Produces: `chi2_contingency(observed, correction=True) -> Chi2ContingencyResult` (attrs `statistic`, `pvalue`, `dof`, `expected_freq`; iterable 4-tuple); `mannwhitneyu(x, y, alternative='two-sided') -> TestResult` (statistic = U1, asymptotic p with tie- and continuity-correction).

- [ ] **Step 1: Write the failing tests**

Append to `brython/tests/test_scipy_stats_brython.py`:

```python
# ── chi2_contingency og mannwhitneyu ───────────────────────────────────────

def test_chi2_contingency_independent_table():
    # perfekt uavhengighet: forventet == observert => stat 0, p 1
    res = st.chi2_contingency([[10, 20], [20, 40]], correction=False)
    assert abs(res.statistic) < 1e-12
    assert abs(res.pvalue - 1.0) < 1e-12
    assert res.dof == 1
    stat, p, dof, exp = res             # 4-tuple-utpakking som i scipy
    assert exp[0][0] == pytest.approx(10.0)

def test_chi2_contingency_yates_reduces_statistic():
    raw = st.chi2_contingency([[12, 5], [6, 14]], correction=False)
    yates = st.chi2_contingency([[12, 5], [6, 14]], correction=True)
    assert yates.statistic < raw.statistic

def test_mannwhitneyu_identical_groups():
    res = st.mannwhitneyu([1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6])
    assert res.pvalue > 0.9
```

(Also add `import pytest` at the top of `test_scipy_stats_brython.py` — the contingency test uses `pytest.approx`.)

Append to `brython/tests/test_scipy_stats_brython_diff.py`:

```python
TABLE = [[23, 11, 8], [14, 19, 12]]

def test_chi2_contingency_diff():
    for corr in (True, False):
        mine = st.chi2_contingency(TABLE, correction=corr)
        ref = scipy_stats.chi2_contingency(TABLE, correction=corr)
        assert mine.statistic == pytest.approx(ref.statistic, rel=1e-8)
        assert mine.pvalue == pytest.approx(ref.pvalue, rel=1e-8)
        assert mine.dof == ref.dof
        for i, row in enumerate(mine.expected_freq):
            for j, v in enumerate(row):
                assert v == pytest.approx(float(ref.expected_freq[i][j]), rel=1e-10)

def test_chi2_contingency_2x2_yates_diff():
    mine = st.chi2_contingency([[12, 5], [6, 14]])           # correction=True default
    ref = scipy_stats.chi2_contingency([[12, 5], [6, 14]])
    assert mine.statistic == pytest.approx(ref.statistic, rel=1e-8)
    assert mine.pvalue == pytest.approx(ref.pvalue, rel=1e-8)

def test_mannwhitneyu_diff_asymptotic():
    x = [3.1, 4.5, 2.8, 5.9, 4.4, 3.3, 5.1, 2.9]
    y = [4.9, 5.5, 6.1, 4.2, 6.8, 5.0, 5.7]
    for alt in ('two-sided', 'less', 'greater'):
        mine = st.mannwhitneyu(x, y, alternative=alt)
        ref = scipy_stats.mannwhitneyu(x, y, alternative=alt, method='asymptotic')
        assert mine.statistic == pytest.approx(float(ref.statistic), rel=1e-10)
        assert mine.pvalue == pytest.approx(float(ref.pvalue), rel=1e-6)

def test_mannwhitneyu_ties_diff():
    x = [1, 2, 2, 3, 3, 3, 4]
    y = [2, 3, 3, 4, 4, 5, 5, 6]
    mine = st.mannwhitneyu(x, y)
    ref = scipy_stats.mannwhitneyu(x, y, method='asymptotic')
    assert mine.statistic == pytest.approx(float(ref.statistic), rel=1e-10)
    assert mine.pvalue == pytest.approx(float(ref.pvalue), rel=1e-6)
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest brython/tests/test_scipy_stats_brython.py brython/tests/test_scipy_stats_brython_diff.py -q`
Expected: new tests FAIL with AttributeError.

- [ ] **Step 3: Implement**

Append to `brython/scipy_stats_brython.py`:

```python
class Chi2ContingencyResult:
    """Som scipy: attributter + utpakking som (statistic, pvalue, dof,
    expected_freq)."""

    def __init__(self, statistic, pvalue, dof, expected_freq):
        self.statistic = statistic
        self.pvalue = pvalue
        self.dof = dof
        self.expected_freq = expected_freq

    def __iter__(self):
        return iter((self.statistic, self.pvalue, self.dof, self.expected_freq))

    def __getitem__(self, i):
        return (self.statistic, self.pvalue, self.dof, self.expected_freq)[i]

    def __repr__(self):
        return ('Chi2ContingencyResult(statistic=%r, pvalue=%r, dof=%r)'
                % (self.statistic, self.pvalue, self.dof))


def chi2_contingency(observed, correction=True):
    """Kjikvadrat-test for uavhengighet i en krysstabell.
    observed: liste av rader (eller DataFrame — duck-typet på .values).
    correction=True gir Yates-korreksjon for 2x2-tabeller (som scipy)."""
    if hasattr(observed, 'values') and not isinstance(observed, dict):
        vals = observed.values
        observed = vals() if callable(vals) else vals
    rows = [_tolist(r) for r in observed]
    rsums = [sum(r) for r in rows]
    csums = [sum(c) for c in zip(*rows)]
    total = float(sum(rsums))
    if total <= 0.0:
        raise ValueError('chi2_contingency: tom tabell')
    expected = [[rs * cs / total for cs in csums] for rs in rsums]
    dof = (len(rows) - 1) * (len(csums) - 1)
    use_yates = correction and len(rows) == 2 and len(csums) == 2
    stat = 0.0
    for ro, re_ in zip(rows, expected):
        for o, e in zip(ro, re_):
            d = abs(o - e)
            if use_yates:
                d = max(0.0, d - 0.5)
            stat += d * d / e
    p = chi2.sf(stat, dof) if dof > 0 else 1.0
    return Chi2ContingencyResult(stat, p, dof, expected)


def mannwhitneyu(x, y, alternative='two-sided'):
    """Mann-Whitney U (asymptotisk normaltilnærming med midtrang for
    uavgjorte, tie-korrigert varians og kontinuitetskorreksjon — som scipy
    med method='asymptotic'). Statistikken er U1 (for x)."""
    x, y = _tolist(x), _tolist(y)
    nx, ny = len(x), len(y)
    merged = [(v, 0) for v in x] + [(v, 1) for v in y]
    merged.sort(key=lambda pair: pair[0])
    ranks = [0.0] * len(merged)
    tie_term = 0.0
    i = 0
    while i < len(merged):
        j = i
        while j + 1 < len(merged) and merged[j + 1][0] == merged[i][0]:
            j += 1
        avg = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks[k] = avg
        cnt = j - i + 1
        if cnt > 1:
            tie_term += cnt ** 3 - cnt
        i = j + 1
    rx = sum(r for r, (v, g) in zip(ranks, merged) if g == 0)
    u1 = rx - nx * (nx + 1) / 2.0
    n = nx + ny
    mu = nx * ny / 2.0
    sigma2 = nx * ny / 12.0 * ((n + 1) - tie_term / (n * (n - 1.0)))
    sigma = math.sqrt(sigma2)
    if sigma == 0.0:
        return TestResult(u1, float('nan'))
    if alternative == 'two-sided':
        z = (abs(u1 - mu) - 0.5) / sigma
        p = min(1.0, 2.0 * norm.sf(z))
    elif alternative == 'greater':
        z = (u1 - mu - 0.5) / sigma
        p = norm.sf(z)
    elif alternative == 'less':
        z = (u1 - mu + 0.5) / sigma
        p = norm.cdf(z)
    else:
        raise ValueError("mannwhitneyu: alternative må være "
                         "'two-sided', 'less' eller 'greater'")
    return TestResult(u1, p)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest brython/tests/ -q`
Expected: full suite green (existing 110 + all new scipy tests).

- [ ] **Step 5: Commit**

```bash
git add brython/scipy_stats_brython.py brython/tests/test_scipy_stats_brython.py brython/tests/test_scipy_stats_brython_diff.py
git commit -m "feat(brython): chi2_contingency (Yates) + mannwhitneyu (asymptotic), diff-tested"
```

---

### Task 5: Registry entry, example, index.html button

**Files:**
- Modify: `js/brython-engine.js` (LIB_REGISTRY)
- Create: `examples/bry14_scipy_stats.txt`
- Modify: `index.html` (after the bry13 button)
- Test: `brython/tests/test_engine_scan.py` (append)

**Interfaces:**
- Consumes: Stage-1 registry/scan, Stage-2 dotted `_alias_module`.
- Produces: registry entry `scipy_stats_brython: { aliases: ['scipy', 'scipy.stats'], deps: [], js: [] }` (alias order binding: plain before dotted).

- [ ] **Step 1: Write the failing scan test**

Append to `brython/tests/test_engine_scan.py`:

```python
def test_scipy_alias_resolves_to_canonical():
    assert scan('from scipy import stats') == ['scipy_stats_brython']
    assert scan('import scipy.stats as st') == ['scipy_stats_brython']
    assert scan('from scipy.stats import norm, ttest_ind') == ['scipy_stats_brython']
    assert scan('import scipy_stats_brython as st') == ['scipy_stats_brython']
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest brython/tests/test_engine_scan.py -q`
Expected: new test FAILS (`[] != ['scipy_stats_brython']`).

- [ ] **Step 3: Add the registry entry**

In `js/brython-engine.js`, extend `LIB_REGISTRY` (after the matplotlib entry, same comment style):

```js
    // aliasrekkefølgen bindende her også: 'scipy' før 'scipy.stats'
    scipy_stats_brython:    { aliases: ['scipy', 'scipy.stats'],
                              deps: [], js: [] }
```

- [ ] **Step 4: Verify**

Run: `node --check js/brython-engine.js && python3 -m pytest brython/tests/test_engine_scan.py -q`
Expected: OK / all PASS.

- [ ] **Step 5: Create the example**

Create `examples/bry14_scipy_stats.txt`:

```
# Example: scipy.stats i Brython-modus — fordelinger og hypotesetester
# Ren-Python-implementasjon, diff-testet mot ekte scipy.
from scipy import stats

# t-test: er det forskjell mellom to grupper?
nord = [12.9, 13.5, 12.8, 15.6, 17.2, 19.2, 12.6, 15.3]
sor  = [14.2, 12.1, 13.8, 16.1, 15.5, 18.0, 13.1, 16.5]
res = stats.ttest_ind(nord, sor)
print("t =", round(res.statistic, 3), " p =", round(res.pvalue, 4))

# Kjikvadrat: henger region og svar sammen?
tabell = [[23, 11, 8],
          [14, 19, 12]]
chi = stats.chi2_contingency(tabell)
print("chi2 =", round(chi.statistic, 2), " p =", round(chi.pvalue, 4), " dof =", chi.dof)

# Normalfordelingen: kritiske verdier og sannsynligheter
print("95%-kvantil:", round(stats.norm.ppf(0.975), 3))
print("P(Z < 1.5) =", round(stats.norm.cdf(1.5), 4))

# Korrelasjon med p-verdi
r = stats.pearsonr(nord, sor)
print("r =", round(r.statistic, 3), " p =", round(r.pvalue, 4))
```

- [ ] **Step 6: Add the example button**

In `index.html`, directly after the bry13 button, insert:

```html
              <button type="button" data-example="bry14_scipy_stats.txt" data-mode="brython" data-i18n>scipy.stats &mdash; tester og fordelinger</button>
```

- [ ] **Step 7: Full suite + commit**

Run: `python3 -m pytest brython/tests/ -q && node --check js/brython-engine.js`
Expected: all PASS.

```bash
git add js/brython-engine.js examples/bry14_scipy_stats.txt index.html brython/tests/test_engine_scan.py
git commit -m "feat(brython): register scipy_stats_brython with scipy/scipy.stats aliases + example"
```

---

### Task 6: Browser verification

**Files:** none (verification only). CPython-blind risks to verify in real Brython: `math.lgamma/erf/erfc` precision (spike checked existence + two values), `from scipy.stats import norm` (dotted alias + from-import), iteration/generator-heavy numerics (Lentz loops), and the example end-to-end.

- [ ] **Step 1: Serve** — `python3 -m http.server 8765 --directory /Users/hom/Documents/GitHub/microdata`

- [ ] **Step 2: Engine checks via BrythonEngine.run(...)**
1. `from scipy import stats\nprint(stats.norm.ppf(0.975))` → ≈1.959963984540054, no error.
2. `from scipy.stats import norm, ttest_ind\nprint(round(norm.cdf(1.96), 6))\nprint(ttest_ind([1,2,3,4],[2,3,4,5]).pvalue > 0.05)` → 0.975002 / True.
3. Numeric spot-check vs known scipy values computed on the dev machine (same inputs as the diff tests): `stats.t.ppf(0.975, 10)` ≈ 2.2281388519649385, `stats.chi2.ppf(0.95, 5)` ≈ 11.070497693516351, `stats.f.cdf(1.5, 3, 7)` — compare to `python3 -c "from scipy import stats; print(stats.f.cdf(1.5, 3, 7))"` locally; agreement to ≥9 decimals.
4. The bry14 example verbatim → all printed lines present, no error.

- [ ] **Step 3: Record results; fix + commit anything found.**

---

### Task 7: Port to safestat and openstat

**Files:**
- Copy to `../safestat` then `../openstat`: `js/brython-engine.js`, `brython/scipy_stats_brython.py`, `brython/tests/test_scipy_stats_brython.py`, `brython/tests/test_scipy_stats_brython_diff.py`, `brython/tests/test_engine_scan.py`, `examples/bry14_scipy_stats.txt`
- Insert the bry14 button after each sibling's bry13 button in index.html (same line as Task 5 Step 6)

- [ ] **Step 1: Copy files (safestat first) + insert buttons**

```bash
cd /Users/hom/Documents/GitHub
for sib in safestat openstat; do
  cp microdata/js/brython-engine.js            $sib/js/brython-engine.js
  cp microdata/brython/scipy_stats_brython.py  $sib/brython/
  cp microdata/brython/tests/test_scipy_stats_brython.py      $sib/brython/tests/
  cp microdata/brython/tests/test_scipy_stats_brython_diff.py $sib/brython/tests/
  cp microdata/brython/tests/test_engine_scan.py $sib/brython/tests/
  cp microdata/examples/bry14_scipy_stats.txt  $sib/examples/
done
```

- [ ] **Step 2: Run each sibling's suite**

```bash
(cd safestat && python3 -m pytest brython/tests/ -q)
(cd openstat && python3 -m pytest brython/tests/ -q)
```
Expected: all PASS in both.

- [ ] **Step 3: sync_check + commit each repo**

```bash
(cd safestat && sh scripts/sync_check.sh)
(cd safestat && git add -A brython/ js/brython-engine.js examples/bry14_scipy_stats.txt index.html && git commit -m "feat(brython): scipy.stats subset (ported from microdata)")
(cd openstat && git add -A brython/ js/brython-engine.js examples/bry14_scipy_stats.txt index.html && git commit -m "feat(brython): scipy.stats subset (ported from microdata)")
```

- [ ] **Step 4: Safestat browser smoke** (serve on 8766; run check 1 from Task 6).
