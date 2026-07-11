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


# NB: seaborn-API-et krever sns.set(...) — dette aliaset SKYGGER innebygde
# set() for all kode under denne linja. Derfor ligger det sist i fila, og
# ingen intern kode bruker bare set().
set = set_theme
