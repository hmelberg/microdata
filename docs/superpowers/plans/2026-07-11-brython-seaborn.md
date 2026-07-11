# Brython seaborn Shim Implementation Plan (Stage 6a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Brython-mode users run standard `import seaborn as sns` teaching code — `sns.histplot(...); plt.title(...); plt.show()` — rendered as interactive Plotly figures.

**Architecture:** One thin module `brython/seaborn_brython.py`. The sns functions build figures via `plotly_express_brython` (reusing all its hue-grouping/color/facet logic, which is already diff-tested against real plotly express) and splice the resulting traces + layout into `matplotlib_brython`'s current-figure state — faithfully mimicking how real seaborn draws onto matplotlib's current axes. `barplot`/`countplot` compute seaborn's aggregation semantics (group means with CI ≈ 1.96·SE; category counts) in the shim since pe plots raw values. Figure-render diffing against real seaborn is impossible (images), so tests assert trace/layout structure plus hand-computed aggregation values.

**Tech Stack:** Brython 3.12 / CPython 3.13 + pytest; existing plotly_express_brython + matplotlib_brython shims; stage-1 lazy engine; AST guard tests apply automatically.

## Global Constraints

- `brython/seaborn_brython.py` runs under BOTH CPython 3.13 and Brython 3.12 — imports ONLY `math`, `plotly_express_brython as _pe`, `matplotlib_brython as _plt` (LIB_REGISTRY entry declares `deps: ['matplotlib_brython', 'plotly_express_brython']`).
- **This module's own trap:** seaborn's API includes `sns.set(...)` — the module defines `set = set_theme` (an alias), which shadows the builtin `set` below that line. NO internal code may use bare `set()`; counting/dedup uses dicts/lists. The alias is defined at the END of the file with a warning comment.
- Brython-feller apply (AST guards): no method/global name collisions (module has no classes — trivially safe, but the guards run anyway); setdefault only with string literals — layout merging therefore uses explicit `if key not in dict` loops, never `setdefault(variable_key, ...)`.
- Semantics fixed by this plan: sns functions draw into matplotlib_brython's CURRENT figure (`plt.show()` renders them; `plt.title()` etc. compose); `hue=` maps to pe's `color=`; axis titles come from pe's layout and are merged only when not already set; `barplot` shows group MEANS with error bars ≈ mean ± 1.96·SE (seaborn's bootstrap-CI approximated — documented divergence); `countplot` shows category frequencies in appearance order; `kdeplot`/`pairplot`/`jointplot` raise Norwegian `NotImplementedError` with a hint; `set_theme`/`set`/`despine` are accepted no-ops.
- Norwegian user-facing error strings. NO sw.js changes. Feature branch in microdata; port safestat-first at the end (safestat has `dash-v2` checked out by another session — build the `master` port from microdata files in a temp worktree, as established in stage 5; cherry-pick conflicts on index.html).

---

### Task 1: Core helpers + scatterplot/lineplot/regplot

**Files:**
- Create: `brython/seaborn_brython.py`
- Test: `brython/tests/test_seaborn_brython.py` (new)

**Interfaces:**
- Consumes: `_pe.scatter/line(data, x=, y=, color=, trendline=)` returning `PlotlyFigure` (`.data` list of trace dicts, `.layout` dict); `_plt._state` (`{'traces': [...], 'layout': {...}}`), `_plt.figure()`.
- Produces (Tasks 2–3 build on): `_col(data, name) -> list` (duck-typed column fetch; if `name` is already a list/tuple/array, returns it as a list — seaborn allows vectors directly); `_merge_into_current(fig)` (splices `fig.data` into `_plt._state['traces']`, copies layout keys not already set, turns on `showlegend` when ≥2 named traces arrive); `scatterplot(data=None, x=None, y=None, hue=None, **kw)`, `lineplot(...)` (same signature), `regplot(data=None, x=None, y=None, **kw)` — all return None and draw into the current figure.

- [ ] **Step 1: Write the failing tests**

Create `brython/tests/test_seaborn_brython.py`:

