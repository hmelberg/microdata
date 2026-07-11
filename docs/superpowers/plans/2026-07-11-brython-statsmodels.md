# Brython statsmodels Formula API Implementation Plan (Stage 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Brython-mode users run `import statsmodels.formula.api as smf; smf.ols('y ~ alder + region', df).fit().summary()` — OLS and Logit with formula parsing, in pure Python, diff-tested against statsmodels 0.14.6.

**Architecture:** One module `brython/statsmodels_brython.py`. A small formula parser (`y ~ x1 + C(kat) - 1`, auto-categorical string columns with patsy-compatible naming `region[T.S]` / `C(region)[T.S]`, sorted levels, first dropped) builds a design matrix from duck-typed data (dict-of-lists or pandas_brython DataFrame). OLS solves normal equations via Gauss-Jordan with partial pivoting; Logit uses Newton–Raphson. Inference (bse/t/p/conf_int) reuses stage 3's `scipy_stats_brython` distributions. Results expose dict-based params (spike-verified: statsmodels' param ORDER differs from formula order, so diff tests compare by name) and a `summary()` object whose `to_html()` renders through the app's existing table embed path.

**Tech Stack:** Brython 3.12 / CPython 3.13 + pytest; statsmodels 0.14.6 + pandas on the dev machine for diff-tests (importorskip'd); stage-1 lazy engine, stage-2 dotted aliases, stage-3 distributions.

## Global Constraints

- `brython/statsmodels_brython.py` runs under BOTH CPython 3.13 and Brython 3.12 — imports ONLY `math` and `scipy_stats_brython` (its LIB_REGISTRY entry therefore declares `deps: ['scipy_stats_brython']`).
- Brython-feller (AST-guarded automatically): no method/global name collisions; setdefault only with string literals.
- Patsy-compatible naming fixed by spike (2026-07-11, statsmodels 0.14.6): intercept name `'Intercept'`; auto-categorical string column `region` → `'region[T.S]'`; explicit `C(region)` → `'C(region)[T.S]'`; levels sorted ascending, FIRST level dropped (treatment coding).
- `params`/`bse`/`tvalues`/`pvalues` are plain dicts keyed by those names — diff tests MUST compare by name, never by position.
- Degenerate-input convention from stage 3: plausible bad input → Norwegian `ValueError` or nan, never a raw ZeroDivisionError.
- Diff tolerances: OLS rel=1e-6 (normal equations vs statsmodels' QR); Logit rel=1e-5.
- predict() on new data with an unseen categorical level raises Norwegian ValueError (statsmodels also errors; silent zeros would be a wrong answer).
- Norwegian user-facing error strings. NO sw.js changes. Development on a feature branch in microdata; port safestat-first at the end.

---

### Task 1: Formula parsing + design matrix

**Files:**
- Create: `brython/statsmodels_brython.py`
- Test: `brython/tests/test_statsmodels_brython.py` (new)

**Interfaces:**
- Produces (Tasks 2–4 consume): `_parse_formula(formula) -> (yname, terms, intercept)`; `_col(data, name) -> list` (Norwegian error on unknown column); `_build_design(formula, data) -> (y, names, X, spec)` where `y` is a list, `names` a list of coefficient names (`'Intercept'` first when intercept), `X` a list of rows, and `spec` a list of term specs `('num', col)` / `('cat', col, levels, prefix)` used later by predict; `_design_from_spec(spec, intercept, data, n=None) -> (names, X)` (n = row count, inferred from the first term when omitted).

- [ ] **Step 1: Write the failing tests**

Create `brython/tests/test_statsmodels_brython.py`:

```python
import sys, os, math
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import pytest
import statsmodels_brython as smb

DATA = {
    'y':      [1.0, 2.1, 2.9, 4.2, 5.1, 5.8],
    'x':      [1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
    'region': ['N', 'S', 'N', 'S', 'O', 'O'],
}

def test_parse_formula_basic():
    y, terms, intercept = smb._parse_formula('y ~ x + region')
    assert y == 'y' and terms == ['x', 'region'] and intercept is True

def test_parse_formula_no_intercept_and_c():
    y, terms, intercept = smb._parse_formula('y ~ C(region) + x - 1')
    assert terms == ['C(region)', 'x'] and intercept is False
    _, _, i0 = smb._parse_formula('y ~ x + 0')
    assert i0 is False

def test_parse_formula_errors():
    with pytest.raises(ValueError):
        smb._parse_formula('bare_en_side')
    with pytest.raises(ValueError):
        smb._parse_formula(' ~ x')

def test_build_design_numeric_and_auto_categorical():
    yv, names, X, spec = smb._build_design('y ~ x + region', DATA)
    assert yv == DATA['y']
    # patsy-navngiving: sorterte nivåer (N, O, S), første droppet
    assert names == ['Intercept', 'x', 'region[T.O]', 'region[T.S]']
    assert X[0] == [1.0, 1.0, 0.0, 0.0]      # rad 1: region N (basis)
    assert X[4] == [1.0, 5.0, 1.0, 0.0]      # rad 5: region O
    assert X[1] == [1.0, 2.0, 0.0, 1.0]      # rad 2: region S

def test_build_design_explicit_c_naming():
    _, names, _, _ = smb._build_design('y ~ C(region)', DATA)
    assert names == ['Intercept', 'C(region)[T.O]', 'C(region)[T.S]']

def test_build_design_no_intercept():
    _, names, X, _ = smb._build_design('y ~ x - 1', DATA)
    assert names == ['x'] and X[2] == [3.0]

def test_build_design_unknown_column():
    with pytest.raises(ValueError):
        smb._build_design('y ~ finnes_ikke', DATA)

def test_design_from_spec_unseen_level_raises():
    _, _, _, spec = smb._build_design('y ~ region', DATA)
    with pytest.raises(ValueError):
        smb._design_from_spec(spec, True, {'region': ['N', 'UKJENT']})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/hom/Documents/GitHub/microdata && python3 -m pytest brython/tests/test_statsmodels_brython.py -q`
Expected: FAIL at import — `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

Create `brython/statsmodels_brython.py`:

```python
# statsmodels_brython — statsmodels-formel-API (OLS + Logit) i ren Python.
# Importeres som `import statsmodels.formula.api as smf` (aliaser i
# LIB_REGISTRY) eller direkte som statsmodels_brython.
#
# Formler: 'y ~ x1 + x2 + C(kat)' med '- 1'/'+ 0' for uten konstantledd.
# Strengkolonner behandles automatisk som kategoriske (som statsmodels);
# navngiving følger patsy: 'region[T.S]' / 'C(region)[T.S]', sorterte
# nivåer, første nivå droppes (treatment-koding). params/bse/tvalues/
# pvalues er dict-er nøklet på disse navnene.
#
# NB Brython-feller (AST-vakter i test_brython_scoping_trap.py): ingen
# metode refererer global med metodens navn; setdefault kun streng-nøkler.
import math
import scipy_stats_brython as _stats


def _col(data, name):
    """Hent en kolonne som liste — duck-typet (dict-of-lists eller
    pandas_brython DataFrame/Series)."""
    try:
        ser = data[name]
    except Exception:
        raise ValueError('ukjent kolonne i formelen: ' + name)
    if hasattr(ser, 'tolist'):
        return list(ser.tolist())
    if hasattr(ser, 'values') and not isinstance(ser, (list, tuple)):
        vals = ser.values
        return list(vals() if callable(vals) else vals)
    return list(ser)


def _parse_formula(formula):
    """'y ~ x1 + C(kat) - 1' -> ('y', ['x1', 'C(kat)'], False)."""
    left, sep, right = formula.partition('~')
    yname = left.strip()
    if not sep or not yname or not right.strip():
        raise ValueError("formelen må ha formen 'y ~ x1 + x2'")
    rhs = right.replace(' ', '')
    intercept = True
    terms = []
    for tok in rhs.replace('-1', '+&NOINT&').split('+'):
        if not tok:
            continue
        if tok in ('&NOINT&', '0'):
            intercept = False
        elif tok != '1':
            terms.append(tok)
    return yname, terms, intercept


def _is_categorical(values):
    return any(isinstance(v, str) for v in values)


def _levels_sorted(values):
    seen = []
    for v in values:
        if v not in seen:
            seen.append(v)
    return sorted(seen, key=str)


def _term_spec(term, data):
    """Én formelterm -> spec-oppføring ('num', col) | ('cat', col, levels, prefix)."""
    if term.startswith('C(') and term.endswith(')'):
        col = term[2:-1].strip()
        levels = _levels_sorted(_col(data, col))
        return ('cat', col, levels, 'C(%s)' % col)
    vals = _col(data, term)
    if _is_categorical(vals):
        return ('cat', term, _levels_sorted(vals), term)
    return ('num', term)


def _design_from_spec(spec, intercept, data, n=None):
    """Bygg (names, X) fra en spec — brukes både ved fit og predict.
    n = antall rader; utledes fra første term når den ikke oppgis
    (ren-intercept-spec uten n gir ValueError). Ukjent kategorinivå i nye
    data gir ValueError (som statsmodels)."""
    if n is None:
        if not spec:
            raise ValueError('kan ikke bygge designmatrise uten termer og uten n')
        n = len(_col(data, _spec_col(spec[0])))
    names = ['Intercept'] if intercept else []
    columns = [[1.0] * n] if intercept else []
    for entry in spec:
        if entry[0] == 'num':
            vals = _col(data, entry[1])
            names.append(entry[1])
            columns.append([float(v) for v in vals])
        else:
            _, col, levels, prefix = entry
            vals = _col(data, col)
            for v in vals:
                if v not in levels:
                    raise ValueError('ukjent kategorinivå %r i kolonnen %s'
                                     % (v, col))
            for lev in levels[1:]:
                names.append('%s[T.%s]' % (prefix, lev))
                columns.append([1.0 if v == lev else 0.0 for v in vals])
    n = len(columns[0]) if columns else 0
    X = [[c[i] for c in columns] for i in range(n)]
    return names, X


def _spec_col(entry):
    return entry[1]


def _build_design(formula, data):
    """Formel + data -> (y, names, X, spec)."""
    yname, terms, intercept = _parse_formula(formula)
    y = [float(v) for v in _col(data, yname)]
    spec = [_term_spec(t, data) for t in terms]
    names, X = _design_from_spec(spec, intercept, data, n=len(y))
    if not names:
        raise ValueError('formelen har ingen forklaringsvariabler')
    return y, names, X, spec
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest brython/tests/test_statsmodels_brython.py brython/tests/test_brython_scoping_trap.py -q`
Expected: 8 + 2 PASS.

- [ ] **Step 5: Commit**

```bash
git add brython/statsmodels_brython.py brython/tests/test_statsmodels_brython.py
git commit -m "feat(brython): statsmodels formula parser + patsy-compatible design matrix"
```

---

### Task 2: Gauss-Jordan solver + OLS fit

**Files:**
- Modify: `brython/statsmodels_brython.py` (append)
- Test: `brython/tests/test_statsmodels_brython.py` (append) and create `brython/tests/test_statsmodels_brython_diff.py`

**Interfaces:**
- Consumes: `_build_design`, `_stats.t` / `_stats.f` (scipy_stats_brython).
- Produces: `_solve(A, B) -> X` (solves A·X=B, A n×n, B n×m; Norwegian error on singular); `ols(formula, data) -> OLSModel`; `OLSModel.fit() -> OLSResults` with dict attrs `params/bse/tvalues/pvalues`, floats `rsquared/rsquared_adj/fvalue/f_pvalue`, ints `nobs/df_resid/df_model`, lists `fittedvalues/resid`, and internals `_names/_spec/_intercept/_cov` used by Task 3.

- [ ] **Step 1: Write the failing tests**

Append to `brython/tests/test_statsmodels_brython.py`:

```python
def test_solve_known_system():
    # 2a + b = 5 ; a + 3b = 10  =>  a = 1, b = 3
    X = smb._solve([[2.0, 1.0], [1.0, 3.0]], [[5.0], [10.0]])
    assert abs(X[0][0] - 1.0) < 1e-12 and abs(X[1][0] - 3.0) < 1e-12

def test_solve_singular_raises():
    with pytest.raises(ValueError):
        smb._solve([[1.0, 2.0], [2.0, 4.0]], [[1.0], [2.0]])

def test_ols_perfect_line():
    d = {'y': [3.0, 5.0, 7.0, 9.0], 'x': [1.0, 2.0, 3.0, 4.0]}
    res = smb.ols('y ~ x', d).fit()
    assert res.params['Intercept'] == pytest.approx(1.0, abs=1e-10)
    assert res.params['x'] == pytest.approx(2.0, abs=1e-10)
    assert res.rsquared == pytest.approx(1.0, abs=1e-12)
    assert res.nobs == 4 and res.df_resid == 2

def test_ols_collinear_raises_norwegian():
    d = {'y': [1.0, 2.0, 3.0], 'a': [1.0, 2.0, 3.0], 'b': [2.0, 4.0, 6.0]}
    with pytest.raises(ValueError):
        smb.ols('y ~ a + b', d).fit()

def test_ols_fittedvalues_and_resid():
    d = {'y': [1.0, 2.0, 2.0, 3.0], 'x': [1.0, 2.0, 3.0, 4.0]}
    res = smb.ols('y ~ x', d).fit()
    assert len(res.fittedvalues) == 4
    for f_, r_, yv in zip(res.fittedvalues, res.resid, d['y']):
        assert f_ + r_ == pytest.approx(yv, abs=1e-12)
```

Create `brython/tests/test_statsmodels_brython_diff.py`:

```python
# Differensialtester mot ekte statsmodels 0.14.6 — kun der det finnes.
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import pytest
smf = pytest.importorskip('statsmodels.formula.api')
pd = pytest.importorskip('pandas')
import statsmodels_brython as smb

RAW = {
    'y':      [12.9, 13.5, 12.8, 15.6, 17.2, 19.2, 12.6, 15.3, 14.4, 11.3, 16.1, 18.3],
    'alder':  [34.0, 41.0, 29.0, 52.0, 38.0, 45.0, 31.0, 47.0, 36.0, 27.0, 50.0, 44.0],
    'region': ['N', 'S', 'N', 'S', 'O', 'O', 'N', 'S', 'O', 'N', 'S', 'O'],
}

def _both(formula):
    mine = smb.ols(formula, RAW).fit()
    ref = smf.ols(formula, pd.DataFrame(RAW)).fit()
    return mine, ref

def test_ols_diff_numeric_and_categorical():
    mine, ref = _both('y ~ alder + region')
    for name in ref.params.index:
        assert mine.params[name] == pytest.approx(ref.params[name], rel=1e-6)
        assert mine.bse[name] == pytest.approx(ref.bse[name], rel=1e-6)
        assert mine.tvalues[name] == pytest.approx(ref.tvalues[name], rel=1e-6)
        assert mine.pvalues[name] == pytest.approx(ref.pvalues[name], rel=1e-6)
    assert mine.rsquared == pytest.approx(ref.rsquared, rel=1e-8)
    assert mine.rsquared_adj == pytest.approx(ref.rsquared_adj, rel=1e-8)
    assert mine.fvalue == pytest.approx(ref.fvalue, rel=1e-6)
    assert mine.f_pvalue == pytest.approx(ref.f_pvalue, rel=1e-6)
    assert mine.nobs == ref.nobs
    assert mine.df_resid == ref.df_resid and mine.df_model == ref.df_model

def test_ols_diff_c_notation_and_no_intercept():
    mine, ref = _both('y ~ C(region) + alder')
    for name in ref.params.index:
        assert mine.params[name] == pytest.approx(ref.params[name], rel=1e-6)
    mine0, ref0 = _both('y ~ alder - 1')
    assert mine0.params['alder'] == pytest.approx(ref0.params['alder'], rel=1e-6)
    assert mine0.bse['alder'] == pytest.approx(ref0.bse['alder'], rel=1e-6)
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest brython/tests/test_statsmodels_brython.py brython/tests/test_statsmodels_brython_diff.py -q`
Expected: new tests FAIL with `AttributeError: ... no attribute '_solve'` / `'ols'`.

- [ ] **Step 3: Implement**

Append to `brython/statsmodels_brython.py`:

```python
# ── lineær algebra ──────────────────────────────────────────────────────────

def _solve(A, B):
    """Løs A·X = B (A n×n, B n×m) med Gauss-Jordan og delvis pivotering.
    Muterer ikke input. Norsk feil ved singulær matrise."""
    n = len(A)
    M = [list(Arow) + list(Brow) for Arow, Brow in zip(A, B)]
    width = len(M[0])
    for colidx in range(n):
        piv = max(range(colidx, n), key=lambda r: abs(M[r][colidx]))
        if abs(M[piv][colidx]) < 1e-12:
            raise ValueError('designmatrisen er singulær — perfekt '
                             'kolineære kolonner i formelen?')
        M[colidx], M[piv] = M[piv], M[colidx]
        pv = M[colidx][colidx]
        M[colidx] = [v / pv for v in M[colidx]]
        for r in range(n):
            if r != colidx and M[r][colidx] != 0.0:
                factor = M[r][colidx]
                Mc = M[colidx]
                M[r] = [a - factor * b for a, b in zip(M[r], Mc)]
    return [row[n:width] for row in M]


def _xtx_xty(X, y):
    k = len(X[0])
    xtx = [[sum(row[i] * row[j] for row in X) for j in range(k)]
           for i in range(k)]
    xty = [[sum(row[i] * yv for row, yv in zip(X, y))] for i in range(k)]
    return xtx, xty


# ── OLS ─────────────────────────────────────────────────────────────────────

class OLSResults:
    def __init__(self, names, beta, cov, y, X, intercept, spec):
        self._names = names
        self._spec = spec
        self._intercept = intercept
        self._cov = cov
        n = len(y)
        k = len(names)
        self.nobs = n
        self.df_resid = n - k
        self.df_model = k - 1 if intercept else k
        self.params = {nm: b for nm, b in zip(names, beta)}
        self.fittedvalues = [sum(b * xv for b, xv in zip(beta, row))
                             for row in X]
        self.resid = [yv - fv for yv, fv in zip(y, self.fittedvalues)]
        ssr = sum(r * r for r in self.resid)
        ymean = sum(y) / n
        sst = (sum((v - ymean) ** 2 for v in y) if intercept
               else sum(v * v for v in y))
        self.rsquared = 1.0 - ssr / sst if sst > 0.0 else float('nan')
        self.rsquared_adj = (1.0 - (1.0 - self.rsquared) * (n - (1 if intercept else 0))
                             / self.df_resid) if self.df_resid > 0 else float('nan')
        self.bse = {}
        self.tvalues = {}
        self.pvalues = {}
        for i, nm in enumerate(names):
            se = math.sqrt(cov[i][i]) if cov[i][i] > 0.0 else float('nan')
            self.bse[nm] = se
            tv = self.params[nm] / se if se and se > 0.0 else float('nan')
            self.tvalues[nm] = tv
            self.pvalues[nm] = (2.0 * _stats.t.sf(abs(tv), self.df_resid)
                                if tv == tv and self.df_resid > 0 else float('nan'))
        if self.df_model > 0 and self.df_resid > 0 and ssr > 0.0 and sst > ssr:
            self.fvalue = ((sst - ssr) / self.df_model) / (ssr / self.df_resid)
            self.f_pvalue = _stats.f.sf(self.fvalue, self.df_model, self.df_resid)
        else:
            self.fvalue = float('nan')
            self.f_pvalue = float('nan')


class OLSModel:
    def __init__(self, formula, data):
        self._formula = formula
        self._data = data

    def fit(self, **kwargs):
        y, names, X, spec = _build_design(self._formula, self._data)
        n, k = len(X), len(names)
        if n <= k:
            raise ValueError('ols: for få observasjoner (%d) til %d '
                             'koeffisienter' % (n, k))
        xtx, xty = _xtx_xty(X, y)
        beta = [row[0] for row in _solve(xtx, xty)]
        fitted = [sum(b * xv for b, xv in zip(beta, row)) for row in X]
        ssr = sum((yv - fv) ** 2 for yv, fv in zip(y, fitted))
        sigma2 = ssr / (n - k)
        identity = [[1.0 if i == j else 0.0 for j in range(k)] for i in range(k)]
        xtx_inv = _solve(xtx, identity)
        cov = [[sigma2 * xtx_inv[i][j] for j in range(k)] for i in range(k)]
        _, _, intercept = _parse_formula(self._formula)
        return OLSResults(names, beta, cov, y, X, intercept, spec)


def ols(formula, data):
    return OLSModel(formula, data)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest brython/tests/test_statsmodels_brython.py brython/tests/test_statsmodels_brython_diff.py -q`
Expected: all PASS (13 + 2 diff).

- [ ] **Step 5: Commit**

```bash
git add brython/statsmodels_brython.py brython/tests/test_statsmodels_brython.py brython/tests/test_statsmodels_brython_diff.py
git commit -m "feat(brython): OLS via Gauss-Jordan, diff-tested against statsmodels"
```

---

### Task 3: predict, conf_int, summary()

**Files:**
- Modify: `brython/statsmodels_brython.py` (methods on OLSResults + Summary class)
- Test: both test files (append)

**Interfaces:**
- Consumes: `OLSResults` internals (`_names/_spec/_intercept`), `_design_from_spec`, `_stats.t.ppf`.
- Produces: `OLSResults.predict(data=None) -> list` (None → fittedvalues copy; new data → rebuilt design, Norwegian error on unseen level); `OLSResults.conf_int(alpha=0.05) -> dict name -> [lo, hi]`; `OLSResults.summary() -> Summary` where `Summary.to_html() -> str` (an `<table class="output-table">`; the runner's `_fmt` renders any object with to_html) and `str(Summary)` is a plain-text fallback. Task 4 reuses `Summary` for Logit.

- [ ] **Step 1: Write the failing tests**

Append to `brython/tests/test_statsmodels_brython.py`:

```python
def test_predict_none_and_new_data():
    d = {'y': [3.0, 5.0, 7.0, 9.0], 'x': [1.0, 2.0, 3.0, 4.0]}
    res = smb.ols('y ~ x', d).fit()
    assert res.predict() == pytest.approx(res.fittedvalues)
    nye = res.predict({'x': [10.0]})
    assert nye[0] == pytest.approx(21.0, abs=1e-9)     # 1 + 2*10

def test_predict_unseen_level_raises():
    res = smb.ols('y ~ region', {'y': [1.0, 2.0, 3.0],
                                 'region': ['N', 'S', 'N']}).fit()
    with pytest.raises(ValueError):
        res.predict({'region': ['UKJENT']})

def test_conf_int_contains_params():
    d = {'y': [1.0, 2.4, 2.9, 4.1, 5.2], 'x': [1.0, 2.0, 3.0, 4.0, 5.0]}
    res = smb.ols('y ~ x', d).fit()
    ci = res.conf_int()
    for nm in res.params:
        lo, hi = ci[nm]
        assert lo < res.params[nm] < hi

def test_summary_html_structure():
    d = {'y': [1.0, 2.4, 2.9, 4.1, 5.2], 'x': [1.0, 2.0, 3.0, 4.0, 5.0]}
    s = smb.ols('y ~ x', d).fit().summary()
    html = s.to_html()
    assert '<table class="output-table"' in html
    assert 'Intercept' in html and 'x' in html
    assert 'R²' in html or 'R&#178;' in html
    assert 'koef' in html.lower()
    assert 'Intercept' in str(s)                        # tekst-fallback
```

Append to `brython/tests/test_statsmodels_brython_diff.py`:

```python
def test_predict_and_conf_int_diff():
    mine = smb.ols('y ~ alder + region', RAW).fit()
    ref = smf.ols('y ~ alder + region', pd.DataFrame(RAW)).fit()
    nydata = {'alder': [30.0, 48.0], 'region': ['N', 'S']}
    mp = mine.predict(nydata)
    rp = ref.predict(pd.DataFrame(nydata))
    for a, b in zip(mp, list(rp)):
        assert a == pytest.approx(float(b), rel=1e-6)
    rci = ref.conf_int()
    mci = mine.conf_int()
    for name in ref.params.index:
        assert mci[name][0] == pytest.approx(float(rci.loc[name][0]), rel=1e-6)
        assert mci[name][1] == pytest.approx(float(rci.loc[name][1]), rel=1e-6)
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest brython/tests/test_statsmodels_brython.py brython/tests/test_statsmodels_brython_diff.py -q`
Expected: new tests FAIL with AttributeError (`predict` not defined).

- [ ] **Step 3: Implement**

Add methods to `OLSResults` (inside the class) and the `Summary` class (module level, after OLSResults):

```python
    # (metoder i OLSResults)
    def predict(self, data=None):
        if data is None:
            return list(self.fittedvalues)
        names, X = _design_from_spec(self._spec, self._intercept, data)
        beta = [self.params[nm] for nm in names]
        return [sum(b * xv for b, xv in zip(beta, row)) for row in X]

    def conf_int(self, alpha=0.05):
        q = _stats.t.ppf(1.0 - alpha / 2.0, self.df_resid)
        out = {}
        for nm in self._names:
            b, se = self.params[nm], self.bse[nm]
            out[nm] = ([b - q * se, b + q * se] if se == se
                       else [float('nan'), float('nan')])
        return out

    def summary(self):
        stats_rows = [
            ('Observasjoner', '%d' % self.nobs),
            ('R²', '%.4f' % self.rsquared),
            ('Justert R²', '%.4f' % self.rsquared_adj),
            ('F-statistikk', '%.4g (p=%.4g)' % (self.fvalue, self.f_pvalue)),
        ]
        return Summary('OLS-regresjon', stats_rows, self._names, self.params,
                       self.bse, self.tvalues, self.pvalues, self.conf_int())
```

```python
class Summary:
    """summary()-objekt: to_html() rendres av appens tabell-embed;
    str() gir tekst-fallback."""

    def __init__(self, title, stats_rows, names, params, bse, tvalues,
                 pvalues, ci, stat_label='t'):
        self._title = title
        self._stats_rows = stats_rows
        self._names = names
        self._params = params
        self._bse = bse
        self._tvalues = tvalues
        self._pvalues = pvalues
        self._ci = ci
        self._stat_label = stat_label

    def to_html(self):
        parts = ['<table class="output-table" data-summary="1">']
        parts.append('<caption>%s</caption>' % self._title)
        parts.append('<thead><tr><th></th><th>koef</th><th>std.feil</th>'
                     '<th>%s</th><th>P&gt;|%s|</th><th>[0.025</th>'
                     '<th>0.975]</th></tr></thead><tbody>'
                     % (self._stat_label, self._stat_label))
        for nm in self._names:
            lo, hi = self._ci[nm]
            parts.append(
                '<tr><th>%s</th><td>%.4f</td><td>%.4f</td><td>%.3f</td>'
                '<td>%.4f</td><td>%.3f</td><td>%.3f</td></tr>'
                % (nm, self._params[nm], self._bse[nm], self._tvalues[nm],
                   self._pvalues[nm], lo, hi))
        parts.append('</tbody></table>')
        rows = ''.join('<tr><th>%s</th><td>%s</td></tr>' % (k, v)
                       for k, v in self._stats_rows)
        parts.append('<table class="output-table"><tbody>%s</tbody></table>'
                     % rows)
        return ''.join(parts)

    def __str__(self):
        lines = [self._title]
        for k, v in self._stats_rows:
            lines.append('%s: %s' % (k, v))
        lines.append('%-24s %10s %10s %8s %8s' % ('', 'koef', 'std.feil',
                                                  self._stat_label, 'p'))
        for nm in self._names:
            lines.append('%-24s %10.4f %10.4f %8.3f %8.4f'
                         % (nm, self._params[nm], self._bse[nm],
                            self._tvalues[nm], self._pvalues[nm]))
        return '\n'.join(lines)

    def __repr__(self):
        return self.__str__()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest brython/tests/test_statsmodels_brython.py brython/tests/test_statsmodels_brython_diff.py -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add brython/statsmodels_brython.py brython/tests/test_statsmodels_brython.py brython/tests/test_statsmodels_brython_diff.py
git commit -m "feat(brython): OLS predict/conf_int/summary with html table rendering"
```

---

### Task 4: Logit via Newton–Raphson

**Files:**
- Modify: `brython/statsmodels_brython.py` (append)
- Test: both test files (append)

**Interfaces:**
- Consumes: `_build_design`, `_design_from_spec`, `_solve`, `Summary`, `_stats.norm`.
- Produces: `logit(formula, data) -> LogitModel`; `LogitModel.fit(**kw) -> LogitResults` (kwargs like disp accepted and ignored) with dicts `params/bse/tvalues/pvalues` (z-based), floats `llf/llnull/prsquared`, `nobs`, bool `converged`, lists `fittedvalues` (probabilities), `predict(data=None) -> list of probabilities`, `conf_int(alpha=0.05)` (norm-based), `summary() -> Summary` (stat_label 'z').

- [ ] **Step 1: Write the failing tests**

Append to `brython/tests/test_statsmodels_brython.py`:

```python
def test_logit_intercept_only_exact():
    # ren-intercept-logit: koef = log(p/(1-p)), p = 3/4
    d = {'y': [1.0, 1.0, 1.0, 0.0], 'x': [1.0, 2.0, 3.0, 4.0]}
    res = smb.logit('y ~ 1', d).fit()
    assert res.params['Intercept'] == pytest.approx(math.log(3.0), rel=1e-6)
    assert res.converged is True

def test_logit_requires_binary_y():
    with pytest.raises(ValueError):
        smb.logit('y ~ x', {'y': [0.0, 2.0], 'x': [1.0, 2.0]}).fit()

def test_logit_predict_probabilities():
    d = {'y': [0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 1.0],
         'x': [1.0, 2.0, 3.0, 4.0, 2.0, 5.0, 6.0, 5.0]}
    res = smb.logit('y ~ x', d).fit()
    probs = res.predict()
    assert all(0.0 < p < 1.0 for p in probs)
    assert res.predict({'x': [6.0]})[0] > res.predict({'x': [1.0]})[0]
```

Append to `brython/tests/test_statsmodels_brython_diff.py`:

```python
LOGIT_RAW = {
    'kjopt': [0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0, 0.0, 1.0, 1.0,
              0.0, 1.0, 0.0, 1.0],
    'pris':  [9.5, 8.7, 3.2, 4.1, 7.8, 2.5, 3.9, 8.1, 4.4, 9.0, 2.8, 5.0,
              6.9, 3.5, 7.2, 4.8],
    'by':    ['O', 'B', 'O', 'B', 'O', 'B', 'O', 'B', 'O', 'B', 'O', 'B',
              'O', 'B', 'O', 'B'],
}

def test_logit_diff():
    mine = smb.logit('kjopt ~ pris + by', LOGIT_RAW).fit()
    ref = smf.logit('kjopt ~ pris + by', pd.DataFrame(LOGIT_RAW)).fit(disp=0)
    for name in ref.params.index:
        assert mine.params[name] == pytest.approx(ref.params[name], rel=1e-5)
        assert mine.bse[name] == pytest.approx(ref.bse[name], rel=1e-5)
        assert mine.pvalues[name] == pytest.approx(ref.pvalues[name], rel=1e-5)
    assert mine.llf == pytest.approx(ref.llf, rel=1e-8)
    assert mine.prsquared == pytest.approx(ref.prsquared, rel=1e-6)
    mp = mine.predict({'pris': [4.0, 8.0], 'by': ['O', 'B']})
    rp = ref.predict(pd.DataFrame({'pris': [4.0, 8.0], 'by': ['O', 'B']}))
    for a, b in zip(mp, list(rp)):
        assert a == pytest.approx(float(b), rel=1e-5)
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest brython/tests/test_statsmodels_brython.py brython/tests/test_statsmodels_brython_diff.py -q`
Expected: new tests FAIL with AttributeError (`logit`).

- [ ] **Step 3: Implement**

Append to `brython/statsmodels_brython.py`:

```python
# ── Logit ───────────────────────────────────────────────────────────────────

def _logit_newton(X, y, max_iter=50, tol=1e-8):
    """Newton–Raphson for logistisk regresjon. Returnerer (beta, cov,
    llf, converged). mu klippes mot [1e-10, 1-1e-10] for stabilitet."""
    n = len(X)
    k = len(X[0])
    beta = [0.0] * k
    converged = False
    cov = None
    for _ in range(max_iter):
        eta = [sum(b * xv for b, xv in zip(beta, row)) for row in X]
        mu = [1.0 / (1.0 + math.exp(-min(35.0, max(-35.0, e)))) for e in eta]
        mu = [min(1.0 - 1e-10, max(1e-10, m)) for m in mu]
        grad = [[sum(row[i] * (yv - m) for row, yv, m in zip(X, y, mu))]
                for i in range(k)]
        W = [m * (1.0 - m) for m in mu]
        H = [[sum(row[i] * row[j] * w for row, w in zip(X, W))
              for j in range(k)] for i in range(k)]
        delta = [row[0] for row in _solve(H, grad)]
        beta = [b + d for b, d in zip(beta, delta)]
        if max(abs(d) for d in delta) < tol:
            converged = True
            identity = [[1.0 if i == j else 0.0 for j in range(k)]
                        for i in range(k)]
            cov = _solve(H, identity)
            break
    if cov is None:
        identity = [[1.0 if i == j else 0.0 for j in range(k)]
                    for i in range(k)]
        cov = _solve(H, identity)
    eta = [sum(b * xv for b, xv in zip(beta, row)) for row in X]
    mu = [1.0 / (1.0 + math.exp(-min(35.0, max(-35.0, e)))) for e in eta]
    mu = [min(1.0 - 1e-10, max(1e-10, m)) for m in mu]
    llf = sum(yv * math.log(m) + (1.0 - yv) * math.log(1.0 - m)
              for yv, m in zip(y, mu))
    return beta, cov, llf, converged


class LogitResults:
    def __init__(self, names, beta, cov, y, X, intercept, spec, llf,
                 converged):
        self._names = names
        self._spec = spec
        self._intercept = intercept
        self.nobs = len(y)
        self.converged = converged
        self.llf = llf
        self.params = {nm: b for nm, b in zip(names, beta)}
        self.bse = {}
        self.tvalues = {}
        self.pvalues = {}
        for i, nm in enumerate(names):
            se = math.sqrt(cov[i][i]) if cov[i][i] > 0.0 else float('nan')
            self.bse[nm] = se
            z = self.params[nm] / se if se and se > 0.0 else float('nan')
            self.tvalues[nm] = z
            self.pvalues[nm] = (2.0 * _stats.norm.sf(abs(z))
                                if z == z else float('nan'))
        # null-modell (kun intercept) for McFaddens pseudo-R²
        ybar = sum(y) / len(y)
        ybar = min(1.0 - 1e-10, max(1e-10, ybar))
        self.llnull = sum(yv * math.log(ybar) + (1.0 - yv) * math.log(1.0 - ybar)
                          for yv in y)
        self.prsquared = (1.0 - self.llf / self.llnull
                          if self.llnull != 0.0 else float('nan'))
        self.fittedvalues = [
            1.0 / (1.0 + math.exp(-min(35.0, max(-35.0,
                sum(b * xv for b, xv in zip(beta, row))))))
            for row in X]

    def predict(self, data=None):
        if data is None:
            return list(self.fittedvalues)
        names, X = _design_from_spec(self._spec, self._intercept, data)
        beta = [self.params[nm] for nm in names]
        return [1.0 / (1.0 + math.exp(-min(35.0, max(-35.0,
                    sum(b * xv for b, xv in zip(beta, row))))))
                for row in X]

    def conf_int(self, alpha=0.05):
        q = _stats.norm.ppf(1.0 - alpha / 2.0)
        out = {}
        for nm in self._names:
            b, se = self.params[nm], self.bse[nm]
            out[nm] = ([b - q * se, b + q * se] if se == se
                       else [float('nan'), float('nan')])
        return out

    def summary(self):
        stats_rows = [
            ('Observasjoner', '%d' % self.nobs),
            ('Log-likelihood', '%.4f' % self.llf),
            ('Pseudo-R² (McFadden)', '%.4f' % self.prsquared),
            ('Konvergert', 'ja' if self.converged else 'NEI'),
        ]
        return Summary('Logistisk regresjon', stats_rows, self._names,
                       self.params, self.bse, self.tvalues, self.pvalues,
                       self.conf_int(), stat_label='z')


class LogitModel:
    def __init__(self, formula, data):
        self._formula = formula
        self._data = data

    def fit(self, **kwargs):                       # disp o.l. aksepteres og ignoreres
        y, names, X, spec = _build_design(self._formula, self._data)
        for v in y:
            if v not in (0.0, 1.0):
                raise ValueError('logit: y må være binær (0/1), fant %r' % v)
        beta, cov, llf, converged = _logit_newton(X, y)
        _, _, intercept = _parse_formula(self._formula)
        return LogitResults(names, beta, cov, y, X, intercept, spec, llf,
                            converged)


def logit(formula, data):
    return LogitModel(formula, data)
```

Note: `'y ~ 1'` (intercept-only) must work — check `_build_design`: terms is empty and intercept True, so `_design_from_spec` builds the all-ones column via its spec-empty branch, and `_build_design`'s "ingen forklaringsvariabler" guard must NOT fire when the intercept column exists. Adjust that guard from `if not names:` to remain as-is (names == ['Intercept'] is truthy) — verify with the intercept-only test.

- [ ] **Step 4: Run the full suite**

Run: `python3 -m pytest brython/tests/ -q`
Expected: all PASS (149 from before + all new statsmodels tests).

- [ ] **Step 5: Commit**

```bash
git add brython/statsmodels_brython.py brython/tests/test_statsmodels_brython.py brython/tests/test_statsmodels_brython_diff.py
git commit -m "feat(brython): logit via Newton-Raphson, diff-tested against statsmodels"
```

---

### Task 5: Registry entry, example, index.html button

**Files:**
- Modify: `js/brython-engine.js` (LIB_REGISTRY)
- Create: `examples/bry15_regresjon.txt`
- Modify: `index.html` (after the bry14 button)
- Test: `brython/tests/test_engine_scan.py` (append)

**Interfaces:**
- Produces: registry entry `statsmodels_brython: { aliases: ['statsmodels', 'statsmodels.formula', 'statsmodels.formula.api'], deps: ['scipy_stats_brython'], js: [] }` — alias order binding (each dotted level needs its parent registered first).

- [ ] **Step 1: Write the failing scan test**

Append to `brython/tests/test_engine_scan.py`:

```python
def test_statsmodels_alias_resolves_to_canonical():
    assert scan('import statsmodels.formula.api as smf') == ['statsmodels_brython']
    assert scan('from statsmodels.formula.api import ols') == ['statsmodels_brython']
    assert scan('import statsmodels_brython as smb') == ['statsmodels_brython']
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest brython/tests/test_engine_scan.py -q`
Expected: new test FAILS.

- [ ] **Step 3: Add the registry entry**

In `js/brython-engine.js`, extend `LIB_REGISTRY` after the scipy entry:

```js
    // tre alias-nivåer — rekkefølgen bindende (forelder før barn)
    statsmodels_brython:    { aliases: ['statsmodels', 'statsmodels.formula',
                                        'statsmodels.formula.api'],
                              deps: ['scipy_stats_brython'], js: [] }
```

- [ ] **Step 4: Verify**

Run: `node --check js/brython-engine.js && python3 -m pytest brython/tests/test_engine_scan.py -q`
Expected: OK / all PASS.

- [ ] **Step 5: Create the example**

Create `examples/bry15_regresjon.txt`:

```
# Example: regresjon i Brython-modus — statsmodels-formel-API
# smf.ols / smf.logit i ren Python, diff-testet mot ekte statsmodels.
import statsmodels.formula.api as smf

data = {
    "inntekt": [420.0, 480.0, 510.0, 545.0, 560.0, 590.0, 610.0, 620.0,
                680.0, 710.0, 820.0, 950.0],
    "alder":   [27.0, 31.0, 29.0, 36.0, 34.0, 41.0, 38.0, 44.0,
                45.0, 47.0, 50.0, 52.0],
    "region":  ["N", "S", "N", "O", "S", "N", "O", "S",
                "O", "N", "S", "O"],
}

# Lineær regresjon med kategorisk variabel (region kodes automatisk):
res = smf.ols("inntekt ~ alder + region", data).fit()
show(res.summary())

print("Stigningstall alder:", round(res.params["alder"], 2))
print("R² =", round(res.rsquared, 3))

# Prediksjon for nye observasjoner:
nye = {"alder": [30.0, 48.0], "region": ["N", "S"]}
print("Predikert inntekt:", [round(v, 1) for v in res.predict(nye)])

# Logistisk regresjon (binært utfall):
data["hoy"] = [1.0 if v > 600.0 else 0.0 for v in data["inntekt"]]
logit_res = smf.logit("hoy ~ alder", data).fit()
show(logit_res.summary())
print("P(hoy inntekt | alder=50):", round(logit_res.predict({"alder": [50.0]})[0], 3))
```

- [ ] **Step 6: Add the example button**

In `index.html`, directly after the bry14 button, insert:

```html
              <button type="button" data-example="bry15_regresjon.txt" data-mode="brython" data-i18n>Regresjon &mdash; smf.ols / smf.logit</button>
```

- [ ] **Step 7: Full suite + commit**

Run: `python3 -m pytest brython/tests/ -q && node --check js/brython-engine.js`
Expected: all PASS.

```bash
git add js/brython-engine.js examples/bry15_regresjon.txt index.html brython/tests/test_engine_scan.py
git commit -m "feat(brython): register statsmodels_brython with formula-api aliases + example"
```

---

### Task 6: Browser verification

**Files:** none. CPython-blind risks: the three-level dotted alias chain (`statsmodels.formula.api` — deepest so far), Newton-loop numerics in Brython, `show(res.summary())` rendering via the tablehtml embed path, and the module-level `import scipy_stats_brython` resolving via deps.

- [ ] **Step 1: Serve** — `python3 -m http.server 8765 --directory /Users/hom/Documents/GitHub/microdata` (unregister the service worker in the page before testing — known stale-precache trap).

- [ ] **Step 2: Engine checks via BrythonEngine.run(...)**
1. `import statsmodels.formula.api as smf\nres = smf.ols('y ~ x', {'y': [3.0,5.0,7.0,9.0], 'x': [1.0,2.0,3.0,4.0]}).fit()\nprint(repr(res.params['x']))` → 2.0 (±1e-9), no error.
2. Compare OLS coefficients on the diff-test dataset against locally computed statsmodels values (compute references with python3 first) — agreement to ≥6 significant digits.
3. `show(res.summary())` → output contains the tablehtml embed marker.
4. The bry15 example verbatim → two summary tables + printed lines, no error.
5. Network tab (or re-run check): importing statsmodels_brython must fetch scipy_stats_brython.py FIRST (deps order).

- [ ] **Step 3: Record results; fix + commit anything found.**

---

### Task 7: Port to safestat and openstat

**Files:**
- Copy to `../safestat` then `../openstat`: `js/brython-engine.js`, `brython/statsmodels_brython.py`, `brython/tests/test_statsmodels_brython.py`, `brython/tests/test_statsmodels_brython_diff.py`, `brython/tests/test_engine_scan.py`, `examples/bry15_regresjon.txt`
- Insert the bry15 button after each sibling's bry14 button in index.html

- [ ] **Step 1: Copy files (safestat first) + insert buttons**

```bash
cd /Users/hom/Documents/GitHub
for sib in safestat openstat; do
  cp microdata/js/brython-engine.js             $sib/js/brython-engine.js
  cp microdata/brython/statsmodels_brython.py   $sib/brython/
  cp microdata/brython/tests/test_statsmodels_brython.py      $sib/brython/tests/
  cp microdata/brython/tests/test_statsmodels_brython_diff.py $sib/brython/tests/
  cp microdata/brython/tests/test_engine_scan.py $sib/brython/tests/
  cp microdata/examples/bry15_regresjon.txt     $sib/examples/
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
(cd safestat && git add -A brython/ js/brython-engine.js examples/bry15_regresjon.txt index.html && git commit -m "feat(brython): statsmodels formula API (ported from microdata)")
(cd openstat && git add -A brython/ js/brython-engine.js examples/bry15_regresjon.txt index.html && git commit -m "feat(brython): statsmodels formula API (ported from microdata)")
```

- [ ] **Step 4: Safestat browser smoke** (serve on 8766; run check 1 from Task 6 + one `smf.logit(...).fit().params` call).
