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


def title(s, **kwargs):
    _state['layout']['title'] = {'text': s}


def xlabel(s, **kwargs):
    _state['layout'].setdefault('xaxis', {})['title'] = {'text': s}


def ylabel(s, **kwargs):
    _state['layout'].setdefault('yaxis', {})['title'] = {'text': s}


def gcf():
    """Gjeldende figur som PlotlyFigure — LEVENDE, som i matplotlib: mutasjoner
    på den returnerte figuren (f.eks. update_layout) gjelder gjeldende figur
    frem til neste figure()/show()."""
    if 'showlegend' not in _state['layout']:
        # matplotlib viser ikke legend uten legend() — unntak: pie har
        # etiketter i legenden i plotly, så den beholdes synlig.
        _state['layout']['showlegend'] = any(
            t.get('type') == 'pie' for t in _state['traces'])
    return PlotlyFigure({'data': _state['traces'],
                         'layout': _state['layout'], 'config': {}})


def show():
    """Render gjeldende figur (embed-markør på stdout) og nullstill."""
    if not _state['traces'] and not _state['layout']:
        return
    fig = gcf()
    print(_EMBED_S + 'figure__' + '\n' + fig.to_plotly_json_str() + '\n' + _EMBED_E)
    _reset()