```python
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import pytest
import matplotlib_brython as plt
import seaborn_brython as sns

DF = {
    'alder':   [25.0, 32.0, 41.0, 28.0, 55.0, 47.0],
    'inntekt': [420.0, 500.0, 610.0, 455.0, 720.0, 650.0],
    'region':  ['N', 'S', 'N', 'S', 'N', 'S'],
}


def setup_function(_fn):
    plt.figure()


def test_scatterplot_draws_into_current_figure():
    sns.scatterplot(data=DF, x='alder', y='inntekt')
    fig = plt.gcf()
    assert len(fig.data) == 1
    assert fig.data[0]['type'] == 'scatter'
    assert fig.data[0]['x'] == DF['alder']

def test_scatterplot_hue_gives_groups_and_legend():
    sns.scatterplot(data=DF, x='alder', y='inntekt', hue='region')
    fig = plt.gcf()
    assert len(fig.data) == 2                      # én trace per region
    names = {t.get('name') for t in fig.data}
    assert names == {'N', 'S'}
    assert fig.layout['showlegend'] is True

def test_axis_titles_from_pe_layout_not_overwriting():
    plt.xlabel('Egen tittel')
    sns.scatterplot(data=DF, x='alder', y='inntekt')
    lay = plt.gcf().layout
    assert lay['xaxis']['title'] == {'text': 'Egen tittel'}   # min vinner

def test_composes_with_plt(capsys):
    sns.lineplot(data=DF, x='alder', y='inntekt')
    plt.title('Kombinert')
    plt.show()
    out = capsys.readouterr().out
    assert 'figure__' in out and 'Kombinert' in out

def test_regplot_adds_trend_trace():
    sns.regplot(data=DF, x='alder', y='inntekt')
    fig = plt.gcf()
    assert len(fig.data) >= 2                      # punkter + OLS-linje
    modes = [t.get('mode', '') for t in fig.data]
    assert any('lines' in m for m in modes)

def test_vectors_directly_without_data():
    sns.scatterplot(x=[1.0, 2.0, 3.0], y=[2.0, 4.0, 6.0])
    assert plt.gcf().data[0]['y'] == [2.0, 4.0, 6.0]
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/hom/Documents/GitHub/microdata && python3 -m pytest brython/tests/test_seaborn_brython.py -q`
Expected: FAIL at import — `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

Create `brython/seaborn_brython.py`:

```python
# seaborn_brython — seaborn-shim over plotly_express_brython.
# Importeres som `import seaborn as sns` (alias i LIB_REGISTRY).
#
# sns-funksjonene tegner inn i matplotlib_brythons GJELDENDE figur (som ekte
# seaborn tegner på matplotlibs akser), så mønsteret
#     sns.histplot(...); plt.title(...); plt.show()
# virker uendret. Figurene bygges via plotly_express_brython (all hue-/
# fargelogikk gjenbrukes derfra) og sporene skjøtes inn i plt-staten.
#
# NB modulens egen felle: seaborn-API-et krever `sns.set(...)` — aliaset
# `set = set_theme` NEDERST i fila skygger innebygde set(). Ingen intern
# kode bruker bare set(); telling/deduplisering gjøres med dict/liste.
import math
import plotly_express_brython as _pe
import matplotlib_brython as _plt


def _col(data, name):
    """Kolonne som liste. `name` kan også være en vektor direkte (som i
    seaborn); data kan være dict-of-lists eller pandas_brython-DataFrame."""
    if isinstance(name, (list, tuple)):
        return list(name)
    if hasattr(name, 'tolist'):
        return list(name.tolist())
    if data is None:
        raise ValueError('oppgi data= eller send vektorer direkte')
    try:
        ser = data[name]
    except Exception:
        raise ValueError('ukjent kolonne: %r' % (name,))
    if hasattr(ser, 'tolist'):
        return list(ser.tolist())
    if hasattr(ser, 'values') and not isinstance(ser, (list, tuple)):
        vals = ser.values
        return list(vals() if callable(vals) else vals)
    return list(ser)


