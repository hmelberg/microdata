import sys, os, math
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import pytest
import numpy_brython as np


def test_array_1d_basics():
    a = np.array([1, 2, 3])
    assert a.ndim == 1 and a.shape == (3,) and a.size == 3
    assert a.tolist() == [1, 2, 3]
    assert len(a) == 3
    assert list(a) == [1, 2, 3]
    assert a[0] == 1 and a[-1] == 3
    assert a[1:].tolist() == [2, 3]

def test_array_2d_basics():
    m = np.array([[1, 2, 3], [4, 5, 6]])
    assert m.ndim == 2 and m.shape == (2, 3) and m.size == 6
    assert m.tolist() == [[1, 2, 3], [4, 5, 6]]
    assert m[1, 2] == 6
    assert m[0].tolist() == [1, 2, 3]
    assert m[:, 1].tolist() == [2, 5]
    assert m[1, :].tolist() == [4, 5, 6]
    assert m.T.tolist() == [[1, 4], [2, 5], [3, 6]]

def test_array_ragged_raises():
    with pytest.raises(ValueError):
        np.array([[1, 2], [3]])

def test_bool_mask_and_fancy_indexing():
    a = np.array([10, 20, 30, 40])
    assert a[[True, False, True, False]].tolist() == [10, 30]
    assert a[[2, 0]].tolist() == [30, 10]

def test_setitem_int_mask_slice():
    a = np.array([1, 2, 3, 4])
    a[0] = 9
    assert a.tolist() == [9, 2, 3, 4]
    a[[False, True, False, True]] = 0
    assert a.tolist() == [9, 0, 3, 0]
    a[1:3] = [7, 8]
    assert a.tolist() == [9, 7, 8, 0]

def test_constructors():
    assert np.arange(4).tolist() == [0, 1, 2, 3]
    assert np.arange(1, 7, 2).tolist() == [1, 3, 5]
    assert np.linspace(0.0, 1.0, 5).tolist() == [0.0, 0.25, 0.5, 0.75, 1.0]
    assert np.linspace(0.0, 1.0, 5).tolist()[-1] == 1.0   # eksakt endepunkt
    assert np.zeros(3).tolist() == [0.0, 0.0, 0.0]
    assert np.ones((2, 2)).tolist() == [[1.0, 1.0], [1.0, 1.0]]
    assert np.full(2, 7.5).tolist() == [7.5, 7.5]

def test_asarray_and_copy_semantics():
    a = np.array([1, 2, 3])
    assert np.asarray(a) is a
    b = np.array(a)
    b[0] = 99
    assert a.tolist() == [1, 2, 3]      # kopi, aldri view

def test_constants():
    assert np.nan != np.nan
    assert abs(np.pi - math.pi) < 1e-15

def test_filled_one_tuple_shape():
    assert np.zeros((3,)).tolist() == [0.0, 0.0, 0.0]
    assert np.full((2,), 5).tolist() == [5, 5]
    with pytest.raises(ValueError, match='støttes'):
        np.ones((2, 2, 2))

def test_arithmetic_scalar_and_array():
    a = np.array([1.0, 2.0, 3.0])
    assert (a + 1).tolist() == [2.0, 3.0, 4.0]
    assert (1 + a).tolist() == [2.0, 3.0, 4.0]
    assert (a * 2).tolist() == [2.0, 4.0, 6.0]
    assert (10 - a).tolist() == [9.0, 8.0, 7.0]
    assert (a / 2).tolist() == [0.5, 1.0, 1.5]
    assert (2 / a).tolist() == [2.0, 1.0, 2.0 / 3.0]
    assert (a ** 2).tolist() == [1.0, 4.0, 9.0]
    assert (-a).tolist() == [-1.0, -2.0, -3.0]

def test_arithmetic_array_array_and_shape_mismatch():
    a = np.array([1.0, 2.0])
    b = np.array([10.0, 20.0])
    assert (a + b).tolist() == [11.0, 22.0]
    assert (a * [3, 4]).tolist() == [3.0, 8.0]
    m = np.array([[1, 2], [3, 4]])
    assert (m + m).tolist() == [[2, 4], [6, 8]]
    with pytest.raises(ValueError):
        a + np.array([1.0, 2.0, 3.0])

