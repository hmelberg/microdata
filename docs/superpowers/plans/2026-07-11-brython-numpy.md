# Brython numpy Subset Implementation Plan (Stage 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Brython-mode users run standard `import numpy as np` teaching code — arrays, elementwise math, aggregations, and seeded `np.random` — in pure Python, diff-tested against real numpy, feeding directly into the matplotlib/scipy/statsmodels shims.

**Architecture:** One module `brython/numpy_brython.py`. An `ndarray` class over plain Python lists (1D flat list, 2D list-of-rows; copy semantics — never views) carries the implementation in its methods; module-level functions (`np.mean`, `np.sum`, …) delegate via `asarray(x).method()`. `np.random` is a `_RandomState` instance built on Python's `random.Random` (same seed → same numbers on every run, but NOT the same stream as real numpy — documented). Integration is free via the ecosystem's `.tolist()` duck-typing.

**Tech Stack:** Brython 3.12 / CPython 3.13 + pytest; real numpy on the dev machine for diff-tests (importorskip'd); stage-1 lazy engine; AST guard tests apply automatically.

## Global Constraints

- `brython/numpy_brython.py` runs under BOTH CPython 3.13 and Brython 3.12 — imports ONLY `math` and `random as _pyrandom`; no other intra-repo deps (`deps: []` in LIB_REGISTRY).
- **Builtin-shadowing rule (this module's own trap):** module-level functions named `sum/min/max/abs/round` shadow the builtins for ALL code in the module. The module binds `_sum, _min, _max, _abs, _round = sum, min, max, abs, round` at the top and ALL internal code (methods, helpers) uses ONLY the underscore versions. Bare `sum(`/`min(`/`max(`/`abs(`/`round(` anywhere below the definitions of the shadowing functions is a bug.
- **Brython-feller** (AST-guarded): ndarray has methods `mean/sum/min/max/std/var/round/...` and the module has same-named functions — method bodies must NEVER reference those bare names (the underscore rule above satisfies this automatically); no non-string setdefault.
- numpy-semantics fixed by this plan: `std`/`var` default **ddof=0**; `percentile` uses linear interpolation (`pos = (n-1)·q/100`); `linspace` endpoint is exactly `float(stop)`; comparisons return bool ndarrays; `arr[bool_mask]` filters; copy semantics everywhere.
- Deliberately excluded (document in module docstring): full broadcasting (only scalar↔array and identical shapes), dtypes (everything is Python int/float/bool), views, reshape beyond `.T`, linalg beyond `dot`/`@`. `import numpy.random` as a MODULE is unsupported (np.random works as an attribute) — document.
- `np.random` reproducibility contract: same seed → same numbers across runs and across CPython/Brython, but NOT numerically equal to real numpy's streams (different use of the Mersenne generator) — diff tests therefore test reproducibility/shape/statistics, never exact values.
- Tests compare arrays via `.tolist()` (ndarray defines `__eq__` elementwise, so bare `==` in asserts is a trap).
- Norwegian user-facing error strings. NO sw.js changes. Feature branch in microdata; port safestat-first at the end (check safestat's checked-out branch — another session may be on `dash-v2`; commit brython ports to `master` via a temp worktree if so).

---

### Task 1: ndarray core + constructors

**Files:**
- Create: `brython/numpy_brython.py`
- Test: `brython/tests/test_numpy_brython.py` (new)

**Interfaces:**
- Produces (all later tasks consume): class `ndarray` with `_d` (flat list or list-of-rows), `ndim`, `shape`, `size`, `T`, `tolist()`, `_flat()`, indexing (`[int]`, `[slice]`, `[bool-list/ndarray]`, `[int-list]`, 2D `[i,j]`/`[i,:]`/`[:,j]`), `__setitem__` (int; bool-mask=scalar; slice=list), `__len__`, `__iter__`, `__repr__`; functions `array(data)`, `asarray(a)`, `arange(start, stop=None, step=1)`, `linspace(start, stop, num=50)`, `zeros(shape)`, `ones(shape)`, `full(shape, value)`; module constants `nan`, `pi`, `e`; private builtins `_sum/_min/_max/_abs/_round`.

- [ ] **Step 1: Write the failing tests**

Create `brython/tests/test_numpy_brython.py`:

```python
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/hom/Documents/GitHub/microdata && python3 -m pytest brython/tests/test_numpy_brython.py -q`
Expected: FAIL at import — `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

Create `brython/numpy_brython.py`:

```python
# numpy_brython — numpy-subsett i ren Python for Brython-modus.
# Importeres som `import numpy as np` (alias i LIB_REGISTRY).
#
# 1D/2D-arrays over rene Python-lister, KOPI-semantikk (aldri views).
# Bevisst utelatt: full broadcasting (kun skalar<->array og lik form),
# dtyper, reshape utover .T, linalg utover dot/@. `import numpy.random`
# som MODUL støttes ikke — bruk np.random-attributtet.
#
# NB to feller i denne fila:
#  1) Modulfunksjonene sum/min/max/abs/round SKYGGER innebygde — all intern
#     kode bruker _sum/_min/_max/_abs/_round (bundet under).
#  2) Brython-fellene (se test_brython_scoping_trap.py): metodekropper må
#     aldri referere en global med metodens navn — underscore-regelen over
#     oppfyller dette.
import math
import random as _pyrandom

_sum, _min, _max, _abs, _round = sum, min, max, abs, round

nan = float('nan')
pi = math.pi
e = math.e


class ndarray:
    """1D/2D-array. _d er flat liste (1D) eller liste av rader (2D)."""

    def __init__(self, data):
        if isinstance(data, ndarray):
            data = data.tolist()
        data = list(data)
        if data and isinstance(data[0], (list, tuple, ndarray)):
            rows = [list(r.tolist() if isinstance(r, ndarray) else r)
                    for r in data]
            w = len(rows[0])
            for r in rows:
                if len(r) != w:
                    raise ValueError('array: radene har ulik lengde')
            self._d = rows
            self.ndim = 2
            self.shape = (len(rows), w)
        else:
            self._d = list(data)
            self.ndim = 1
            self.shape = (len(self._d),)

    @property
    def size(self):
        return self.shape[0] * (self.shape[1] if self.ndim == 2 else 1)

    @property
    def T(self):
        if self.ndim == 1:
            return ndarray(self._d)
        return ndarray([[self._d[r][c] for r in range(self.shape[0])]
                        for c in range(self.shape[1])])

    def tolist(self):
        if self.ndim == 1:
            return list(self._d)
        return [list(r) for r in self._d]

    def _flat(self):
        if self.ndim == 1:
            return list(self._d)
        return [v for row in self._d for v in row]

    def __len__(self):
        return self.shape[0]

    def __iter__(self):
        if self.ndim == 1:
            return iter(list(self._d))
        return iter([ndarray(r) for r in self._d])

    def __getitem__(self, key):
        if isinstance(key, tuple):
            if self.ndim != 2 or len(key) != 2:
                raise IndexError('tuppel-indeks krever 2D-array')
            i, j = key
            if isinstance(i, int) and isinstance(j, int):
                return self._d[i][j]
            if isinstance(i, int):
                return ndarray(self._d[i][j])
            if isinstance(j, int):
                return ndarray([row[j] for row in self._d[i]])
            return ndarray([row[j] for row in self._d[i]])
        if isinstance(key, ndarray):
            key = key.tolist()
        if isinstance(key, list):
            if key and isinstance(key[0], bool):
                if len(key) != len(self._d):
                    raise IndexError('boolsk maske har feil lengde')
                return ndarray([v for v, k in zip(self._d, key) if k])
            return ndarray([self._d[i] for i in key])
        if isinstance(key, slice):
            return ndarray(self._d[key])
        out = self._d[key]
        return ndarray(out) if isinstance(out, list) else out

    def __setitem__(self, key, value):
        if isinstance(key, ndarray):
            key = key.tolist()
        if isinstance(value, ndarray):
            value = value.tolist()
        if isinstance(key, list) and key and isinstance(key[0], bool):
            if not isinstance(value, (int, float)):
                raise ValueError('maske-tilordning støtter kun skalar verdi')
            for i, k in enumerate(key):
                if k:
                    self._d[i] = value
        elif isinstance(key, slice):
            n = len(range(*key.indices(len(self._d))))
            self._d[key] = (list(value) if isinstance(value, (list, tuple))
                            else [value] * n)
        else:
            self._d[key] = value

    def __repr__(self):
        return 'array(%r)' % (self.tolist(),)


def array(data):
    return ndarray(data)


def asarray(a):
    if isinstance(a, ndarray):
        return a
    if isinstance(a, (list, tuple)):
        return ndarray(a)
    if hasattr(a, 'tolist'):
        return ndarray(a.tolist())
    return ndarray([a])


def arange(start, stop=None, step=1):
    if stop is None:
        start, stop = 0, start
    if step == 0:
        raise ValueError('arange: step kan ikke være 0')
    out = []
    v = start
    while (step > 0 and v < stop) or (step < 0 and v > stop):
        out.append(v)
        v += step
    return ndarray(out)


def linspace(start, stop, num=50):
    if num < 1:
        raise ValueError('linspace: num må være minst 1')
    if num == 1:
        return ndarray([float(start)])
    step = (stop - start) / (num - 1)
    vals = [start + step * i for i in range(num - 1)]
    vals.append(float(stop))                       # eksakt endepunkt som numpy
    return ndarray(vals)


def _filled(shape, value):
    if isinstance(shape, tuple):
        r, c = shape
        return ndarray([[value] * c for _ in range(r)])
    return ndarray([value] * shape)


def zeros(shape):
    return _filled(shape, 0.0)


def ones(shape):
    return _filled(shape, 1.0)


def full(shape, value):
    return _filled(shape, value)
```

- [ ] **Step 4: Run tests + guards**

Run: `python3 -m pytest brython/tests/test_numpy_brython.py brython/tests/test_brython_scoping_trap.py -q`
Expected: 8 + 2 PASS.

- [ ] **Step 5: Commit**

```bash
git add brython/numpy_brython.py brython/tests/test_numpy_brython.py
git commit -m "feat(brython): numpy_brython ndarray core + constructors"
```

---

### Task 2: Elementwise operations, comparisons, unary math

**Files:**
- Modify: `brython/numpy_brython.py` (methods inside `ndarray` + module functions)
- Test: `brython/tests/test_numpy_brython.py` (append)

**Interfaces:**
- Consumes: `ndarray`, `asarray`, `_abs`, `_round`.
- Produces: arithmetic dunders (`+ - * / **` with reflected variants, `-a`, `abs(a)`), comparison dunders returning bool ndarrays, `__matmul__` (delegates to Task 3's `dot` — call-time lookup, safe), module functions `sqrt/log/exp/abs/round/isnan` (scalar in → scalar out; array in → array out).

- [ ] **Step 1: Write the failing tests**

Append to `brython/tests/test_numpy_brython.py`:

```python
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
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest brython/tests/test_numpy_brython.py -q`
Expected: new tests FAIL (`TypeError: unsupported operand` / AttributeError).

- [ ] **Step 3: Implement**

Add methods inside `ndarray` (after `__setitem__`, before `__repr__`):

```python
    def _binop(self, other, fn):
        if isinstance(other, (list, tuple)):
            other = ndarray(other)
        if isinstance(other, ndarray):
            if other.shape != self.shape:
                raise ValueError('array-former passer ikke: %r mot %r'
                                 % (self.shape, other.shape))
            if self.ndim == 1:
                return ndarray([fn(a, b) for a, b in zip(self._d, other._d)])
            return ndarray([[fn(a, b) for a, b in zip(r1, r2)]
                            for r1, r2 in zip(self._d, other._d)])
        if self.ndim == 1:
            return ndarray([fn(a, other) for a in self._d])
        return ndarray([[fn(a, other) for a in r] for r in self._d])

    def __add__(self, o): return self._binop(o, lambda a, b: a + b)
    def __radd__(self, o): return self._binop(o, lambda a, b: b + a)
    def __sub__(self, o): return self._binop(o, lambda a, b: a - b)
    def __rsub__(self, o): return self._binop(o, lambda a, b: b - a)
    def __mul__(self, o): return self._binop(o, lambda a, b: a * b)
    def __rmul__(self, o): return self._binop(o, lambda a, b: b * a)
    def __truediv__(self, o): return self._binop(o, lambda a, b: a / b)
    def __rtruediv__(self, o): return self._binop(o, lambda a, b: b / a)
    def __pow__(self, o): return self._binop(o, lambda a, b: a ** b)
    def __neg__(self): return self._binop(0, lambda a, b: -a)
    def __abs__(self): return self._binop(0, lambda a, b: _abs(a))

    def __lt__(self, o): return self._binop(o, lambda a, b: a < b)
    def __le__(self, o): return self._binop(o, lambda a, b: a <= b)
    def __gt__(self, o): return self._binop(o, lambda a, b: a > b)
    def __ge__(self, o): return self._binop(o, lambda a, b: a >= b)
    def __eq__(self, o): return self._binop(o, lambda a, b: a == b)
    def __ne__(self, o): return self._binop(o, lambda a, b: a != b)

    __hash__ = None                     # elementvis __eq__ -> uhashbar (som numpy)

    def __matmul__(self, o):
        return dot(self, o)             # dot defineres i Task 3 — oppslag ved kall
```

Note: `a[a > 3]` requires `__getitem__`'s ndarray branch (already present from Task 1 — it tolists the mask, whose elements are bools, hitting the bool branch).

Add module functions (after `full`):

```python
def _unary(a, fn):
    if isinstance(a, (int, float)) and not isinstance(a, bool):
        return fn(a)
    arr = asarray(a)
    if arr.ndim == 1:
        return ndarray([fn(v) for v in arr._d])
    return ndarray([[fn(v) for v in r] for r in arr._d])


def sqrt(a):
    return _unary(a, math.sqrt)


def log(a):
    return _unary(a, math.log)


def exp(a):
    return _unary(a, math.exp)


def abs(a):                             # skygger builtin — intern kode bruker _abs
    return _unary(a, _abs)


def round(a, decimals=0):               # skygger builtin — intern kode bruker _round
    return _unary(a, lambda v: _round(v, decimals))


def isnan(a):
    return _unary(a, lambda v: isinstance(v, float) and v != v)
```

- [ ] **Step 4: Run tests + guards**

Run: `python3 -m pytest brython/tests/test_numpy_brython.py brython/tests/test_brython_scoping_trap.py -q`
Expected: all PASS. Also grep-check the shadowing rule: `grep -n ' sum(\| min(\| max(\| abs(\| round(' brython/numpy_brython.py` — every hit below the shadowing definitions must be a definition line or use the underscore form (manual eyeball).

- [ ] **Step 5: Commit**

```bash
git add brython/numpy_brython.py brython/tests/test_numpy_brython.py
git commit -m "feat(brython): numpy elementwise ops, comparisons, unary math"
```

---

### Task 3: Aggregations + array utilities + diff tests

**Files:**
- Modify: `brython/numpy_brython.py` (methods + module functions)
- Test: `brython/tests/test_numpy_brython.py` (append) and create `brython/tests/test_numpy_brython_diff.py`

**Interfaces:**
- Consumes: `ndarray`, `asarray`, `_sum/_min/_max`, `nan`.
- Produces: ndarray methods `mean()/sum()/min()/max()/var(ddof=0)/std(ddof=0)/argmax()/argmin()/cumsum()/round(decimals=0)/astype(typ)`; module functions `mean/median/std/var/sum/min/max/percentile/quantile/cumsum/unique/sort/argsort/argmax/argmin/where/concatenate/dot` — numpy semantics (ddof=0 default, linear-interpolation percentile, `where(cond)` → tuple of index-ndarray, `where(cond, x, y)` with scalar or same-shape x/y).

- [ ] **Step 1: Write the failing tests**

Append to `brython/tests/test_numpy_brython.py`:

```python
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
```

Create `brython/tests/test_numpy_brython_diff.py`:

```python
# Differensialtester mot ekte numpy — kjøres kun der numpy finnes.
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import pytest
realnp = pytest.importorskip('numpy')
import numpy_brython as np

DATA = [12.9, 13.5, 12.8, 15.6, 17.2, 19.2, 12.6, 15.3, 14.4, 11.3]


def test_aggregations_diff():
    mine = np.array(DATA)
    ref = realnp.array(DATA)
    assert mine.mean() == pytest.approx(float(ref.mean()), rel=1e-12)
    assert mine.std() == pytest.approx(float(ref.std()), rel=1e-12)          # ddof=0
    assert mine.var(ddof=1) == pytest.approx(float(ref.var(ddof=1)), rel=1e-12)
    assert np.median(DATA) == pytest.approx(float(realnp.median(ref)), rel=1e-12)
    for q in (10, 25, 50, 75, 90, 99):
        assert np.percentile(DATA, q) == pytest.approx(
            float(realnp.percentile(ref, q)), rel=1e-12)

def test_constructors_and_ops_diff():
    assert np.linspace(0, 7, 13).tolist() == pytest.approx(
        realnp.linspace(0, 7, 13).tolist())
    assert np.arange(2, 20, 3).tolist() == realnp.arange(2, 20, 3).tolist()
    a = np.array(DATA)
    r = realnp.array(DATA)
    assert ((a - a.mean()) / a.std()).tolist() == pytest.approx(
        ((r - r.mean()) / r.std()).tolist(), rel=1e-12)

def test_sort_argsort_where_dot_diff():
    assert np.argsort(DATA).tolist() == realnp.argsort(DATA).tolist()
    assert np.sort(DATA).tolist() == pytest.approx(realnp.sort(DATA).tolist())
    c = [v > 14.0 for v in DATA]
    assert np.where(np.array(c), 1, 0).tolist() == \
        realnp.where(realnp.array(c), 1, 0).tolist()
    m = [[1.5, 2.0], [3.0, 4.5]]
    assert np.dot(m, m).tolist() == pytest.approx(
        realnp.dot(realnp.array(m), realnp.array(m)).tolist(), rel=1e-12)
    assert np.unique([3, 1, 2, 1, 3]).tolist() == \
        realnp.unique([3, 1, 2, 1, 3]).tolist()
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest brython/tests/test_numpy_brython.py brython/tests/test_numpy_brython_diff.py -q`
Expected: new tests FAIL with AttributeError (`mean`).

- [ ] **Step 3: Implement**

Add methods inside `ndarray` (after `__matmul__`):

```python
    # NB: metodene bruker KUN _sum/_min/_max (skygge-/Brython-fellene)
    def mean(self):
        flat = self._flat()
        return _sum(flat) / len(flat)

    def sum(self):
        return _sum(self._flat())

    def min(self):
        return _min(self._flat())

    def max(self):
        return _max(self._flat())

    def var(self, ddof=0):
        flat = self._flat()
        n = len(flat) - ddof
        if n <= 0:
            return nan
        m = _sum(flat) / len(flat)
        return _sum((v - m) ** 2 for v in flat) / n

    def std(self, ddof=0):
        v = self.var(ddof)
        return math.sqrt(v) if v == v else nan

    def argmax(self):
        flat = self._flat()
        return flat.index(_max(flat))

    def argmin(self):
        flat = self._flat()
        return flat.index(_min(flat))

    def cumsum(self):
        out = []
        acc = 0
        for v in self._flat():
            acc += v
            out.append(acc)
        return ndarray(out)

    def round(self, decimals=0):
        return _unary(self, lambda v: _round(v, decimals))

    def astype(self, typ):
        return _unary(self, typ)
```

Add module functions (after `isnan`):

```python
def mean(a):
    return asarray(a).mean()


def median(a):
    flat = sorted(asarray(a)._flat())
    n = len(flat)
    mid = n // 2
    if n % 2:
        return flat[mid]
    return (flat[mid - 1] + flat[mid]) / 2.0


def std(a, ddof=0):
    return asarray(a).std(ddof)


def var(a, ddof=0):
    return asarray(a).var(ddof)


def sum(a):                             # skygger builtin — intern kode bruker _sum
    return asarray(a).sum()


def min(a):                             # skygger builtin — intern kode bruker _min
    return asarray(a).min()


def max(a):                             # skygger builtin — intern kode bruker _max
    return asarray(a).max()


def percentile(a, q):
    if isinstance(q, (list, tuple)):
        return ndarray([percentile(a, x) for x in q])
    flat = sorted(asarray(a)._flat())
    if not flat:
        raise ValueError('percentile: tomt array')
    pos = (len(flat) - 1) * q / 100.0
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    if lo == hi:
        return float(flat[lo])
    frac = pos - lo
    return flat[lo] * (1.0 - frac) + flat[hi] * frac


def quantile(a, q):
    if isinstance(q, (list, tuple)):
        return ndarray([percentile(a, x * 100.0) for x in q])
    return percentile(a, q * 100.0)


def cumsum(a):
    return asarray(a).cumsum()


def unique(a):
    seen = []
    for v in asarray(a)._flat():
        if v not in seen:
            seen.append(v)
    return ndarray(sorted(seen))


def sort(a):
    return ndarray(sorted(asarray(a)._flat()))


def argsort(a):
    flat = asarray(a)._flat()
    return ndarray(sorted(range(len(flat)), key=lambda i: flat[i]))


def argmax(a):
    return asarray(a).argmax()


def argmin(a):
    return asarray(a).argmin()


def where(cond, x=None, y=None):
    c = asarray(cond)
    if x is None and y is None:
        if c.ndim != 1:
            raise ValueError('where(cond) uten verdier støtter kun 1D')
        return (ndarray([i for i, v in enumerate(c._d) if v]),)
    if (x is None) != (y is None):
        raise ValueError('where: oppgi enten bare cond, eller cond, x OG y')

    def _pick(src, i, j=None):
        if isinstance(src, ndarray):
            return src._d[i] if j is None else src._d[i][j]
        return src

    xa = asarray(x) if isinstance(x, (list, tuple, ndarray)) else x
    ya = asarray(y) if isinstance(y, (list, tuple, ndarray)) else y
    for arr in (xa, ya):
        if isinstance(arr, ndarray) and arr.shape != c.shape:
            raise ValueError('where: x/y må ha samme form som cond')
    if c.ndim == 1:
        return ndarray([_pick(xa, i) if v else _pick(ya, i)
                        for i, v in enumerate(c._d)])
    return ndarray([[_pick(xa, i, j) if v else _pick(ya, i, j)
                     for j, v in enumerate(row)]
                    for i, row in enumerate(c._d)])


def concatenate(arrays):
    out = []
    for a in arrays:
        arr = asarray(a)
        if arr.ndim != 1:
            raise ValueError('concatenate: kun 1D-arrays støttes')
        out.extend(arr._d)
    return ndarray(out)


def dot(a, b):
    A, B = asarray(a), asarray(b)
    if A.ndim == 1 and B.ndim == 1:
        if A.shape != B.shape:
            raise ValueError('dot: lengdene passer ikke')
        return _sum(x * y for x, y in zip(A._d, B._d))
    if A.ndim == 1:
        A = ndarray([A._d])                      # radvektor
        return dot(A, B)[0]
    if B.ndim == 1:
        if A.shape[1] != B.shape[0]:
            raise ValueError('dot: formene passer ikke: %r mot %r'
                             % (A.shape, B.shape))
        return ndarray([_sum(x * y for x, y in zip(row, B._d))
                        for row in A._d])
    if A.shape[1] != B.shape[0]:
        raise ValueError('dot: formene passer ikke: %r mot %r'
                         % (A.shape, B.shape))
    Bt = B.T
    return ndarray([[_sum(x * y for x, y in zip(row, col))
                     for col in Bt._d] for row in A._d])
```

Note on `dot` with 1D·2D: `dot(A, B)[0]` returns the first row of the 1×m result — correct because the wrapped row-vector product has shape (1, m) and numpy returns shape (m,).

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest brython/tests/test_numpy_brython.py brython/tests/test_numpy_brython_diff.py brython/tests/test_brython_scoping_trap.py -q`
Expected: all PASS (diff tests actually run — numpy is installed on the dev machine).

- [ ] **Step 5: Commit**

```bash
git add brython/numpy_brython.py brython/tests/test_numpy_brython.py brython/tests/test_numpy_brython_diff.py
git commit -m "feat(brython): numpy aggregations + utilities, diff-tested against numpy"
```

---

### Task 4: np.random with seed

**Files:**
- Modify: `brython/numpy_brython.py` (append)
- Test: `brython/tests/test_numpy_brython.py` (append)

**Interfaces:**
- Consumes: `ndarray`, `asarray`, `_pyrandom`.
- Produces: `random` — a `_RandomState` instance with `seed(n)`, `normal(loc, scale, size)`, `uniform(low, high, size)`, `randint(low, high=None, size=None)` (high exclusive), `rand(n=None)`, `randn(n=None)`, `choice(a, size=None, replace=True)`, `shuffle(x)`; `default_rng(seed=None) -> _Generator` with `normal/uniform/integers/choice/shuffle`. `size=None` → scalar, int → 1D ndarray, 2-tuple → 2D ndarray.

- [ ] **Step 1: Write the failing tests**

Append to `brython/tests/test_numpy_brython.py`:

```python
def test_random_seed_reproducible():
    np.random.seed(42)
    a = np.random.normal(0, 1, 5)
    np.random.seed(42)
    b = np.random.normal(0, 1, 5)
    assert a.tolist() == b.tolist()
    assert len(a) == 5

def test_random_shapes_and_scalar():
    np.random.seed(1)
    s = np.random.normal()
    assert isinstance(s, float)
    m = np.random.uniform(0, 1, (2, 3))
    assert m.shape == (2, 3)
    assert all(0.0 <= v <= 1.0 for v in m._flat())

def test_randint_range_exclusive():
    np.random.seed(2)
    vals = np.random.randint(0, 10, 200).tolist()
    assert all(0 <= v <= 9 for v in vals)
    assert 9 in vals and 0 in vals               # med 200 trekk

def test_choice_and_shuffle():
    np.random.seed(3)
    pool = [10, 20, 30, 40]
    one = np.random.choice(pool)
    assert one in pool
    tre = np.random.choice(pool, 3, replace=False)
    assert len(set(tre.tolist())) == 3
    x = [1, 2, 3, 4, 5]
    np.random.shuffle(x)
    assert sorted(x) == [1, 2, 3, 4, 5]

def test_default_rng():
    rng = np.default_rng(7)
    a = rng.normal(0, 1, 4)
    b = np.default_rng(7).normal(0, 1, 4)
    assert a.tolist() == b.tolist()
    ints = np.default_rng(7).integers(0, 5, 100).tolist()
    assert all(0 <= v <= 4 for v in ints)

def test_random_statistical_sanity():
    np.random.seed(1234)
    xs = np.random.normal(10.0, 2.0, 4000)
    assert xs.mean() == pytest.approx(10.0, abs=0.15)
    assert xs.std() == pytest.approx(2.0, abs=0.15)
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest brython/tests/test_numpy_brython.py -q`
Expected: new tests FAIL with AttributeError (`random`).

- [ ] **Step 3: Implement**

Append to `brython/numpy_brython.py`:

```python
# ── np.random ───────────────────────────────────────────────────────────────
# Samme seed -> samme tall på tvers av kjøringer og CPython/Brython, men
# IKKE de samme tallene som ekte numpy (Mersenne-strømmene brukes ulikt).

class _Generator:
    """default_rng-stil generator."""

    def __init__(self, seed=None):
        self._rng = _pyrandom.Random(seed)

    def _sized(self, size, gen):
        if size is None:
            return gen()
        if isinstance(size, tuple):
            r, c = size
            return ndarray([[gen() for _ in range(c)] for _ in range(r)])
        return ndarray([gen() for _ in range(size)])

    def normal(self, loc=0.0, scale=1.0, size=None):
        return self._sized(size, lambda: self._rng.gauss(loc, scale))

    def uniform(self, low=0.0, high=1.0, size=None):
        return self._sized(size, lambda: self._rng.uniform(low, high))

    def integers(self, low, high=None, size=None):
        if high is None:
            low, high = 0, low
        return self._sized(size, lambda: self._rng.randrange(low, high))

    def choice(self, a, size=None, replace=True):
        pool = (list(range(a)) if isinstance(a, int)
                else asarray(a)._flat())
        if size is None:
            return self._rng.choice(pool)
        if not replace:
            return ndarray(self._rng.sample(pool, size))
        return ndarray([self._rng.choice(pool) for _ in range(size)])

    def shuffle(self, x):
        if isinstance(x, ndarray):
            self._rng.shuffle(x._d)
        else:
            self._rng.shuffle(x)


class _RandomState(_Generator):
    """np.random.* (legacy-API: seed/randint/rand/randn)."""

    def seed(self, n=None):
        self._rng = _pyrandom.Random(n)

    def randint(self, low, high=None, size=None):
        return self.integers(low, high, size)

    def rand(self, n=None):
        return self.uniform(0.0, 1.0, n)

    def randn(self, n=None):
        return self.normal(0.0, 1.0, n)


random = _RandomState()


def default_rng(seed=None):
    return _Generator(seed)
```

- [ ] **Step 4: Run tests + guards**

Run: `python3 -m pytest brython/tests/test_numpy_brython.py brython/tests/test_brython_scoping_trap.py -q`
Expected: all PASS. (The module-level name `random` shadows the stdlib module inside this file — internal code only uses `_pyrandom`, bound before the shadowing definition; verify no bare `random.` references besides the instance itself.)

- [ ] **Step 5: Commit**

```bash
git add brython/numpy_brython.py brython/tests/test_numpy_brython.py
git commit -m "feat(brython): np.random with seeded reproducibility + default_rng"
```

---

### Task 5: Registry, ecosystem integration tests, example

**Files:**
- Modify: `js/brython-engine.js` (LIB_REGISTRY)
- Create: `examples/bry16_numpy.txt`
- Modify: `index.html` (after the bry15 button)
- Test: `brython/tests/test_engine_scan.py` (append) and `brython/tests/test_numpy_brython.py` (append integration tests)

**Interfaces:**
- Produces: registry entry `numpy_brython: { aliases: ['numpy'], deps: [], js: [] }`.

- [ ] **Step 1: Write the failing scan test**

Append to `brython/tests/test_engine_scan.py`:

```python
def test_numpy_alias_resolves_to_canonical():
    assert scan('import numpy as np') == ['numpy_brython']
    assert scan('from numpy import array, mean') == ['numpy_brython']
    assert scan('import numpy_brython as np') == ['numpy_brython']
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest brython/tests/test_engine_scan.py -q`
Expected: new test FAILS.

- [ ] **Step 3: Add registry entry + integration tests**

In `js/brython-engine.js`, extend `LIB_REGISTRY` after the statsmodels entry:

```js
    numpy_brython:          { aliases: ['numpy'], deps: [], js: [] }
```

Append to `brython/tests/test_numpy_brython.py` (integration with the other shims — ndarrays flow through their `.tolist()` duck-typing):

```python
def test_integration_matplotlib_scipy_statsmodels():
    import matplotlib_brython as plt
    import scipy_stats_brython as st
    import statsmodels_brython as smb
    np.random.seed(11)
    x = np.linspace(0.0, 10.0, 20)
    y = x * 2.0 + 1.0 + np.random.normal(0.0, 0.1, 20)
    # matplotlib: ndarray rett inn i plot
    plt.figure()
    plt.plot(x, y)
    trace = plt.gcf().data[0]
    assert trace['x'] == pytest.approx(x.tolist())
    # scipy: ndarray rett inn i ttest
    res = st.ttest_ind(np.array([1.0, 2.0, 3.0, 4.0]),
                       np.array([1.1, 2.1, 2.9, 4.2]))
    assert res.pvalue > 0.5
    # statsmodels: dict med ndarray-kolonner
    ols = smb.ols('y ~ x', {'y': y, 'x': x}).fit()
    assert ols.params['x'] == pytest.approx(2.0, abs=0.05)
    assert ols.rsquared > 0.99
```

- [ ] **Step 4: Verify**

Run: `node --check js/brython-engine.js && python3 -m pytest brython/tests/ -q`
Expected: OK / all PASS.

- [ ] **Step 5: Create the example**

Create `examples/bry16_numpy.txt`:

```
# Example: numpy i Brython-modus — arrays, statistikk og tilfeldige tall
# Ren-Python-subsett; samme seed gir samme tall hver gang.
import numpy as np
import matplotlib.pyplot as plt

np.random.seed(42)

# Simulert utvalg: inntekt ~ normalfordelt
inntekt = np.random.normal(550.0, 80.0, 200)
print("Gjennomsnitt:", round(inntekt.mean(), 1))
print("Standardavvik:", round(inntekt.std(), 1))
print("Median:", round(np.median(inntekt), 1))
print("90. persentil:", round(np.percentile(inntekt, 90), 1))

# Boolsk maskering: hvor mange over 600?
hoy = inntekt[inntekt > 600.0]
print("Andel over 600:", round(len(hoy) / len(inntekt), 3))

plt.hist(inntekt, bins=20, color="steelblue")
plt.title("Simulert inntektsfordeling (n=200)")
plt.xlabel("Inntekt (1000 kr)")
plt.show()

# linspace + elementvis regning = glatte kurver
x = np.linspace(0.0, 4.0, 60)
y = np.exp(-x) * 100.0
plt.plot(x, y, "b-")
plt.title("Eksponentiell avtakning")
plt.show()
```

- [ ] **Step 6: Add the example button**

In `index.html`, directly after the bry15 button, insert:

```html
              <button type="button" data-example="bry16_numpy.txt" data-mode="brython" data-i18n>numpy &mdash; arrays og tilfeldige tall</button>
```

- [ ] **Step 7: Full suite + commit**

Run: `python3 -m pytest brython/tests/ -q && node --check js/brython-engine.js`
Expected: all PASS.

```bash
git add js/brython-engine.js examples/bry16_numpy.txt index.html brython/tests/test_engine_scan.py brython/tests/test_numpy_brython.py
git commit -m "feat(brython): register numpy_brython with numpy alias + integration tests + example"
```

---

### Task 6: Browser verification

**Files:** none. CPython-blind risks: dunder-operator dispatch in Brython (`__radd__`, `__matmul__`, `__eq__`-elementwise, `__hash__ = None`), bool-vs-int isinstance ordering in mask indexing, `random.Random(seed)` reproducibility across CPython/Brython, and the bry16 example end-to-end.

- [ ] **Step 1: Serve** — `python3 -m http.server 8765 --directory /Users/hom/Documents/GitHub/microdata` (unregister the service worker in the page first — known stale-precache trap).

- [ ] **Step 2: Engine checks via BrythonEngine.run(...)**
1. `import numpy as np\na = np.array([1.0,2.0,3.0])\nprint((1 + a).tolist(), (a > 1.5).tolist(), a[a > 1.5].tolist())` → `[2.0, 3.0, 4.0] [False, True, True] [2.0, 3.0]`.
2. Seed determinism vs CPython: run `np.random.seed(42); print(np.random.normal(0, 1, 3).tolist())` in the browser AND `python3 -c "..."` locally with numpy_brython — the three numbers must be IDENTICAL (same Mersenne implementation contract).
3. `print(np.percentile([1.0,2.0,3.0,4.0], 25), np.dot([[1,2],[3,4]], [5,6]).tolist())` → `1.75 [17, 39]`.
4. The bry16 example verbatim → two figures, printed stats, no error.

- [ ] **Step 3: Record results; fix + commit anything found.**

---

### Task 7: Port to safestat and openstat + merge + push

**Files:**
- Copy to `../safestat` then `../openstat`: `js/brython-engine.js`, `brython/numpy_brython.py`, `brython/tests/test_numpy_brython.py`, `brython/tests/test_numpy_brython_diff.py`, `brython/tests/test_engine_scan.py`, `examples/bry16_numpy.txt`
- Insert the bry16 button after each sibling's bry15 button in index.html

- [ ] **Step 1: Copy files (safestat first) + insert buttons; NB safestat branch check**

```bash
cd /Users/hom/Documents/GitHub
git -C safestat branch --show-current   # hvis dash-v2: commit brython-filer til master via midlertidig worktree
for sib in safestat openstat; do
  cp microdata/js/brython-engine.js           $sib/js/brython-engine.js
  cp microdata/brython/numpy_brython.py       $sib/brython/
  cp microdata/brython/tests/test_numpy_brython.py      $sib/brython/tests/
  cp microdata/brython/tests/test_numpy_brython_diff.py $sib/brython/tests/
  cp microdata/brython/tests/test_engine_scan.py $sib/brython/tests/
  cp microdata/examples/bry16_numpy.txt       $sib/examples/
done
```

- [ ] **Step 2: Run each sibling's suite** — expected all PASS in both.

- [ ] **Step 3: sync_check + commit each repo** (message: "feat(brython): numpy subset (ported from microdata)").

- [ ] **Step 4: Safestat browser smoke** (serve on 8766; run check 1 from Task 6).

- [ ] **Step 5: Merge microdata branch to main (tests green on result), delete branch, push all three repos.**
