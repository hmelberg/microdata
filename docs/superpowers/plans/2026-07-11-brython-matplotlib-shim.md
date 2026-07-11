# Brython matplotlib.pyplot Shim Implementation Plan (Stage 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Brython-mode users run standard `import matplotlib.pyplot as plt` teaching code, rendered as interactive Plotly figures.

**Architecture:** A single pure-Python module `brython/matplotlib_brython.py` implements the `plt` function API as a stateful trace builder on top of `PlotlyFigure` (imported from plotly_express_brython). It registers lazily via the Stage-1 `LIB_REGISTRY` with aliases `matplotlib` and `matplotlib.pyplot`; the runner's `_alias_module` gains dotted-alias support (parent-module attribute + `sys.modules` entry) so `import matplotlib.pyplot as plt` binds correctly.

**Tech Stack:** Brython 3.12 (browser) / CPython 3.13 + pytest (tests), Stage-1 lazy-registration engine (`js/brython-engine.js`), Plotly.js rendering via the existing embed-marker protocol.

## Global Constraints

- `brython/matplotlib_brython.py` must run under BOTH CPython 3.13 (pytest) and Brython 3.12 — no `ast`, no CPython-only stdlib, no browser-only imports.
- Rendering happens ONLY through the existing embed-marker protocol: `__micro_transform_start_` + `figure__` + JSON + `__micro_transform_end__` (same constants as brython_runner.py and index.html's buildOutputNodes — they are a stable app-wide protocol).
- The module's only intra-repo dependency is `from plotly_express_brython import PlotlyFigure, remove_none` — its LIB_REGISTRY entry MUST therefore declare `deps: ['plotly_express_brython']`.
- Registry aliases must be ordered `['matplotlib', 'matplotlib.pyplot']` — ensureLibs registers aliases in array order, and the dotted alias requires the plain parent alias to exist in sys.modules first.
- User-facing error strings in Norwegian (`'Ukjent modul: '` style); code comments follow the file's mixed Norwegian/English convention.
- NO sw.js CACHE bump in this stage: the Stage-1 bumps (m2py-v11/v10/v11) are still unpublished, and the new module file is deliberately NOT in the precache list (lazy modules are fetched on demand).
- matplotlib fidelity choices (fixed by this plan): legend hidden unless `legend()` is called (except pie charts); `savefig()` renders like `show()`; `subplots()` supports only 1x1 and raises NotImplementedError otherwise; matplotlib's default color cycle (tab10 hexes C0–C9).
- Development in microdata; port to safestat (first) then openstat at the end.

---

### Task 1: Dotted-alias support in `_alias_module`

**Files:**
- Modify: `brython/brython_runner.py` (the `_alias_module` function)
- Test: `brython/tests/test_brython_runner.py` (append)

**Interfaces:**
- Consumes: existing `_register_module(name, source)` / `_alias_module(alias, canonical)` and `sys.modules`.
- Produces: `_alias_module(alias, canonical) -> str` now also accepts dotted aliases (`'matplotlib.pyplot'`): requires the parent (`'matplotlib'`) to already be in `sys.modules`, sets the child attribute on the parent module, and inserts `sys.modules[alias]`. Returns `''` on success, `'Ukjent foreldremodul: <parent>'` if the parent is missing. Plain aliases behave exactly as before.

- [ ] **Step 1: Write the failing tests**

Append to `brython/tests/test_brython_runner.py`:

```python
def test_dotted_alias_binds_parent_attribute_and_sys_modules():
    br._register_module('lazydemo_mpl', 'def plot(x):\n    return x * 2\n')
    assert br._alias_module('lazydemo_pkg', 'lazydemo_mpl') == ''
    assert br._alias_module('lazydemo_pkg.pyplot', 'lazydemo_mpl') == ''
    out = br._execute_code('import lazydemo_pkg.pyplot as plt\nplt.plot(21)')
    assert br._get_last_error() == ''
    assert '42' in out

def test_dotted_alias_requires_parent_in_sys_modules():
    br._register_module('lazydemo_orphan', 'x = 1\n')
    err = br._alias_module('no_such_parent.child', 'lazydemo_orphan')
    assert 'Ukjent foreldremodul' in err
    assert 'no_such_parent.child' not in sys.modules
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/hom/Documents/GitHub/microdata && python3 -m pytest brython/tests/test_brython_runner.py -q`
Expected: 2 new tests FAIL. (`test_dotted_alias_binds...` fails because the current `_alias_module` inserts `sys.modules['lazydemo_pkg.pyplot']` without setting the parent attribute — `import lazydemo_pkg.pyplot as plt` may still pass in CPython via the sys.modules fallback, so if it unexpectedly PASSES, the second test still fails and the implementation below is still required for Brython, whose import machinery is less forgiving. `test_dotted_alias_requires_parent...` fails because no parent check exists yet.)

- [ ] **Step 3: Implement**

Replace `_alias_module` in `brython/brython_runner.py` with:

```python
def _alias_module(alias, canonical):
    """Make `import alias` resolve to already-registered module `canonical`.
    Dotted alias ('matplotlib.pyplot'): foreldermodulen må allerede ligge i
    sys.modules (registrer den plain aliasen først); barnet settes som
    attributt på forelderen så `import a.b as x` binder riktig."""
    if canonical not in sys.modules:
        return 'Ukjent modul: ' + canonical
    if '.' in alias:
        parent_name, _, child = alias.rpartition('.')
        if parent_name not in sys.modules:
            return 'Ukjent foreldremodul: ' + parent_name
        setattr(sys.modules[parent_name], child, sys.modules[canonical])
    sys.modules[alias] = sys.modules[canonical]
    return ''
```

- [ ] **Step 4: Run the full runner test file**

Run: `python3 -m pytest brython/tests/test_brython_runner.py -q`
Expected: all PASS (24 existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add brython/brython_runner.py brython/tests/test_brython_runner.py
git commit -m "feat(brython): dotted aliases in _alias_module for package-style imports"
```

---

### Task 2: matplotlib_brython core — state, plot(), show(), titles

**Files:**
- Create: `brython/matplotlib_brython.py`
- Test: `brython/tests/test_matplotlib_brython.py` (new)

**Interfaces:**
- Consumes: `PlotlyFigure(plot_data_dict)` and `remove_none(dict)` from plotly_express_brython (PlotlyFigure exposes `.data` list, `.layout` dict, `.to_plotly_json_str()`).
- Produces (used by Tasks 3–4): module-level `_state = {'traces': [], 'layout': {}, 'color_i': 0}`, helpers `_values(v) -> list|None`, `_next_color() -> str`, `_clean(d) -> dict` (= remove_none), `_parse_fmt(fmt) -> (color, marker, dash)`; public `figure(figsize=None, **kw)`, `plot(*args, **kwargs)`, `title(s)`, `xlabel(s)`, `ylabel(s)`, `gcf() -> PlotlyFigure`, `show()`.

- [ ] **Step 1: Write the failing tests**

Create `brython/tests/test_matplotlib_brython.py`:

```python
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import matplotlib_brython as plt

ES = '__micro_transform_start_'
EE = '__micro_transform_end__'


def setup_function(_fn):
    plt.figure()   # nullstiller modulstaten mellom tester


def test_plot_x_y_builds_line_trace():
    plt.plot([1, 2, 3], [4, 5, 6])
    fig = plt.gcf()
    assert len(fig.data) == 1
    t = fig.data[0]
    assert t['type'] == 'scatter' and t['mode'] == 'lines'
    assert t['x'] == [1, 2, 3] and t['y'] == [4, 5, 6]
    assert t['line']['color'] == '#1f77b4'          # C0 i tab10-syklusen

def test_plot_y_only_gets_index_x():
    plt.plot([10, 20, 30])
    t = plt.gcf().data[0]
    assert t['x'] == [0, 1, 2] and t['y'] == [10, 20, 30]

def test_plot_fmt_string_color_marker_dash():
    plt.plot([1, 2], [3, 4], 'ro--')
    t = plt.gcf().data[0]
    assert t['line']['color'] == 'red'
    assert t['line']['dash'] == 'dash'
    assert t['mode'] == 'lines+markers'
    assert t['marker']['symbol'] == 'circle'

def test_plot_repeated_triples_and_color_cycle():
    plt.plot([1, 2], [3, 4], [1, 2], [5, 6])
    fig = plt.gcf()
    assert len(fig.data) == 2
    assert fig.data[0]['line']['color'] == '#1f77b4'
    assert fig.data[1]['line']['color'] == '#ff7f0e'  # C1

def test_labels_and_title():
    plt.plot([1], [1])
    plt.title('Tittel')
    plt.xlabel('X-akse')
    plt.ylabel('Y-akse')
    lay = plt.gcf().layout
    assert lay['title'] == {'text': 'Tittel'}
    assert lay['xaxis']['title'] == {'text': 'X-akse'}
    assert lay['yaxis']['title'] == {'text': 'Y-akse'}

def test_figure_figsize_inches_to_px():
    plt.figure(figsize=(7, 4))
    lay = plt.gcf().layout
    assert lay['width'] == 700 and lay['height'] == 400

def test_show_prints_embed_marker_and_resets(capsys):
    plt.plot([1, 2], [3, 4])
    plt.show()
    out = capsys.readouterr().out
    assert (ES + 'figure__') in out and EE in out
    payload = out.split(ES + 'figure__')[1].split(EE)[0].strip()
    spec = json.loads(payload)
    assert spec['data'][0]['y'] == [3, 4]
    assert spec['layout']['showlegend'] is False      # ingen legend() kalt
    plt.show()                                        # tom stat → ingenting
    assert capsys.readouterr().out == ''

def test_values_accepts_range_and_duck_typed_series():
    class FakeSeries:                                  # pandas_brython-duck
        def tolist(self):
            return [7, 8]
    plt.plot(range(2), FakeSeries())
    t = plt.gcf().data[0]
    assert t['x'] == [0, 1] and t['y'] == [7, 8]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest brython/tests/test_matplotlib_brython.py -q`
Expected: FAIL at import — `ModuleNotFoundError: No module named 'matplotlib_brython'`.

- [ ] **Step 3: Implement the module core**

Create `brython/matplotlib_brython.py`:

```python
# matplotlib_brython — matplotlib.pyplot-shim på toppen av PlotlyFigure.
# Brukes som `import matplotlib.pyplot as plt` (aliaser i LIB_REGISTRY) eller
# direkte som matplotlib_brython. Bygger plotly-traces i en modulglobal
# "gjeldende figur"; show() skriver samme embed-markør-protokoll som
# brython_runner._fmt, så index.html rendrer uendret.
from plotly_express_brython import PlotlyFigure, remove_none

# Embed-markører — stabil app-protokoll (samme konstanter i brython_runner.py
# og index.html buildOutputNodes)
_EMBED_S = '__micro_transform_start_'
_EMBED_E = '__micro_transform_end__'

# matplotlibs standard fargesyklus (tab10, C0..C9)
_COLOR_CYCLE = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
                '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf']

_FMT_COLORS = {'b': 'blue', 'g': 'green', 'r': 'red', 'c': 'cyan',
               'm': 'magenta', 'y': 'yellow', 'k': 'black', 'w': 'white'}
_FMT_MARKERS = {'o': 'circle', 's': 'square', '^': 'triangle-up',
                'v': 'triangle-down', 'd': 'diamond', '*': 'star',
                'x': 'x', '+': 'cross', '.': 'circle'}
_FMT_DASH = {'-': 'solid', '--': 'dash', ':': 'dot', '-.': 'dashdot'}

_state = {'traces': [], 'layout': {}, 'color_i': 0}


def _reset():
    _state['traces'] = []
    _state['layout'] = {}
    _state['color_i'] = 0


def _next_color():
    c = _COLOR_CYCLE[_state['color_i'] % len(_COLOR_CYCLE)]
    _state['color_i'] += 1
    return c


def _values(v):
    """list-ifiser: lister, tupler, range og pandas_brython-Series (duck-typet
    på tolist/values, så ingen import av pandas_brython trengs)."""
    if v is None:
        return None
    if hasattr(v, 'tolist'):
        return list(v.tolist())
    if hasattr(v, 'values') and not isinstance(v, dict):
        vals = v.values
        return list(vals() if callable(vals) else vals)
    return list(v)


def _clean(d):
    return remove_none(d)


def _parse_fmt(fmt):
    """'ro--' -> (farge, markør, dash). Alle deler valgfrie; tokolonne-dasher
    ('--', '-.') må plukkes før enkelttegn."""
    color = marker = dash = None
    rest = fmt or ''
    for two in ('--', '-.'):
        if two in rest:
            dash = _FMT_DASH[two]
            rest = rest.replace(two, '', 1)
            break
    for ch in rest:
        if ch in _FMT_COLORS and color is None:
            color = _FMT_COLORS[ch]
        elif ch in _FMT_MARKERS and marker is None:
            marker = _FMT_MARKERS[ch]
        elif ch in ('-', ':') and dash is None:
            dash = _FMT_DASH[ch]
    return color, marker, dash


def figure(figsize=None, **kwargs):
    """Start en ny (tom) gjeldende figur. figsize i tommer -> px (dpi=100)."""
    _reset()
    if figsize:
        _state['layout']['width'] = int(figsize[0] * 100)
        _state['layout']['height'] = int(figsize[1] * 100)


def plot(*args, **kwargs):
    """plt.plot(y) | plot(x, y) | plot(x, y, 'r--') | gjentatte (x, y, fmt)."""
    args = list(args)
    while args:
        x = _values(args.pop(0))
        y = None
        fmt = ''
        if args and not isinstance(args[0], str):
            y = _values(args.pop(0))
        if args and isinstance(args[0], str):
            fmt = args.pop(0)
        if y is None:
            x, y = list(range(len(x))), x
        color, marker, dash = _parse_fmt(fmt)
        color = kwargs.get('color', color) or _next_color()
        trace = {'type': 'scatter', 'x': x, 'y': y,
                 'mode': 'lines+markers' if marker else 'lines',
                 'line': {'color': color, 'dash': dash or 'solid',
                          'width': kwargs.get('linewidth', 2)},
                 'name': kwargs.get('label')}
        if marker:
            trace['marker'] = {'symbol': marker, 'color': color}
        _state['traces'].append(_clean(trace))


def title(s, **kwargs):
    _state['layout']['title'] = {'text': s}


def xlabel(s, **kwargs):
    _state['layout'].setdefault('xaxis', {})['title'] = {'text': s}


def ylabel(s, **kwargs):
    _state['layout'].setdefault('yaxis', {})['title'] = {'text': s}


def gcf():
    """Gjeldende figur som PlotlyFigure (uten å nullstille staten)."""
    layout = dict(_state['layout'])
    if 'showlegend' not in layout:
        # matplotlib viser ikke legend uten legend() — unntak: pie har
        # etiketter i legenden i plotly, så den beholdes synlig.
        layout['showlegend'] = any(
            t.get('type') == 'pie' for t in _state['traces'])
    return PlotlyFigure({'data': list(_state['traces']),
                         'layout': layout, 'config': {}})


def show():
    """Render gjeldende figur (embed-markør på stdout) og nullstill."""
    if not _state['traces'] and not _state['layout']:
        return
    fig = gcf()
    print(_EMBED_S + 'figure__' + '\n' + fig.to_plotly_json_str() + '\n' + _EMBED_E)
    _reset()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest brython/tests/test_matplotlib_brython.py -q`
Expected: 8 PASS.

- [ ] **Step 5: Commit**

```bash
git add brython/matplotlib_brython.py brython/tests/test_matplotlib_brython.py
git commit -m "feat(brython): matplotlib_brython core — plot/show/titles over PlotlyFigure"
```

---

### Task 3: Chart functions — scatter, bar, barh, hist, boxplot, pie

**Files:**
- Modify: `brython/matplotlib_brython.py` (append after `plot`, before `title`)
- Test: `brython/tests/test_matplotlib_brython.py` (append)

**Interfaces:**
- Consumes: `_state`, `_values`, `_next_color`, `_clean` from Task 2.
- Produces: `scatter(x, y, s=None, c=None, alpha=None, label=None, **kw)`, `bar(x, height, color=None, label=None, **kw)`, `barh(y, width, color=None, label=None, **kw)`, `hist(x, bins=None, color=None, label=None, density=False, **kw)`, `boxplot(x, labels=None, **kw)`, `pie(x, labels=None, colors=None, autopct=None, **kw)` — each appends one/multiple trace dicts to `_state['traces']`.

- [ ] **Step 1: Write the failing tests**

Append to `brython/tests/test_matplotlib_brython.py`:

```python
def test_scatter_markers_color_size_alpha():
    plt.scatter([1, 2], [3, 4], s=12, c='green', alpha=0.5, label='pts')
    t = plt.gcf().data[0]
    assert t['type'] == 'scatter' and t['mode'] == 'markers'
    assert t['marker']['color'] == 'green'
    assert t['marker']['size'] == 12
    assert t['marker']['opacity'] == 0.5
    assert t['name'] == 'pts'

def test_scatter_numeric_c_becomes_colorscale():
    plt.scatter([1, 2], [3, 4], c=[0.1, 0.9])
    m = plt.gcf().data[0]['marker']
    assert m['color'] == [0.1, 0.9]
    assert m['colorscale'] == 'Viridis' and m['showscale'] is True

def test_bar_and_barh():
    plt.bar(['a', 'b'], [3, 4])
    plt.barh(['c', 'd'], [5, 6])
    f = plt.gcf()
    assert f.data[0]['type'] == 'bar' and f.data[0]['y'] == [3, 4]
    assert f.data[1]['orientation'] == 'h' and f.data[1]['x'] == [5, 6]

def test_hist_bins_and_density():
    plt.hist([1, 1, 2, 3], bins=3, density=True)
    t = plt.gcf().data[0]
    assert t['type'] == 'histogram' and t['nbinsx'] == 3
    assert t['histnorm'] == 'probability density'

def test_boxplot_single_and_multiple():
    plt.boxplot([1, 2, 3])
    assert plt.gcf().data[0]['type'] == 'box'
    plt.figure()
    plt.boxplot([[1, 2], [3, 4]], labels=['A', 'B'])
    f = plt.gcf()
    assert len(f.data) == 2
    assert f.data[0]['name'] == 'A' and f.data[1]['y'] == [3, 4]

def test_pie_values_labels_and_legend_default():
    plt.pie([30, 70], labels=['a', 'b'])
    f = plt.gcf()
    assert f.data[0]['type'] == 'pie'
    assert f.data[0]['values'] == [30, 70] and f.data[0]['labels'] == ['a', 'b']
    assert f.layout['showlegend'] is True    # pie-unntaket fra Task 2
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest brython/tests/test_matplotlib_brython.py -q`
Expected: 6 new tests FAIL with `AttributeError: module 'matplotlib_brython' has no attribute 'scatter'` (etc.).

- [ ] **Step 3: Implement**

Insert into `brython/matplotlib_brython.py` (after `plot`, before `title`):

```python
def scatter(x, y, s=None, c=None, alpha=None, label=None, **kwargs):
    marker = {}
    if isinstance(c, str):
        marker['color'] = c
    elif c is not None:
        # tallverdier -> kontinuerlig fargeskala (som plt gjør med cmap)
        marker['color'] = _values(c)
        marker['colorscale'] = 'Viridis'
        marker['showscale'] = True
    else:
        marker['color'] = _next_color()
    if s is not None:
        # NB: matplotlib-s er areal i pt^2, plotly-size er diameter i px —
        # verdien sendes videre som-den-er (godt nok for undervisningsbruk)
        marker['size'] = s if isinstance(s, (int, float)) else _values(s)
    if alpha is not None:
        marker['opacity'] = alpha
    _state['traces'].append(_clean({'type': 'scatter', 'x': _values(x),
                                    'y': _values(y), 'mode': 'markers',
                                    'marker': marker, 'name': label}))


def bar(x, height, color=None, label=None, **kwargs):
    _state['traces'].append(_clean({'type': 'bar', 'x': _values(x),
                                    'y': _values(height),
                                    'marker': {'color': color or _next_color()},
                                    'name': label}))


def barh(y, width, color=None, label=None, **kwargs):
    _state['traces'].append(_clean({'type': 'bar', 'x': _values(width),
                                    'y': _values(y), 'orientation': 'h',
                                    'marker': {'color': color or _next_color()},
                                    'name': label}))


def hist(x, bins=None, color=None, label=None, density=False, **kwargs):
    t = {'type': 'histogram', 'x': _values(x),
         'marker': {'color': color or _next_color()}, 'name': label}
    if isinstance(bins, int):
        t['nbinsx'] = bins
    if density:
        t['histnorm'] = 'probability density'
    _state['traces'].append(_clean(t))


def _is_listlike(v):
    return hasattr(v, '__len__') and not isinstance(v, str) or hasattr(v, 'tolist')


def boxplot(x, labels=None, **kwargs):
    series_list = list(x) if _is_listlike(x) and len(x) and _is_listlike(list(x)[0]) else [x]
    for i, series in enumerate(series_list):
        name = labels[i] if labels is not None and i < len(labels) else None
        _state['traces'].append(_clean({'type': 'box', 'y': _values(series),
                                        'name': name}))


def pie(x, labels=None, colors=None, autopct=None, **kwargs):
    # autopct ignoreres — plotly viser prosent i hover/tekst selv
    _state['traces'].append(_clean({'type': 'pie', 'values': _values(x),
                                    'labels': _values(labels) if labels is not None else None,
                                    'marker': {'colors': list(colors)} if colors else None}))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest brython/tests/test_matplotlib_brython.py -q`
Expected: 14 PASS.

- [ ] **Step 5: Commit**

```bash
git add brython/matplotlib_brython.py brython/tests/test_matplotlib_brython.py
git commit -m "feat(brython): matplotlib_brython chart functions — scatter/bar/hist/box/pie"
```

---

### Task 4: Axis/layout functions + minimal subplots()

**Files:**
- Modify: `brython/matplotlib_brython.py` (append after `ylabel`, before `gcf`)
- Test: `brython/tests/test_matplotlib_brython.py` (append)

**Interfaces:**
- Consumes: `_state`, `_values`, and the public chart/label functions from Tasks 2–3.
- Produces: `xlim(a=None, b=None)`, `ylim(a=None, b=None)` (accept two scalars or one tuple), `legend(**kw)`, `grid(visible=True, **kw)`, `xticks(ticks=None, labels=None, rotation=None, **kw)`, `yticks(...)`, `tight_layout(**kw)` (no-op), `savefig(*a, **kw)` (renders like show()), `subplots(nrows=1, ncols=1, figsize=None, **kw) -> (_FigureHandle, _Axes)` where `_Axes` delegates plot/scatter/bar/barh/hist/boxplot/pie/set_title/set_xlabel/set_ylabel/set_xlim/set_ylim/legend/grid to the module functions, and `_FigureHandle` has `show()`, `savefig()`, `tight_layout()`.

- [ ] **Step 1: Write the failing tests**

Append to `brython/tests/test_matplotlib_brython.py`:

```python
def test_xlim_ylim_scalar_and_tuple():
    plt.plot([1], [1])
    plt.xlim(0, 10)
    plt.ylim((2, 8))
    lay = plt.gcf().layout
    assert lay['xaxis']['range'] == [0, 10]
    assert lay['yaxis']['range'] == [2, 8]

def test_legend_and_grid():
    plt.plot([1], [1], label='serie')
    plt.legend()
    plt.grid(False)
    lay = plt.gcf().layout
    assert lay['showlegend'] is True
    assert lay['xaxis']['showgrid'] is False and lay['yaxis']['showgrid'] is False

def test_xticks_rotation_and_labels():
    plt.bar(['a', 'b'], [1, 2])
    plt.xticks([0, 1], ['Alfa', 'Beta'], rotation=45)
    ax = plt.gcf().layout['xaxis']
    assert ax['tickvals'] == [0, 1]
    assert ax['ticktext'] == ['Alfa', 'Beta']
    assert ax['tickangle'] == -45

def test_savefig_renders_like_show(capsys):
    plt.plot([1, 2], [3, 4])
    plt.savefig('fig.png')
    out = capsys.readouterr().out
    assert (ES + 'figure__') in out

def test_subplots_1x1_delegates(capsys):
    fig, ax = plt.subplots(figsize=(6, 3))
    ax.plot([1, 2], [3, 4])
    ax.set_title('Aksetittel')
    ax.set_xlabel('x')
    ax.legend()
    f = plt.gcf()
    assert f.layout['width'] == 600
    assert f.layout['title'] == {'text': 'Aksetittel'}
    assert f.layout['xaxis']['title'] == {'text': 'x'}
    assert f.layout['showlegend'] is True
    fig.show()
    assert (ES + 'figure__') in capsys.readouterr().out

def test_subplots_grid_raises():
    import pytest
    with pytest.raises(NotImplementedError):
        plt.subplots(2, 2)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest brython/tests/test_matplotlib_brython.py -q`
Expected: 6 new tests FAIL with AttributeError (`xlim` etc. not defined).

- [ ] **Step 3: Implement**

Insert into `brython/matplotlib_brython.py` (after `ylabel`, before `gcf`):

```python
def xlim(a=None, b=None):
    if isinstance(a, (list, tuple)):
        a, b = a
    _state['layout'].setdefault('xaxis', {})['range'] = [a, b]


def ylim(a=None, b=None):
    if isinstance(a, (list, tuple)):
        a, b = a
    _state['layout'].setdefault('yaxis', {})['range'] = [a, b]


def legend(**kwargs):
    _state['layout']['showlegend'] = True


def grid(visible=True, **kwargs):
    _state['layout'].setdefault('xaxis', {})['showgrid'] = bool(visible)
    _state['layout'].setdefault('yaxis', {})['showgrid'] = bool(visible)


def xticks(ticks=None, labels=None, rotation=None, **kwargs):
    ax = _state['layout'].setdefault('xaxis', {})
    if ticks is not None:
        ax['tickvals'] = _values(ticks)
    if labels is not None:
        ax['ticktext'] = _values(labels)
    if rotation is not None:
        ax['tickangle'] = -rotation      # mpl roterer mot klokka, plotly med


def yticks(ticks=None, labels=None, rotation=None, **kwargs):
    ax = _state['layout'].setdefault('yaxis', {})
    if ticks is not None:
        ax['tickvals'] = _values(ticks)
    if labels is not None:
        ax['ticktext'] = _values(labels)
    if rotation is not None:
        ax['tickangle'] = -rotation


def tight_layout(**kwargs):
    pass


def savefig(*args, **kwargs):
    """Filskriving finnes ikke i nettleseren — render figuren i stedet, så
    undervisningskode som slutter med savefig() ikke mister figuren."""
    show()


class _Axes:
    """Tynn delegering til modulfunksjonene — nok til fig, ax = plt.subplots()."""
    def plot(self, *a, **kw): plot(*a, **kw)
    def scatter(self, *a, **kw): scatter(*a, **kw)
    def bar(self, *a, **kw): bar(*a, **kw)
    def barh(self, *a, **kw): barh(*a, **kw)
    def hist(self, *a, **kw): hist(*a, **kw)
    def boxplot(self, *a, **kw): boxplot(*a, **kw)
    def pie(self, *a, **kw): pie(*a, **kw)
    def set_title(self, s, **kw): title(s)
    def set_xlabel(self, s, **kw): xlabel(s)
    def set_ylabel(self, s, **kw): ylabel(s)
    def set_xlim(self, *a): xlim(*a)
    def set_ylim(self, *a): ylim(*a)
    def legend(self, **kw): legend()
    def grid(self, visible=True, **kw): grid(visible)


class _FigureHandle:
    def show(self): show()
    def savefig(self, *a, **kw): savefig(*a, **kw)
    def tight_layout(self, **kw): pass


def subplots(nrows=1, ncols=1, figsize=None, **kwargs):
    """Kun 1x1 — flerpanel: bruk plotly_express_brython-facets i stedet."""
    if nrows != 1 or ncols != 1:
        raise NotImplementedError(
            'subplots med flere paneler støttes ikke — '
            'bruk facet_row/facet_col i plotly_express_brython')
    figure(figsize=figsize)
    return _FigureHandle(), _Axes()
```

Note: `savefig` and `subplots` reference `show`/`figure` which are defined later/earlier in the file — module-level function references resolve at call time in Python, so definition order across this insertion point is not a problem. Keep `savefig` exactly here (before `gcf`) for readability anyway.

- [ ] **Step 4: Run the full new test file + whole suite**

Run: `python3 -m pytest brython/tests/ -q`
Expected: all PASS (20 matplotlib tests + all existing).

- [ ] **Step 5: Commit**

```bash
git add brython/matplotlib_brython.py brython/tests/test_matplotlib_brython.py
git commit -m "feat(brython): matplotlib_brython axes/layout API + 1x1 subplots"
```

---

### Task 5: Registry entry, example, index.html button

**Files:**
- Modify: `js/brython-engine.js` (LIB_REGISTRY)
- Create: `examples/bry13_matplotlib.txt`
- Modify: `index.html` (example-button list, after the bry12 button at ~line 95)
- Test: `brython/tests/test_engine_scan.py` (append)

**Interfaces:**
- Consumes: Stage-1 `LIB_REGISTRY`/`scanImports` (aliases resolve to canonical names; dotted names match on first segment) and Task 1's dotted `_alias_module`.
- Produces: registry entry `matplotlib_brython: { aliases: ['matplotlib', 'matplotlib.pyplot'], deps: ['plotly_express_brython'], js: [] }`.

- [ ] **Step 1: Write the failing scan tests**

Append to `brython/tests/test_engine_scan.py`:

```python
def test_matplotlib_alias_resolves_to_canonical():
    assert scan('import matplotlib.pyplot as plt') == ['matplotlib_brython']
    assert scan('import matplotlib') == ['matplotlib_brython']
    assert scan('import matplotlib_brython as plt') == ['matplotlib_brython']
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest brython/tests/test_engine_scan.py -q`
Expected: the new test FAILS (`[] != ['matplotlib_brython']`) — no registry entry yet.

- [ ] **Step 3: Add the registry entry**

In `js/brython-engine.js`, extend `LIB_REGISTRY`:

```js
  var LIB_REGISTRY = {
    // pandas_brython.py:15 har en modulnivå try-import av plotly (df.plot);
    // uten deps-oppføringen feiler den stille ved lazy registrering.
    pandas_brython:         { aliases: [], deps: ['plotly_express_brython'], js: [] },
    plotly_express_brython: { aliases: [], deps: [], js: [] },
    // aliasrekkefølgen er bindende: 'matplotlib' (plain) må registreres før
    // den dottede 'matplotlib.pyplot' (trenger forelderen i sys.modules)
    matplotlib_brython:     { aliases: ['matplotlib', 'matplotlib.pyplot'],
                              deps: ['plotly_express_brython'], js: [] }
  };
```

- [ ] **Step 4: Verify**

Run: `node --check js/brython-engine.js && python3 -m pytest brython/tests/test_engine_scan.py -q`
Expected: OK / all PASS (including the alias-resolution branch that Stage 1 could not exercise).

- [ ] **Step 5: Create the example**

Create `examples/bry13_matplotlib.txt`:

```
# Example: matplotlib i Brython-modus — plt-API-en rendret som Plotly
# Vanlig matplotlib-undervisningskode virker; figurene blir interaktive.
import matplotlib.pyplot as plt

aar = [2020, 2021, 2022, 2023]
nord = [120, 135, 150, 162]
sor  = [210, 205, 230, 244]

plt.figure(figsize=(7, 4))
plt.plot(aar, nord, 'o-', label="Nord")
plt.plot(aar, sor, 'r--', label="Sør")
plt.title("Utvikling per region")
plt.xlabel("År")
plt.ylabel("Antall")
plt.legend()
plt.grid(True)
plt.show()

# Histogram:
inntekt = [420, 480, 510, 540, 560, 590, 610, 620, 680, 710, 820, 950]
plt.hist(inntekt, bins=5, color="seagreen")
plt.title("Inntektsfordeling (1000 kr)")
plt.show()

# fig/ax-stilen fungerer også (1x1):
fig, ax = plt.subplots(figsize=(6, 3))
ax.bar(["Nord", "Sør", "Øst"], [162, 244, 199])
ax.set_title("Antall per region 2023")
fig.show()
```

- [ ] **Step 6: Add the example button**

In `index.html`, directly after the bry12 button (`data-example="bry12_cheatsheet.txt"`, ~line 95), insert:

```html
              <button type="button" data-example="bry13_matplotlib.txt" data-mode="brython" data-i18n>matplotlib &mdash; plt-API (Plotly-rendret)</button>
```

(No en.js entry needed — i18n leaves unknown keys untouched.)

- [ ] **Step 7: Full suite + commit**

Run: `python3 -m pytest brython/tests/ -q && node --check js/brython-engine.js`
Expected: all PASS.

```bash
git add js/brython-engine.js examples/bry13_matplotlib.txt index.html brython/tests/test_engine_scan.py
git commit -m "feat(brython): register matplotlib_brython with matplotlib.pyplot alias + example"
```

---

### Task 6: Browser verification (the dotted-import risk)

**Files:** none (verification only). The one thing CPython tests cannot prove: Brython 3.12's import machinery honoring `import matplotlib.pyplot as plt` via pre-populated `sys.modules` + parent attribute.

- [ ] **Step 1: Serve** — `cd /Users/hom/Documents/GitHub/microdata && python3 -m http.server 8765`

- [ ] **Step 2: Engine smoke via browser console/automation**

On `http://localhost:8765`, run through `window.BrythonEngine.run(...)`:
1. `import matplotlib.pyplot as plt\nplt.plot([1,2,3],[4,5,6])\nplt.title("t")\nplt.show()` → expect `{error: null}` and text containing `figure__` with `"y":[4,5,6]`.
2. `import matplotlib\nrepr(matplotlib.pyplot)` → expect module repr, no error.
3. The `bry13_matplotlib.txt` example verbatim → three figures, no error.
4. Network tab: `matplotlib_brython.py` fetched only when first imported; `plotly_express_brython.py` fetched before it (deps order).

- [ ] **Step 3: If step 2's dotted import fails in Brython** (import machinery bypasses sys.modules): fall back to registering a synthetic parent package — in `_alias_module`, when creating the binding also give the parent a `__path__ = []` attribute if missing. Diagnose with the browser console error before changing anything.

- [ ] **Step 4: Record results; fix + commit anything found.**

---

### Task 7: Port to safestat and openstat

**Files:**
- Copy to `../safestat` then `../openstat`: `js/brython-engine.js`, `brython/brython_runner.py`, `brython/matplotlib_brython.py`, `brython/tests/test_brython_runner.py`, `brython/tests/test_matplotlib_brython.py`, `brython/tests/test_engine_scan.py`, `examples/bry13_matplotlib.txt`
- NOT copied: `index.html` (UI files drift freely per repo convention — add the example button manually in each sibling, same one-line insert as Task 5 Step 6, after each repo's bry12 button)

- [ ] **Step 1: Copy files (safestat first), add the button in each sibling's index.html**

```bash
cd /Users/hom/Documents/GitHub
for sib in safestat openstat; do
  cp microdata/js/brython-engine.js       $sib/js/brython-engine.js
  cp microdata/brython/brython_runner.py  $sib/brython/brython_runner.py
  cp microdata/brython/matplotlib_brython.py $sib/brython/
  cp microdata/brython/tests/test_brython_runner.py $sib/brython/tests/
  cp microdata/brython/tests/test_matplotlib_brython.py $sib/brython/tests/
  cp microdata/brython/tests/test_engine_scan.py $sib/brython/tests/
  cp microdata/examples/bry13_matplotlib.txt $sib/examples/
done
```

Then add the Task 5 Step 6 button line after each sibling's bry12 button in index.html.

- [ ] **Step 2: Run each sibling's suite**

```bash
(cd safestat && python3 -m pytest brython/tests/ -q)
(cd openstat && python3 -m pytest brython/tests/ -q)
```
Expected: all PASS in both.

- [ ] **Step 3: sync_check + commit each repo**

```bash
(cd safestat && sh scripts/sync_check.sh)
(cd safestat && git add -A brython/ js/brython-engine.js examples/bry13_matplotlib.txt index.html && git commit -m "feat(brython): matplotlib.pyplot shim (ported from microdata)")
(cd openstat && git add -A brython/ js/brython-engine.js examples/bry13_matplotlib.txt index.html && git commit -m "feat(brython): matplotlib.pyplot shim (ported from microdata)")
```

- [ ] **Step 4: Quick browser smoke in safestat** (serve on 8766, run test 1 from Task 6).
