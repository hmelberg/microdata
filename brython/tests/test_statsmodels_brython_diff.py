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