def _merge_into_current(fig):
    """Skjøt en PlotlyFigure fra pe inn i matplotlibs gjeldende figur.
    Layout-nøkler kopieres bare når de ikke alt er satt (brukerens
    plt.xlabel() o.l. vinner). setdefault med variabel nøkkel er forbudt
    (Brython-felle 2) — derfor eksplisitte if-not-in-løkker."""
    lay = _plt._state['layout']
    for key, value in fig.layout.items():
        if key in ('xaxis', 'yaxis') and isinstance(value, dict):
            if key not in lay:
                lay[key] = {}
            sub = lay[key]
            for k2, v2 in value.items():
                if k2 not in sub:
                    sub[k2] = v2
        elif key not in lay:
            lay[key] = value
    for t in fig.data:
        _plt._state['traces'].append(t)
    named = [t for t in _plt._state['traces'] if t.get('name')]
    if len(named) >= 2 and 'showlegend' not in lay:
        lay['showlegend'] = True


def _as_pe_data(data, cols):
    """pe-funksjonene vil ha (data, kolonnenavn). Har brukeren sendt
    vektorer direkte, bygges en midlertidig dict med genererte navn."""
    if data is not None:
        return data, cols
    built = {}
    names = []
    for i, c in enumerate(cols):
        if c is None:
            names.append(None)
            continue
        nm = 'x' if i == 0 else ('y' if i == 1 else 'serie%d' % i)
        built[nm] = _col(None if isinstance(c, (list, tuple)) or
                         hasattr(c, 'tolist') else data, c)
        names.append(nm)
    return built, names


def scatterplot(data=None, x=None, y=None, hue=None, **kwargs):
    if data is None:
        d, (xn, yn) = _as_pe_data(None, [x, y])
        _merge_into_current(_pe.scatter(d, x=xn, y=yn))
        return
    _merge_into_current(_pe.scatter(data, x=x, y=y, color=hue))


def lineplot(data=None, x=None, y=None, hue=None, **kwargs):
    if data is None:
        d, (xn, yn) = _as_pe_data(None, [x, y])
        _merge_into_current(_pe.line(d, x=xn, y=yn))
        return
    _merge_into_current(_pe.line(data, x=x, y=y, color=hue))


def regplot(data=None, x=None, y=None, **kwargs):
    """Spredningsplott med OLS-linje (pe sin trendline='ols')."""
    if data is None:
        d, (xn, yn) = _as_pe_data(None, [x, y])
        _merge_into_current(_pe.scatter(d, x=xn, y=yn, trendline='ols'))
        return
    _merge_into_current(_pe.scatter(data, x=x, y=y, trendline='ols'))
```

Note: if `_pe.scatter`'s layout does NOT carry axis titles for the plain
(no-hue) case, `test_axis_titles_from_pe_layout_not_overwriting` still
passes (it only asserts the user's title survives). Do not add manual
axis-title logic unless a test forces it.

- [ ] **Step 4: Run tests + guards**

Run: `python3 -m pytest brython/tests/test_seaborn_brython.py brython/tests/test_brython_scoping_trap.py -q`
Expected: 6 + 2 PASS.

- [ ] **Step 5: Commit**

```bash
git add brython/seaborn_brython.py brython/tests/test_seaborn_brython.py
git commit -m "feat(brython): seaborn_brython core — scatter/line/regplot into current figure"
```

---

### Task 2: histplot, boxplot, violinplot, heatmap + stubs/no-ops

**Files:**
- Modify: `brython/seaborn_brython.py` (append)
- Test: `brython/tests/test_seaborn_brython.py` (append)

**Interfaces:**
- Consumes: `_merge_into_current`, `_pe.histogram(data, x=, color=, nbins=)`, `_pe.box/violin(data, x=, y=, color=)`, `_pe.imshow(data)`.
- Produces: `histplot(data=None, x=None, hue=None, bins=None, **kw)`, `boxplot(data=None, x=None, y=None, hue=None, **kw)`, `violinplot(...)` (same), `heatmap(data, **kw)`, no-ops `set_theme(*a, **kw)`/`despine(*a, **kw)`, stubs `kdeplot/pairplot/jointplot` raising Norwegian NotImplementedError, and at the VERY END of the file `set = set_theme` with the shadow-warning comment.

- [ ] **Step 1: Write the failing tests**

Append to `brython/tests/test_seaborn_brython.py`:

```python
def test_histplot_bins_and_hue():
    sns.histplot(data=DF, x='inntekt', bins=5)
    t = plt.gcf().data[0]
    assert t['type'] == 'histogram'
    assert t.get('nbinsx') == 5
    plt.figure()
    sns.histplot(data=DF, x='inntekt', hue='region')
    assert len(plt.gcf().data) == 2

