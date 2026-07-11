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
