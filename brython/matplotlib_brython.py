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
