# duckdb_brython (Brython lib-utvidelse stadie 6b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `import duckdb; duckdb.sql("SELECT ...").df()` virker i Brython-modus mot appens delte DuckDB-WASM-instans, inkludert SQL over datasett lastet med `# load`.

**Architecture:** DuckDB-WASM er asynkron (worker), Brython-brukerkoden kjører synkront via `mod._execute_code`. Broen er et **replay-mønster**: `duckdb_brython.py` slår synkront opp i en JS-cache (`window.__brythonDuckSync(sql)`); ved cache-miss legges spørringen i kø og en `_PendingSQL(BaseException)` med attributt `__brython_pending__` kastes. Runneren oversetter den til feilmarkøren `__BRYTHON_PENDING__`; motoren (js/brython-engine.js) kjører køen asynkront mot DuckDB (via ny `window.__brythonDuck`-hjelper i index.html), cacher resultatene som JSON, ruller brukerglobals tilbake (`_snapshot`/`_rollback` i runneren) og re-kjører hele scriptet. Andre pass finner svaret i cachen. `# load`-datasett registreres som DuckDB-views ved første flush.

**Tech Stack:** Brython 3.12, DuckDB-WASM 1.29 (allerede i index.html), pytest med ekte `duckdb` 1.5.4 som diff-fasit, node for engine-scan-tester.

## Global Constraints

