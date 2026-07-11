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

def test_no_intercept_categorical_full_rank():
    # patsy: uten konstantledd får første kategoriske term ALLE nivåer, uten T.
    _, names, X, _ = smb._build_design('y ~ region - 1', DATA)
    assert names == ['region[N]', 'region[O]', 'region[S]']
    assert X[0] == [1.0, 0.0, 0.0]     # rad 1: N
    assert X[4] == [0.0, 1.0, 0.0]     # rad 5: O

def test_c_numeric_levels_sorted_numerically():
    d = {'y': [1.0, 1.0, 1.0, 1.0, 1.0], 'code': [1, 2, 10, 11, 3]}
    _, names, _, _ = smb._build_design('y ~ C(code)', d)
    assert names == ['Intercept', 'C(code)[T.2]', 'C(code)[T.3]',
                     'C(code)[T.10]', 'C(code)[T.11]']

def test_mismatched_column_lengths_raise():
    with pytest.raises(ValueError):
        smb._build_design('y ~ x', {'y': [1.0, 2.0], 'x': [1.0, 2.0, 3.0]})
