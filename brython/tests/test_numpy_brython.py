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