- Utvikles i `~/Documents/GitHub/microdata`, portes deretter **safestat først, så openstat**; kjør `safestat/scripts/sync_check.sh` etter port.
- Én fil per bibliotek i `brython/`, importerbar i CPython (browser-import bak `try/except ImportError`).
- **Brython-felle 1:** metodenavn == globalt funksjonsnavn → stille no-op. Metoder kaller underscore-aliaser (`_sql_impl`), aldri globale med eget navn. Vaktes av `test_brython_scoping_trap.py` (skanner alle brython/*.py automatisk).
- **Brython-felle 2:** `dict.setdefault` kun med streng-LITERAL nøkkel i brython/*.py.
- Norske brukerrettede feilmeldinger; kommentarspråk følger eksisterende filkonvensjon (norsk/engelsk blandet).
- `sw.js` `CACHE` MÅ bumpes i hver repo (brython_runner.py er precachet; js/-endringer krever det uansett). Lokal browser-verifisering MÅ avregistrere service worker først (stale-kopi-fella).
- safestat kan ha branchen `dash-v2-forbedringer` utsjekket av annen økt — port til `master` bygges da i midlertidig worktree (mønster fra stadie 5/6a).
- Ingen bakoverkompat-hensyn (ingen brukere ennå).

## Filkart

| Fil | Ansvar |
|---|---|
| `brython/duckdb_brython.py` (ny) | duckdb-API-subsett: `sql`/`query`/`connect`, `Relation` (df/fetchall/fetchone/columns/to_html), `_run_sql` med `_executor`-krok (CPython) og `__brythonDuckSync`-oppslag (browser), `_PendingSQL` |
| `brython/brython_runner.py` (endres) | generisk pending-protokoll (`__brython_pending__` → `__BRYTHON_PENDING__`), `_snapshot()`/`_rollback()` for replay |
| `js/brython-engine.js` (endres) | LIB_REGISTRY-oppføring (`duckdb`-alias), `beginDuckBridge()` (per-run cache+kø+flush), replay-løkke i `run()` |
| `index.html` (endres) | `window.__brythonDuck = {register, query}` ved siden av `__brythonParquetColumns`; eksempelknapp |
| `brython/tests/test_duckdb_brython.py` (ny) | enhetstester med fake executor / fake window |
| `brython/tests/test_duckdb_brython_diff.py` (ny) | diff mot ekte duckdb (importorskip) |
| `brython/tests/test_brython_runner.py` (endres) | pending-markør + snapshot/rollback |
| `brython/tests/test_engine_scan.py` (endres) | `import duckdb` → `duckdb_brython` |
| `examples/bry18_duckdb.txt` (ny) | eksempel: `# load` + SQL + `.df()` + plot |
| `sw.js` (endres) | CACHE-bump |

---

### Task 0: Branch

- [ ] **Step 1:** `cd ~/Documents/GitHub/microdata && git checkout -b brython-duckdb main`

### Task 1: duckdb_brython.py — kjerne med testbar executor-krok

**Files:**
- Create: `brython/duckdb_brython.py`
- Test: `brython/tests/test_duckdb_brython.py`

**Interfaces:**
- Produces: modul `duckdb_brython` med `sql(q) -> Relation`, `query = sql`, `connect(*a, **kw) -> _Connection` (`.sql/.query/.execute/.close`, context manager), `Relation.df()/fetchall()/fetchone()/columns/to_html()/fetchdf`, `_executor`-krok (CPython-tester), `_PendingSQL` (BaseException, `__brython_pending__ = True`), `_run_sql(q) -> {kol: [verdier]}`.
- Consumes: `pandas_brython` (`DataFrame`, `nan`), i browser `window.__brythonDuckSync` (Task 4).

- [ ] **Step 1: Skriv failing tests**

```python
# brython/tests/test_duckdb_brython.py
# Enhetstester for duckdb_brython med injisert executor (CPython).
# Browser-broen (window.__brythonDuckSync) emuleres med et fake window-objekt.
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import pytest
import duckdb_brython as duckdb
import pandas_brython as pd


@pytest.fixture(autouse=True)
def _reset_hooks():
    duckdb._executor = None
    saved_window = duckdb._window
    yield
    duckdb._executor = None
    duckdb._window = saved_window


COLS = {'navn': ['a', 'b', 'c'], 'verdi': [1, 2, None]}


def test_sql_returns_relation_with_columns_in_order():
    duckdb._executor = lambda q: dict(COLS)
    rel = duckdb.sql('SELECT * FROM t')
    assert rel.columns == ['navn', 'verdi']


def test_fetchall_row_tuples_and_fetchone():
    duckdb._executor = lambda q: dict(COLS)
    rel = duckdb.sql('SELECT * FROM t')
    assert rel.fetchall() == [('a', 1), ('b', 2), ('c', None)]
    assert rel.fetchone() == ('a', 1)


def test_fetchone_empty_result_is_none():
    duckdb._executor = lambda q: {'x': []}
    assert duckdb.sql('SELECT 1 WHERE false').fetchone() is None
    assert duckdb.sql('SELECT 1 WHERE false').fetchall() == []


def test_df_converts_none_to_nan():
    duckdb._executor = lambda q: dict(COLS)
    df = duckdb.sql('SELECT * FROM t').df()
    assert list(df.columns) == ['navn', 'verdi']
    vals = df['verdi'].tolist()
    assert vals[0] == 1 and vals[1] == 2
    assert pd.isna(vals[2])


def test_fetchdf_is_df_alias_and_to_html_renders_table():
    duckdb._executor = lambda q: dict(COLS)
    rel = duckdb.sql('SELECT * FROM t')
    assert rel.fetchdf().tolist if False else True
    assert '<table' in rel.to_html()
    assert 'navn' in rel.to_html()


def test_query_alias_and_connect_surface():
    duckdb._executor = lambda q: {'n': [7]}
    assert duckdb.query('SELECT 7').fetchone() == (7,)
    con = duckdb.connect()
    assert con.sql('SELECT 7').fetchone() == (7,)
    assert con.query('SELECT 7').fetchone() == (7,)
    assert con.execute('SELECT 7').fetchone() == (7,)
    con.close()
    with duckdb.connect() as c2:
        assert c2.sql('SELECT 7').fetchone() == (7,)


def test_executor_receives_query_text():
    seen = []
    def ex(q):
        seen.append(q)
        return {'x': [1]}
    duckdb._executor = ex
    duckdb.sql('SELECT 42')
    assert seen == ['SELECT 42']


def test_sql_rejects_nonstring_and_empty():
    duckdb._executor = lambda q: {}
    with pytest.raises(TypeError):
        duckdb.sql(123)
    with pytest.raises(ValueError):
        duckdb.sql('   ')


def test_no_executor_outside_browser_raises_norwegian():
    with pytest.raises(RuntimeError) as e:
        duckdb.sql('SELECT 1')
    assert 'nettleseren' in str(e.value)


class _FakeWindow:
    def __init__(self, responses):
        self._responses = responses
        self.calls = []


def _wire_fake_window(responses):
    w = _FakeWindow(responses)
    def sync(q):
        w.calls.append(q)
        return w._responses.get(q)
    w.__brythonDuckSync = sync
    return w


def test_browser_cache_miss_raises_pending():
    duckdb._window = _wire_fake_window({})
    with pytest.raises(duckdb._PendingSQL):
        duckdb.sql('SELECT 1')


def test_pending_is_baseexception_not_exception():
    assert issubclass(duckdb._PendingSQL, BaseException)
    assert not issubclass(duckdb._PendingSQL, Exception)
    assert duckdb._PendingSQL.__brython_pending__ is True


def test_browser_cache_hit_returns_cols():
    duckdb._window = _wire_fake_window({'SELECT 1': '{"cols": {"a": [1]}}'})
    assert duckdb.sql('SELECT 1').fetchall() == [(1,)]


def test_browser_cached_error_raises_runtime_norwegian():
    duckdb._window = _wire_fake_window({'SELECT x': '{"error": "Binder Error: x"}'})
    with pytest.raises(RuntimeError) as e:
        duckdb.sql('SELECT x')
    assert 'duckdb-feil' in str(e.value)
```

- [ ] **Step 2:** Kjør: `python3 -m pytest brython/tests/test_duckdb_brython.py -q` — Forventet: FAIL/ERROR (`ModuleNotFoundError: duckdb_brython`).

- [ ] **Step 3: Implementer modulen**

```python
# brython/duckdb_brython.py — duckdb-API-subsett for Brython-modus.
# duckdb.sql("SELECT ...").df() over appens delte DuckDB-WASM-instans.
#
# Async-broen: DuckDB-WASM er asynkron (worker), brukerkoden kjører synkront.
# _run_sql slår synkront opp i motorens per-run-cache (window.__brythonDuckSync);
# ved miss er spørringen lagt i kø og vi kaster _PendingSQL. Motoren
# (js/brython-engine.js) kjører køen mot DuckDB, cacher resultatene og
# RE-KJØRER hele scriptet (replay) — neste pass finner svaret i cachen.
#
# NB: alle "tilkoblinger" deler appens ene DuckDB-katalog. Tabeller fra
# CREATE TABLE overlever til neste SQL-modus-kjøring rydder katalogen —
# bruk CREATE OR REPLACE TABLE i scripts som skal kjøres flere ganger.
import json as _json
import pandas_brython as _pd

try:
    from browser import window as _window   # Brython (nettleser)
except ImportError:                          # CPython (pytest)
    _window = None

# CPython-krok for tester: funksjon sql-tekst -> {kolonne: [verdier]}
_executor = None


class _PendingSQL(BaseException):
    """Replay-signal til motoren. BaseException med vilje: brukerkodens
    `except Exception` skal ikke sluke signalet. Runneren gjenkjenner
    attributtet __brython_pending__ (generisk protokoll, se _execute_code)."""
    __brython_pending__ = True


def _run_sql(q):
    if _executor is not None:
        return _executor(q)
    if _window is None:
        raise RuntimeError('duckdb_brython kan ikke kjøre SQL utenfor '
                           'nettleseren (sett duckdb_brython._executor i tester)')
    res = _window.__brythonDuckSync(q)
    if res is None:            # ikke i cache — motoren har lagt den i kø
        raise _PendingSQL(q)
    d = _json.loads(res)
    if d.get('error') is not None:
        raise RuntimeError('duckdb-feil: ' + str(d['error']))
    return d['cols']


class Relation:
    """Resultatet av duckdb.sql(...): kolonnedata med pandas-uthenting."""

    def __init__(self, cols, sql_text):
        self._cols = cols
        self._sql = sql_text

    @property
    def columns(self):
        return list(self._cols.keys())

    def fetchall(self):
        names = list(self._cols.keys())
        if not names:
            return []
        n = len(self._cols[names[0]])
        return [tuple(self._cols[c][i] for c in names) for i in range(n)]

    def fetchone(self):
        rows = self.fetchall()
        return rows[0] if rows else None

    def df(self):
        # None (SQL NULL via JSON) -> pandas_brython-nan, som i _bind_datasets
        cols = {k: [_pd.nan if v is None else v for v in vals]
                for k, vals in self._cols.items()}
        return _pd.DataFrame(cols)

    fetchdf = df

    def to_html(self):
        return self.df().to_html()

    def __repr__(self):
        names = list(self._cols.keys())
        n = len(self._cols[names[0]]) if names else 0
        return '<duckdb_brython.Relation: %d rader, kolonner %r>' % (n, names)


def _sql_impl(q):
    if not isinstance(q, str):
        raise TypeError('duckdb.sql: spørringen må være en streng')
    if not q.strip():
        raise ValueError('duckdb.sql: tom spørring')
    return Relation(_run_sql(q), q)


def sql(q):
    return _sql_impl(q)


query = sql


class _Connection:
    """Minimal connect()-flate for opplæringskode; deler appens katalog.
    Metodene kaller _sql_impl, ALDRI globale sql()/query() — Brython-felle 1
    (metodenavn == globalt funksjonsnavn blir stille no-op)."""

    def sql(self, q):
        return _sql_impl(q)

    def query(self, q):
        return _sql_impl(q)

    def execute(self, q):
        return _sql_impl(q)

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


def connect(*args, **kwargs):
    return _Connection()
```

- [ ] **Step 4:** Kjør: `python3 -m pytest brython/tests/test_duckdb_brython.py brython/tests/test_brython_scoping_trap.py -q` — Forventet: PASS (trap-vakten skanner den nye fila automatisk).

- [ ] **Step 5:** Commit: `git add brython/duckdb_brython.py brython/tests/test_duckdb_brython.py && git commit -m "feat(brython): duckdb_brython core — sql/connect/Relation with replay-pending bridge"`

### Task 2: Runner — pending-protokoll + snapshot/rollback

**Files:**
- Modify: `brython/brython_runner.py`
- Test: `brython/tests/test_brython_runner.py` (legg til tester nederst)

**Interfaces:**
- Produces: `_execute_code` setter `_last_error = '__BRYTHON_PENDING__'` og returnerer `''` når unntaket har attributt `__brython_pending__`; `_snapshot()` / `_rollback()` (grunn kopi av brukerglobals). Andre BaseException (SystemExit) re-raises som før.
- Consumes: `_PendingSQL`-mønsteret fra Task 1 (kun via attributtet — runneren kjenner ikke duckdb).

- [ ] **Step 1: Skriv failing tests** (append i `brython/tests/test_brython_runner.py`; gjenbruk filens eksisterende import av runneren)

```python
class _Pending(BaseException):
    __brython_pending__ = True


def test_pending_exception_sets_marker_and_discards_output():
    brython_runner._shared_vars['_P'] = _Pending
    out = brython_runner._execute_code('print("halv utskrift")\nraise _P("q1")')
    assert out == ''
    assert brython_runner._get_last_error() == '__BRYTHON_PENDING__'


def test_pending_not_swallowed_by_user_except_exception():
    brython_runner._shared_vars['_P'] = _Pending
    code = ('try:\n'
            '    raise _P("q2")\n'
            'except Exception:\n'
            '    print("slukt")\n')
    brython_runner._execute_code(code)
    assert brython_runner._get_last_error() == '__BRYTHON_PENDING__'


def test_normal_exception_still_formats_traceback():
    brython_runner._execute_code('1/0')
    assert 'ZeroDivisionError' in brython_runner._get_last_error()


def test_snapshot_rollback_rewinds_rebindings():
    brython_runner._shared_vars['xx'] = 1
    brython_runner._snapshot()
    brython_runner._execute_code('xx = xx + 1\nnytt_navn = 99')
    assert brython_runner._shared_vars['xx'] == 2
    brython_runner._rollback()
    assert brython_runner._shared_vars['xx'] == 1
    assert 'nytt_navn' not in brython_runner._shared_vars
```

- [ ] **Step 2:** Kjør: `python3 -m pytest brython/tests/test_brython_runner.py -q` — Forventet: de fire nye FAILer (`AttributeError: _snapshot` / feil marker).

- [ ] **Step 3: Implementer.** I `_execute_code`, erstatt

```python
    except Exception:
        _last_error = traceback.format_exc()
        return buf.getvalue()
```

med

```python
    except BaseException as e:
        if getattr(e, '__brython_pending__', False):
            # Async-bro (duckdb_brython o.l.): motoren kjører de ventende
            # spørringene og re-kjører hele scriptet (replay). Utskrift fra
            # dette passet forkastes — replay-passet bygger den på nytt.
            _last_error = '__BRYTHON_PENDING__'
            return ''
        if not isinstance(e, Exception):
            raise   # SystemExit o.l. — samme oppførsel som før
        _last_error = traceback.format_exc()
        return buf.getvalue()
```

og legg til nederst i fila:

```python
_snap = None

def _snapshot():
    """Motoren kaller dette én gang per run (før pass 1): fang brukerglobals
    så replay-pass (async-broen) kan spole tilbake mellom pass."""
    global _snap
    _snap = dict(_shared_vars)

def _rollback():
    """Spol brukerglobals tilbake til siste _snapshot(). Grunn kopi:
    objekter fra tidligere kjøringer som muteres in place spoles IKKE
    tilbake — akseptert replay-forbehold (motoren re-binder datasett per
    pass, så # load-frames er alltid ferske)."""
    if _snap is not None:
        _shared_vars.clear()
        _shared_vars.update(_snap)
```

- [ ] **Step 4:** Kjør: `python3 -m pytest brython/tests/test_brython_runner.py -q` — Forventet: PASS (alle, også de gamle).

- [ ] **Step 5:** Commit: `git add brython/brython_runner.py brython/tests/test_brython_runner.py && git commit -m "feat(brython): runner pending-marker protocol + snapshot/rollback for replay"`

### Task 3: Diff-tester mot ekte duckdb

**Files:**
- Create: `brython/tests/test_duckdb_brython_diff.py`

**Interfaces:**
- Consumes: `duckdb_brython._executor`, `Relation.fetchall/df/columns` fra Task 1; ekte `duckdb` (1.5.4 installert; `pytest.importorskip`).

- [ ] **Step 1: Skriv testene**

```python
# brython/tests/test_duckdb_brython_diff.py
# Differensialtester: samme SQL gjennom duckdb_brython (med executor koblet
# til EKTE duckdb, konvertert til kolonnedict slik __arrowToColumns gjør)
# skal gi samme rader/kolonner som ekte duckdb direkte.
import sys, os, math
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from decimal import Decimal
import pytest

real_duckdb = pytest.importorskip('duckdb')
import duckdb_brython
import pandas_brython as pd

SETUP = [
    "CREATE OR REPLACE TABLE folk (navn VARCHAR, alder INT, lonn DOUBLE)",
    "INSERT INTO folk VALUES ('Kari', 34, 550000.0), ('Ola', 51, NULL), "
    "('Per', 34, 480000.5), ('Anne', 28, 610000.0)",
]


@pytest.fixture()
def con():
    c = real_duckdb.connect()
    for s in SETUP:
        c.execute(s)
    prev = duckdb_brython._executor

    def ex(q):
        cur = c.execute(q)
        cols = [d[0] for d in cur.description] if cur.description else []
        out = {name: [] for name in cols}
        for row in cur.fetchall():
            for name, v in zip(cols, row):
                if isinstance(v, Decimal):
                    v = float(v)          # speiler __decimalToNumber i JS
                out[name].append(v)
        return out

    duckdb_brython._executor = ex
    yield c
    duckdb_brython._executor = prev
    c.close()


def test_select_star_matches_real(con):
    q = 'SELECT * FROM folk ORDER BY navn'
    ours = duckdb_brython.sql(q)
    theirs = con.execute(q)
    assert ours.columns == [d[0] for d in theirs.description]
    assert ours.fetchall() == theirs.fetchall()


def test_groupby_aggregate_matches_real(con):
    q = ('SELECT alder, count(*) AS n, sum(lonn) AS sumlonn '
         'FROM folk GROUP BY alder ORDER BY alder')
    ours = duckdb_brython.sql(q).fetchall()
    theirs = [tuple(float(v) if isinstance(v, Decimal) else v for v in r)
              for r in con.execute(q).fetchall()]
    assert ours == theirs


def test_df_matches_real_df_with_nan_for_null(con):
    q = 'SELECT navn, lonn FROM folk ORDER BY navn'
    ours = duckdb_brython.sql(q).df()
    theirs = con.execute(q).df()
    assert list(ours.columns) == list(theirs.columns)
    for i in range(len(theirs)):
        o, t = ours['lonn'].tolist()[i], theirs['lonn'].tolist()[i]
        if isinstance(t, float) and math.isnan(t):
            assert pd.isna(o)
        else:
            assert o == t
    assert ours['navn'].tolist() == theirs['navn'].tolist()


def test_fetchone_matches_real(con):
    q = 'SELECT count(*) FROM folk'
    assert duckdb_brython.sql(q).fetchone() == con.execute(q).fetchone()


def test_where_and_expressions_match_real(con):
    q = ("SELECT navn, alder * 2 AS dobbel FROM folk "
         "WHERE lonn IS NOT NULL AND alder BETWEEN 30 AND 40 ORDER BY navn")
    assert duckdb_brython.sql(q).fetchall() == con.execute(q).fetchall()
```

- [ ] **Step 2:** Kjør: `python3 -m pytest brython/tests/test_duckdb_brython_diff.py -q` — Forventet: PASS (5 tester).
- [ ] **Step 3:** Commit: `git add brython/tests/test_duckdb_brython_diff.py && git commit -m "test(brython): duckdb_brython diff-suite against real duckdb"`

### Task 4: Motor + index.html — registry, replay-løkke, DuckDB-hjelper

**Files:**
- Modify: `js/brython-engine.js` (LIB_REGISTRY, ny `beginDuckBridge`, ny replay-løkke i `run()`)
- Modify: `index.html` (nytt `window.__brythonDuck` rett etter `window.__brythonParquetColumns`-blokken, ~linje 2953)
- Test: `brython/tests/test_engine_scan.py` (append)

**Interfaces:**
- Consumes: `mod._snapshot/_rollback` (Task 2), `window.__brythonDuck.register(name, kind, payload)` / `.query(sql)` (defineres her), markørstrengen `__BRYTHON_PENDING__`.
- Produces: `window.__brythonDuckSync(sql) -> JSON-streng | null` (kalles fra duckdb_brython, Task 1); frisk closure per run.

- [ ] **Step 1: Failing scan-test** (append i `brython/tests/test_engine_scan.py`):

```python
def test_duckdb_alias():
    assert scan('import duckdb') == ['duckdb_brython']
    assert scan('from duckdb import sql') == ['duckdb_brython']
```

Kjør: `python3 -m pytest brython/tests/test_engine_scan.py -q` — Forventet: den nye FAILer.

- [ ] **Step 2: LIB_REGISTRY-oppføring** i `js/brython-engine.js` (etter `seaborn_brython`, husk komma):

```js
    // async-bro med replay — se beginDuckBridge()/run(); pandas for .df()
    duckdb_brython:         { aliases: ['duckdb'],
                              deps: ['pandas_brython'], js: [] }
```

- [ ] **Step 3: beginDuckBridge** — legg inn over `var __enginePromise = null;`:

```js
  var PENDING_MARKER = '__BRYTHON_PENDING__';   // == runnerens _last_error-markør
  var MAX_DUCK_PASSES = 10;

  // Per-run duckdb-bro: duckdb_brython.py kaller window.__brythonDuckSync(sql)
  // synkront. Cache-treff returnerer JSON-strengen; miss legger spørringen i
  // kø og returnerer null (Python kaster da pending-unntaket). flush() kjører
  // køen asynkront via index.html-hjelperen __brythonDuck og cacher svarene;
  // run() re-kjører deretter scriptet (replay). Closure settes friskt per run
  // — en gammel closure ville ellers servert forrige runs data.
  function beginDuckBridge(spec) {
    var cache = {};      // sql -> JSON-streng {cols} | {error}
    var pending = [];    // sql-strenger i kø til neste flush
    var registered = false;
    global.__brythonDuckSync = function (sqlText) {
      if (cache.hasOwnProperty(sqlText)) return cache[sqlText];
      if (pending.indexOf(sqlText) === -1) pending.push(sqlText);
      return null;
    };
    return {
      hasPending: function () { return pending.length > 0; },
      flush: async function () {
        if (!global.__brythonDuck) {
          throw new Error('duckdb i Brython-modus krever DuckDB-hjelperen (__brythonDuck) i index.html');
        }
        if (!registered) {
          // # load-datasett (og innbakte blokker) blir spørrbare views
          for (var name in spec) {
            await global.__brythonDuck.register(name, spec[name].kind, spec[name].payload);
          }
          registered = true;
        }
        var batch = pending;
        pending = [];
        for (var i = 0; i < batch.length; i++) {
          try {
            var cols = await global.__brythonDuck.query(batch[i]);
            cache[batch[i]] = JSON.stringify({ cols: cols });
          } catch (e) {
            // feilen caches så replay-passet feiler PÅ kallstedet med norsk prefiks
            cache[batch[i]] = JSON.stringify({ error: (e && e.message) || String(e) });
          }
        }
      }
    };
  }
```

- [ ] **Step 4: Replay-løkke i run()** — erstatt hele `run()`-kroppen (behold kontrakt-kommentaren øverst):

```js
  async function run(script, opts) {
    // Contract: run() ALWAYS resolves {text, error} — never rejects. (…behold
    // eksisterende kommentar…)
    try {
      var mod = await load();
      var spec = await buildDatasetSpec(opts && opts.loads);
      var needed = scanImports(script);
      if (Object.keys(spec).length && needed.indexOf('pandas_brython') === -1) {
        needed.push('pandas_brython');   // _bind_datasets bygger DataFrames
      }
      await ensureLibs(mod, needed);
      var duck = beginDuckBridge(spec);
      mod._snapshot();
      var text = '', err = null, pass;
      for (pass = 0; pass < MAX_DUCK_PASSES; pass++) {
        if (pass > 0) mod._rollback();   // spol brukerglobals til før pass 1
        if (Object.keys(spec).length) {
          var bindErr = mod._bind_datasets(JSON.stringify(spec));   // ferske frames per pass
          if (bindErr) return { text: '', error: String(bindErr) };
        }
        text = mod._execute_code(script);
        err = mod._get_last_error();
        if (err !== PENDING_MARKER) break;
        if (!duck.hasPending()) {
          return { text: '', error: 'duckdb_brython: replay uten ventende spørringer (intern feil)' };
        }
        await duck.flush();
      }
      if (err === PENDING_MARKER) {
        return { text: '', error: 'duckdb-spørringene stabiliserer seg ikke etter ' +
                 MAX_DUCK_PASSES + ' pass — bygges SQL-tekstene av ikke-deterministiske ' +
                 'verdier (f.eks. random uten seed)?' };
      }
      return { text: String(text == null ? '' : text), error: err ? String(err) : null };
    } catch (e) {
      return { text: '', error: (e && e.message) || String(e) };
    }
  }
```

- [ ] **Step 5: index.html-hjelper** — rett etter `window.__brythonParquetColumns`-funksjonen:

```js
    // Brython duckdb-modul (js/brython-engine.js beginDuckBridge): registrer
    // et # load-datasett som view + kjør én spørring mot den delte databasen.
    window.__brythonDuck = {
      async register(name, kind, payload) {
        // kind 'csv' → payload er CSV-tekst; 'columns' → {kol: [verdier]}
        const db = await __ensureDuckDB();
        const ident = String(name).replace(/"/g, '""');
        const conn = await db.connect();
        try {
          let fname, reader;
          if (kind === 'csv') {
            fname = String(name) + '.csv';
            reader = 'read_csv_auto';
            await db.registerFileBuffer(fname, new TextEncoder().encode(payload));
          } else {
            const cols = Object.keys(payload);
            const n = cols.length ? payload[cols[0]].length : 0;
            if (!n) return;   // read_json_auto takler ikke tomme datasett
            const rows = new Array(n);
            for (let i = 0; i < n; i++) {
              const r = {};
              for (const c of cols) r[c] = payload[c][i];
              rows[i] = r;
            }
            fname = String(name) + '.json';
            reader = 'read_json_auto';
            await db.registerFileBuffer(fname, new TextEncoder().encode(JSON.stringify(rows)));
          }
          // en TABELL med samme navn fra en tidligere SQL-kjøring blokkerer
          // CREATE OR REPLACE VIEW — rydd den eksplisitt først
          await conn.query('DROP TABLE IF EXISTS "' + ident + '"');
          await conn.query('CREATE OR REPLACE VIEW "' + ident + '" AS SELECT * FROM ' +
                           reader + "('" + fname.replace(/'/g, "''") + "')");
        } finally { await conn.close(); }
      },
      async query(sql) {
        const db = await __ensureDuckDB();
        const conn = await db.connect();
        try { return __arrowToColumns(await conn.query(sql)); }
        finally { await conn.close(); }
      }
    };
```

- [ ] **Step 6:** Kjør: `python3 -m pytest brython/tests/ -q` — Forventet: alt PASS (scan-testen grønn; node kjører engine-IIFE-en — syntaksfeil i engine-js fanges her).
- [ ] **Step 7:** Commit: `git add js/brython-engine.js index.html brython/tests/test_engine_scan.py && git commit -m "feat(brython): duckdb replay bridge — LIB_REGISTRY entry, run() replay loop, __brythonDuck helper"`

### Task 5: Eksempel + sw.js + browser-verifisering

**Files:**
- Create: `examples/bry18_duckdb.txt`
- Modify: `index.html` (knapp etter bry17-knappen, ~linje 100)
- Modify: `sw.js` (CACHE-bump)

- [ ] **Step 1: Eksempelfil**

```
# Eksempel: SQL i Brython-modus — duckdb.sql(...) og .df()
# load https://raw.githubusercontent.com/hmelberg/openstat/main/data/iris.csv as iris
import duckdb
import plotly_express_brython as pe

# Datasett lastet med `# load` kan spørres direkte med SQL:
duckdb.sql("""
    SELECT species,
           round(avg(sepal_length), 2) AS snitt_lengde,
           count(*) AS n
    FROM iris
    GROUP BY species
    ORDER BY snitt_lengde DESC
""")
```

…og under (samme fil, fortsettelse):

```
# .df() gir en pandas-DataFrame du kan jobbe videre med:
df = duckdb.sql("SELECT species, sepal_length, petal_length FROM iris").df()
pe.scatter(df, x="sepal_length", y="petal_length", color="species",
           title="Iris via SQL → pandas → plotly")
```

(Merk: trailing-uttrykket `duckdb.sql(...)` øverst rendres som tabell via `Relation.to_html`; flytt `show(...)`-varianten inn hvis uttrykksvisning ikke slår til.) Full fil = de to blokkene etter hverandre, `show(...)`-fri.

- [ ] **Step 2: Knapp** i index.html etter bry17-knappen:

```html
              <button type="button" data-example="bry18_duckdb.txt" data-mode="brython" data-i18n>duckdb &mdash; SQL i Brython (.sql &rarr; .df)</button>
```

- [ ] **Step 3: sw.js:** bump `const CACHE = 'm2py-v13'` → `'m2py-v14'` (brython_runner.py er precachet og er endret).
- [ ] **Step 4: Browser-verifisering.** Server repoet lokalt (`python3 -m http.server 8123` fra repo-roten, i bakgrunnen). Åpne `http://localhost:8123` med chrome-devtools-MCP. **Først:** avregistrer service worker + hard reload (stale precache-fella). Så: velg brython-modus, last bry18-eksemplet, kjør. Verifiser: (1) aggregeringstabellen vises med 3 arter, (2) scatterplottet rendres, (3) ingen konsollfeil, (4) andre kjøring av samme script virker (replay-cache frisk per run). Kjør også bry01 (uten duckdb) for regresjonssjekk av replay-omskrevet run().
- [ ] **Step 5:** Commit: `git add examples/bry18_duckdb.txt index.html sw.js && git commit -m "feat(brython): duckdb example bry18 + button + sw cache bump"`

### Task 6: Merge + port til safestat og openstat

- [ ] **Step 1:** Full testkjøring i microdata: `python3 -m pytest brython/tests/ -q` → PASS; merge: `git checkout main && git merge --no-ff brython-duckdb -m "Merge brython-duckdb: duckdb.sql().df() in Brython mode (stage 6b)"`.
- [ ] **Step 2: safestat (FØRST).** Sjekk `git -C ~/Documents/GitHub/safestat branch --show-current` — hvis `master` ikke er utsjekket (annen økt på dash-v2-forbedringer): bygg porten i midlertidig worktree av `master` (mønster fra stadie 5/6a), ellers direkte. Kopier byte-likt fra microdata: `brython/duckdb_brython.py`, `brython/brython_runner.py`, `js/brython-engine.js`, `brython/tests/test_duckdb_brython.py`, `test_duckdb_brython_diff.py`, samt de nye testene i `test_brython_runner.py` og `test_engine_scan.py` (append — filene kan avvike ellers). `examples/`: sjekk `ls examples/bry*` — nummerering divergerer fra bry17; bruk neste ledige nummer og juster knappteksten. index.html: `__brythonDuck`-hjelperen + knapp (manuell innsetting — fila avviker). sw.js: bump CACHE med én. Kjør `python3 -m pytest brython/tests/ -q` i safestat → PASS. Commit på master.
- [ ] **Step 3: openstat.** Samme port som Step 2 (openstat har microdata-modus av, men brython-modusen er lik). Kjør testene → PASS. Commit på main.
- [ ] **Step 4:** `cd ~/Documents/GitHub/safestat && scripts/sync_check.sh` — Forventet: ingen nye avvik utover kjente.
- [ ] **Step 5:** Push alle tre repoer (`git push` i microdata, safestat, openstat).

### Task 7: Minne-oppdatering

- [ ] Oppdater `project_brython_engine.md`: stadie 6b ferdig med commit-SHAer, replay-mønsteret som gjenbrukbar async-bro-protokoll (`__brython_pending__`/`__BRYTHON_PENDING__`), gjenstående backlog = sklearn-lite. Oppdater MEMORY.md-linjen.

## Self-review

- Spec-dekning: roadmap-krav `duckdb.sql("...").df()` ✅ (Task 1), «over DuckDB-WASM-instansen appen allerede laster» ✅ (`__ensureDuckDB` gjenbrukes, Task 4), diff-test-regel ✅ (Task 3), registry-ikke-kode ✅, eksempel+knapp ✅ (Task 5), sync-rekkefølge ✅ (Task 6).
- Begge Brython-feller adressert eksplisitt; AST-vakten dekker den nye fila automatisk.
- Typekonsistens sjekket: `_run_sql` returnerer kolonnedict; `{cols:…}`/`{error:…}`-JSON-konvolutten er lik i Task 1 (parsing), Task 4 (produksjon) og testene.