def test_boxplot_and_violinplot():
    sns.boxplot(data=DF, x='region', y='inntekt')
    assert plt.gcf().data[0]['type'] == 'box'
    plt.figure()
    sns.violinplot(data=DF, x='region', y='inntekt')
    assert plt.gcf().data[0]['type'] == 'violin'

def test_heatmap():
    sns.heatmap([[1.0, 0.5], [0.5, 1.0]])
    types = [t.get('type') for t in plt.gcf().data]
    assert 'heatmap' in types

def test_noops_and_stubs():
    sns.set_theme(style='whitegrid')
    sns.set(style='darkgrid')                     # aliaset
    sns.despine()
    with pytest.raises(NotImplementedError, match='støttes ikke'):
        sns.kdeplot(data=DF, x='inntekt')
    with pytest.raises(NotImplementedError):
        sns.pairplot(DF)
    with pytest.raises(NotImplementedError):
        sns.jointplot(data=DF, x='alder', y='inntekt')
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest brython/tests/test_seaborn_brython.py -q`
Expected: new tests FAIL with AttributeError.

- [ ] **Step 3: Implement**

Append to `brython/seaborn_brython.py`:

```python
def histplot(data=None, x=None, hue=None, bins=None, **kwargs):
    if data is None:
        d, (xn,) = _as_pe_data(None, [x])
        _merge_into_current(_pe.histogram(d, x=xn, nbins=bins))
        return
    _merge_into_current(_pe.histogram(data, x=x, color=hue, nbins=bins))


def boxplot(data=None, x=None, y=None, hue=None, **kwargs):
    _merge_into_current(_pe.box(data, x=x, y=y, color=hue))


def violinplot(data=None, x=None, y=None, hue=None, **kwargs):
    _merge_into_current(_pe.violin(data, x=x, y=y, color=hue))


def heatmap(data, **kwargs):
    """Varmekart av en matrise (liste av rader, ndarray eller DataFrame)."""
    _merge_into_current(_pe.imshow(data))


def set_theme(*args, **kwargs):
    """Akseptert no-op — Plotly-temaet styres av appen."""
    pass


def despine(*args, **kwargs):
    pass


def kdeplot(*args, **kwargs):
    raise NotImplementedError('kdeplot støttes ikke i Brython-utgaven — '
                              'bruk sns.histplot i stedet')


def pairplot(*args, **kwargs):
    raise NotImplementedError('pairplot støttes ikke i Brython-utgaven — '
                              'lag enkeltplott med sns.scatterplot')


def jointplot(*args, **kwargs):
    raise NotImplementedError('jointplot støttes ikke i Brython-utgaven — '
                              'bruk sns.regplot i stedet')
```

And at the VERY END of the file (after everything, including Task 3's
functions when they exist — keep this block last):

```python
# NB: seaborn-API-et krever sns.set(...) — dette aliaset SKYGGER innebygde
# set() for all kode under denne linja. Derfor ligger det sist i fila, og
# ingen intern kode bruker bare set().
set = set_theme
```

- [ ] **Step 4: Run tests + guards**

Run: `python3 -m pytest brython/tests/test_seaborn_brython.py brython/tests/test_brython_scoping_trap.py -q`
Expected: all PASS. Manual check: `grep -n 'set(' brython/seaborn_brython.py` — only the alias definition and `set_theme` calls, no bare builtin-set usage.

- [ ] **Step 5: Commit**

```bash
git add brython/seaborn_brython.py brython/tests/test_seaborn_brython.py
git commit -m "feat(brython): seaborn hist/box/violin/heatmap + no-ops and stubs"
```

---

### Task 3: countplot + barplot (seaborn aggregation semantics)

**Files:**
- Modify: `brython/seaborn_brython.py` (insert BEFORE the `set = set_theme` block)
- Test: `brython/tests/test_seaborn_brython.py` (append)

**Interfaces:**
- Consumes: `_col`, `_merge_into_current`, `_plt._state`, `_plt._clean` (matplotlib's remove_none wrapper), `math.sqrt`.
- Produces: `countplot(data=None, x=None, hue=None, **kw)` (category frequencies, appearance order); `barplot(data=None, x=None, y=None, hue=None, errorbar='ci', **kw)` (group MEANS, error bars 1.96·SE when errorbar is not None; groups in appearance order; hue → one bar trace per hue level with legend).

- [ ] **Step 1: Write the failing tests**

Append to `brython/tests/test_seaborn_brython.py`:

```python
def test_countplot_frequencies_in_appearance_order():
    sns.countplot(data=DF, x='region')
    t = plt.gcf().data[0]
    assert t['type'] == 'bar'
    assert t['x'] == ['N', 'S']                    # opptredensrekkefølge
    assert t['y'] == [3, 3]