def test_comparisons_and_mask_flow():
    a = np.array([1, 5, 3, 8])
    assert (a > 3).tolist() == [False, True, False, True]
    assert (a == 3).tolist() == [False, False, True, False]
    assert a[(a > 3).tolist()].tolist() == [5, 8]
    assert a[a > 3].tolist() == [5, 8]          # maske direkte som ndarray

def test_unary_math():
    assert np.sqrt(np.array([1.0, 4.0, 9.0])).tolist() == [1.0, 2.0, 3.0]
    assert np.sqrt(16) == 4.0                    # skalar inn -> skalar ut
    assert np.abs(np.array([-1, 2, -3])).tolist() == [1, 2, 3]
    assert np.round(np.array([1.234, 5.678]), 1).tolist() == [1.2, 5.7]
    assert np.exp(0) == 1.0
    r = np.log(np.array([1.0, math.e]))
    assert r[0] == pytest.approx(0.0) and r[1] == pytest.approx(1.0)
    assert np.isnan(np.array([1.0, np.nan])).tolist() == [False, True]

def test_bool_of_array_is_guarded():
    assert bool(np.array([1]))
    assert not bool(np.array([0]))
    with pytest.raises(ValueError, match='tvetydig'):
        bool(np.array([1, 2]) == np.array([1, 2]))
    with pytest.raises(ValueError, match='tvetydig'):
        if np.array([1, 2, 3]) > 2:
            pass

def test_aggregation_methods_and_functions():
    a = np.array([1.0, 2.0, 3.0, 4.0])
    assert a.mean() == 2.5 and np.mean(a) == 2.5
    assert np.mean([1, 2, 3]) == 2.0                 # liste rett inn
    assert a.sum() == 10.0 and np.sum(a) == 10.0
    assert a.min() == 1.0 and np.max(a) == 4.0
    assert a.var() == pytest.approx(1.25)            # ddof=0 (numpy-default!)
    assert a.std() == pytest.approx(math.sqrt(1.25))
    assert a.var(ddof=1) == pytest.approx(5.0 / 3.0)
    assert np.median([3, 1, 2]) == 2
    assert np.median([4, 1, 3, 2]) == 2.5
    m = np.array([[1, 2], [3, 4]])
    assert m.mean() == 2.5 and m.sum() == 10          # aggregering over alt

def test_percentile_linear_interpolation():
    a = [1.0, 2.0, 3.0, 4.0]
    assert np.percentile(a, 50) == 2.5
    assert np.percentile(a, 25) == 1.75
    assert np.percentile(a, 0) == 1.0 and np.percentile(a, 100) == 4.0
    assert np.quantile(a, 0.5) == 2.5
    assert np.percentile(a, [25, 75]).tolist() == [1.75, 3.25]

def test_sort_argsort_argmax_unique_cumsum():
    a = np.array([3, 1, 2, 1])
    assert np.sort(a).tolist() == [1, 1, 2, 3]
    assert np.argsort(a).tolist() == [1, 3, 2, 0]
    assert a.argmax() == 0 and np.argmin(a) == 1
    assert np.unique(a).tolist() == [1, 2, 3]
    assert a.cumsum().tolist() == [3, 4, 6, 7]

def test_where_both_forms():
    c = np.array([True, False, True])
    assert np.where(c, 1, 0).tolist() == [1, 0, 1]
    x = np.array([10, 20, 30])
    y = np.array([-1, -2, -3])
    assert np.where(c, x, y).tolist() == [10, -2, 30]
    idx = np.where(np.array([0, 5, 0, 7]) > 0)
    assert isinstance(idx, tuple) and idx[0].tolist() == [1, 3]

def test_concatenate_and_dot():
    assert np.concatenate([np.array([1, 2]), [3], np.array([4])]).tolist() == [1, 2, 3, 4]
    assert np.dot([1, 2, 3], [4, 5, 6]) == 32
    m = np.array([[1, 2], [3, 4]])
    v = np.array([5, 6])
    assert np.dot(m, v).tolist() == [17, 39]
    assert np.dot(m, m).tolist() == [[7, 10], [15, 22]]
    assert (m @ v).tolist() == [17, 39]
    with pytest.raises(ValueError):
        np.dot([1, 2], [1, 2, 3])

def test_astype_and_round_method():
    a = np.array([1.7, 2.2])
    assert a.astype(int).tolist() == [1, 2]
    assert a.round().tolist() == [2.0, 2.0]
