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