def test_barplot_group_means_and_ci():
    d = {'g': ['a', 'a', 'b', 'b', 'b'], 'v': [1.0, 3.0, 10.0, 20.0, 30.0]}
    sns.barplot(data=d, x='g', y='v')
    t = plt.gcf().data[0]
    assert t['type'] == 'bar'
    assert t['x'] == ['a', 'b']
    assert t['y'] == pytest.approx([2.0, 20.0])    # GJENNOMSNITT, ikke sum
    # 1.96*SE: a: sd=sqrt(2), se=1 -> 1.96 ; b: sd=10, se=10/sqrt(3)
    err = t['error_y']['array']
    assert err[0] == pytest.approx(1.96, rel=1e-9)
    assert err[1] == pytest.approx(1.96 * 10.0 / (3 ** 0.5), rel=1e-9)

def test_barplot_no_errorbar_and_hue():
    d = {'g': ['a', 'b', 'a', 'b'], 'h': ['x', 'x', 'y', 'y'],
         'v': [1.0, 2.0, 3.0, 4.0]}
    sns.barplot(data=d, x='g', y='v', errorbar=None)
    assert 'error_y' not in plt.gcf().data[0]
    plt.figure()
    sns.barplot(data=d, x='g', y='v', hue='h')
    fig = plt.gcf()
    assert len(fig.data) == 2
    assert {t['name'] for t in fig.data} == {'x', 'y'}
    assert fig.layout['showlegend'] is True
    byname = {t['name']: t for t in fig.data}
    assert byname['x']['y'] == pytest.approx([1.0, 2.0])
    assert byname['y']['y'] == pytest.approx([3.0, 4.0])
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest brython/tests/test_seaborn_brython.py -q`
Expected: new tests FAIL with AttributeError.

- [ ] **Step 3: Implement**

Insert into `brython/seaborn_brython.py` (before the `set = set_theme` block):

```python
def _appearance_groups(keys, values=None):
    """Grupper verdiene per nøkkel i OPPTREDENSREKKEFØLGE (som seaborn for
    objekt-kolonner). Uten values telles forekomster. Ingen set()-bruk —
    aliaset sns.set skygger innebygde set()."""
    order = []
    groups = {}
    for i, k in enumerate(keys):
        if k not in groups:
            groups[k] = []
            order.append(k)
        groups[k].append(values[i] if values is not None else 1)
    return order, groups


def countplot(data=None, x=None, hue=None, **kwargs):
    xs = _col(data, x)
    if hue is None:
        order, groups = _appearance_groups(xs)
        trace = {'type': 'bar', 'x': order,
                 'y': [len(groups[k]) for k in order]}
        _plt._state['traces'].append(_plt._clean(trace))
    else:
        hs = _col(data, hue)
        horder, _ = _appearance_groups(hs)
        xorder, _ = _appearance_groups(xs)
        for hv in horder:
            counts = {}
            for xv, h in zip(xs, hs):
                if h == hv:
                    counts[xv] = counts.get(xv, 0) + 1
            trace = {'type': 'bar', 'x': xorder,
                     'y': [counts.get(k, 0) for k in xorder], 'name': hv}
            _plt._state['traces'].append(_plt._clean(trace))
        if 'showlegend' not in _plt._state['layout']:
            _plt._state['layout']['showlegend'] = True
    _sns_axis_titles(x if isinstance(x, str) else None, 'count')


