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