def barplot(data=None, x=None, y=None, hue=None, errorbar='ci', **kwargs):
    """Som seaborn: GJENNOMSNITT per kategori, feilstrek ~= 1.96*SE
    (seaborn bruker bootstrap-CI — dette er en dokumentert tilnærming)."""
    xs = _col(data, x)
    ys = [float(v) for v in _col(data, y)]
    if hue is None:
        subsets = [(None, xs, ys)]
    else:
        hs = _col(data, hue)
        horder, _ = _appearance_groups(hs)
        subsets = []
        for hv in horder:
            fx = [a for a, h in zip(xs, hs) if h == hv]
            fy = [b for b, h in zip(ys, hs) if h == hv]
            subsets.append((hv, fx, fy))
    xorder, _ = _appearance_groups(xs)
    for name, fx, fy in subsets:
        order, groups = _appearance_groups(fx, fy)
        means = []
        errs = []
        for k in xorder:
            vals = groups.get(k, [])
            if not vals:
                means.append(None)
                errs.append(0.0)
                continue
            m = sum(vals) / len(vals)
            means.append(m)
            if len(vals) > 1:
                sd = math.sqrt(sum((v - m) ** 2 for v in vals)
                               / (len(vals) - 1))
                errs.append(1.96 * sd / math.sqrt(len(vals)))
            else:
                errs.append(0.0)
        trace = {'type': 'bar', 'x': xorder, 'y': means, 'name': name}
        if errorbar is not None:
            trace['error_y'] = {'type': 'data', 'array': errs}
        _plt._state['traces'].append(_plt._clean(trace))
    if hue is not None and 'showlegend' not in _plt._state['layout']:
        _plt._state['layout']['showlegend'] = True
    _sns_axis_titles(x if isinstance(x, str) else None,
                     y if isinstance(y, str) else None)


def _sns_axis_titles(xname, yname):
    """Sett aksetitler fra kolonnenavn — bare når de ikke alt er satt."""
    lay = _plt._state['layout']
    if xname is not None:
        if 'xaxis' not in lay:
            lay['xaxis'] = {}
        if 'title' not in lay['xaxis']:
            lay['xaxis']['title'] = {'text': xname}
    if yname is not None:
        if 'yaxis' not in lay:
            lay['yaxis'] = {}
        if 'title' not in lay['yaxis']:
            lay['yaxis']['title'] = {'text': yname}
```

- [ ] **Step 4: Run the full brython suite**

Run: `python3 -m pytest brython/tests/ -q`
Expected: all PASS (existing 226 + all new seaborn tests).

- [ ] **Step 5: Commit**

```bash
git add brython/seaborn_brython.py brython/tests/test_seaborn_brython.py
git commit -m "feat(brython): seaborn countplot/barplot with mean+CI semantics"
```

---

### Task 4: Registry, example, index.html button

**Files:**
- Modify: `js/brython-engine.js` (LIB_REGISTRY)
- Create: `examples/bry17_seaborn.txt`
- Modify: `index.html` (after the bry16 button)
- Test: `brython/tests/test_engine_scan.py` (append)

**Interfaces:**
- Produces: registry entry `seaborn_brython: { aliases: ['seaborn'], deps: ['matplotlib_brython', 'plotly_express_brython'], js: [] }`.

- [ ] **Step 1: Write the failing scan test**

Append to `brython/tests/test_engine_scan.py`:

```python
def test_seaborn_alias_resolves_to_canonical():
    assert scan('import seaborn as sns') == ['seaborn_brython']
    assert scan('from seaborn import histplot') == ['seaborn_brython']
```

- [ ] **Step 2: Run to verify failure** — `python3 -m pytest brython/tests/test_engine_scan.py -q`: FAILS.

- [ ] **Step 3: Add the registry entry**

In `js/brython-engine.js`, extend `LIB_REGISTRY` after the numpy entry:

```js
    seaborn_brython:        { aliases: ['seaborn'],
                              deps: ['matplotlib_brython', 'plotly_express_brython'], js: [] }
```

- [ ] **Step 4: Verify** — `node --check js/brython-engine.js && python3 -m pytest brython/tests/test_engine_scan.py -q`: OK / PASS.

- [ ] **Step 5: Create the example**

Create `examples/bry17_seaborn.txt`:

```
# Example: seaborn i Brython-modus — statistisk grafikk på én linje
# sns-funksjonene tegner i samme figur som plt, akkurat som ekte seaborn.
import seaborn as sns
import matplotlib.pyplot as plt
import numpy as np

np.random.seed(7)
data = {
    "inntekt": np.random.normal(550.0, 80.0, 120).tolist(),
    "alder":   np.random.uniform(25.0, 60.0, 120).tolist(),
    "region":  (["Nord", "Sor", "Ost"] * 40),
}

# Histogram med fargegrupper:
sns.histplot(data=data, x="inntekt", hue="region", bins=15)
plt.title("Inntektsfordeling per region")
plt.show()

# Gjennomsnitt med usikkerhet (som seaborn: mean + CI):
sns.barplot(data=data, x="region", y="inntekt")
plt.title("Gjennomsnittsinntekt per region")
plt.show()

# Spredning med regresjonslinje:
sns.regplot(data=data, x="alder", y="inntekt")
plt.title("Inntekt mot alder (OLS-linje)")
plt.show()

# Fordeling per gruppe:
sns.boxplot(data=data, x="region", y="inntekt")
plt.show()
```

- [ ] **Step 6: Add the example button**

In `index.html`, directly after the bry16 button, insert:

```html
              <button type="button" data-example="bry17_seaborn.txt" data-mode="brython" data-i18n>seaborn &mdash; statistisk grafikk</button>
```

- [ ] **Step 7: Full suite + commit**

Run: `python3 -m pytest brython/tests/ -q && node --check js/brython-engine.js`
Expected: all PASS.

```bash
git add js/brython-engine.js examples/bry17_seaborn.txt index.html brython/tests/test_engine_scan.py
git commit -m "feat(brython): register seaborn_brython with seaborn alias + example"
```

---

### Task 5: Browser verification

**Files:** none. CPython-blind risks: the deps chain (seaborn → matplotlib + plotly, fetch order), trace-splicing rendering combined figures, and the example end-to-end.

- [ ] **Step 1: Serve** — `python3 -m http.server 8765 --directory /Users/hom/Documents/GitHub/microdata` (unregister the service worker first — known trap).

- [ ] **Step 2: Engine checks via BrythonEngine.run(...)**
1. `import seaborn as sns\nimport matplotlib.pyplot as plt\nsns.histplot(data={'v': [1.0,2.0,2.0,3.0]}, x='v', bins=3)\nplt.title('t')\nplt.show()` → one `figure__` embed containing `histogram` and the title, no error.
2. The bry17 example verbatim → 4 figures, no error; the barplot figure contains `error_y`.
3. Network order on cold run: `matplotlib_brython.py` and `plotly_express_brython.py` fetched BEFORE `seaborn_brython.py` (deps).

- [ ] **Step 3: Record results; fix + commit anything found.**

---

### Task 6: Port to safestat and openstat + merge + push

**Files:**
- Copy to siblings: `js/brython-engine.js`, `brython/seaborn_brython.py`, `brython/tests/test_seaborn_brython.py`, `brython/tests/test_engine_scan.py`, `examples/bry17_seaborn.txt`; insert the bry17 button after each sibling's bry16 button.

- [ ] **Step 1: openstat: copy + button + suite + commit + push (main).**
- [ ] **Step 2: safestat: check checked-out branch. If `dash-v2`: copy into the working tree + commit + push dash-v2, AND build the `master` port from microdata files in a temp worktree (`git worktree add /tmp/... master`, copy the same files, insert button, run suite, commit, push, remove worktree) — cherry-pick is known to conflict on index.html.**
- [ ] **Step 3: `sh safestat/scripts/sync_check.sh` → OK.**
- [ ] **Step 4: Safestat browser smoke (serve 8766; check 1 from Task 5).**
- [ ] **Step 5: Merge microdata branch to main (suite green on result), delete branch, push microdata main.**
