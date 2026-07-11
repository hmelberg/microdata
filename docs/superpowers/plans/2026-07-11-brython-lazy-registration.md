# Brython Lazy Library Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load Brython-mode Python libraries (and their external JS dependencies) only when a user's code actually imports them, instead of fetching and compiling all of them at engine startup.

**Architecture:** brython_runner.py gains `_register_module(name, source)` (exec source into a fresh module object, insert into `sys.modules`) and `_alias_module(alias, canonical)`. js/brython-engine.js replaces the eager text/python script-tag mechanism with a `LIB_REGISTRY` (per library: aliases, Python deps, JS deps) plus `scanImports()` (regex over the user's script) and `ensureLibs()` (fetch + register on demand, JS deps loaded once). This removes the script tags entirely — and with them the MutationObserver race documented in the engine header.

**Tech Stack:** Brython 3.12 (browser), CPython 3.13 + pytest (tests), Node (engine scan tests via subprocess), ES5-style JS matching the existing engine file.

## Global Constraints

- brython_runner.py must run under BOTH CPython 3.13 (pytest) and Brython 3.12 — no `ast`, no CPython-only stdlib.
- `BrythonEngine.run()` ALWAYS resolves `{text, error}` — never rejects (index.html:3372, :8489 rely on this).
- Public API surface stays `global.BrythonEngine = { load, run, ... }` — index.html calls `load()` as mode-activation warm-up (index.html:3366, :8419).
- User-facing error strings in Norwegian (matching `'Kunne ikke laste '` style).
- JS in js/brython-engine.js: keep the file's existing style — IIFE, `var`, ES2017 async/await is already in use.
- Python lib files keep living in `brython/` and are fetched as `brython/<name>.py` relative to the page.
- This repo (microdata) is where development happens; Task 6 ports to safestat (first) and openstat.

---

### Task 1: `_register_module` / `_alias_module` in brython_runner.py

**Files:**
- Modify: `brython/brython_runner.py` (append after `_get_last_error`, before `_bind_datasets`)
- Test: `brython/tests/test_brython_runner.py` (append)

**Interfaces:**
- Produces: `_register_module(name: str, source: str) -> str` — `''` on success (including already-registered no-op), traceback text on failure; on success `import <name>` works inside `_execute_code`.
- Produces: `_alias_module(alias: str, canonical: str) -> str` — `''` on success, error text if canonical is not registered.
- Consumed by: the engine (Task 4) via the module object returned from `runPythonSource`.

- [ ] **Step 1: Write the failing tests**

Append to `brython/tests/test_brython_runner.py` (the file already does `import sys, os, json` and `import brython_runner as br` at the top):

```python
# ── lazy library registration (_register_module / _alias_module) ──────────

def test_register_module_import_works():
    err = br._register_module('lazydemo_a', 'value = 41\ndef bump(x):\n    return x + 1\n')
    assert err == ''
    out = br._execute_code('import lazydemo_a\nlazydemo_a.bump(lazydemo_a.value)')
    assert br._get_last_error() == ''
    assert '42' in out

def test_register_module_is_idempotent():
    assert br._register_module('lazydemo_b', 'value = 1\n') == ''
    assert br._register_module('lazydemo_b', 'value = 2\n') == ''  # no-op, not re-exec
    out = br._execute_code('import lazydemo_b\nlazydemo_b.value')
    assert '1' in out

def test_register_module_syntax_error_reports_and_skips():
    err = br._register_module('lazydemo_bad', 'def broken(:\n')
    assert 'SyntaxError' in err
    assert 'lazydemo_bad' not in sys.modules

def test_register_module_runtime_error_reports_and_skips():
    err = br._register_module('lazydemo_boom', 'raise ValueError("boom")\n')
    assert 'ValueError' in err and 'boom' in err
    assert 'lazydemo_boom' not in sys.modules

def test_alias_module():
    br._register_module('lazydemo_c', 'value = 7\n')
    assert br._alias_module('lazydemo_c_alias', 'lazydemo_c') == ''
    out = br._execute_code('import lazydemo_c_alias\nlazydemo_c_alias.value')
    assert '7' in out

def test_alias_unknown_module_errors():
    assert br._alias_module('nope_alias', 'nope_canonical') != ''
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/hom/Documents/GitHub/microdata && python3 -m pytest brython/tests/test_brython_runner.py -q -k lazydemo_or_alias --no-header 2>&1 | tail -5`
(simpler: `python3 -m pytest brython/tests/test_brython_runner.py -q`)
Expected: 6 new tests FAIL with `AttributeError: module 'brython_runner' has no attribute '_register_module'`.

- [ ] **Step 3: Implement**

Add to `brython/brython_runner.py`, after `_get_last_error()`:

```python
def _register_module(name, source):
    """Lazy lib-loading (engine calls this): make `source` importable as
    module `name`. Idempotent; returns '' on success, traceback on failure."""
    import types
    if name in sys.modules:
        return ''
    mod = types.ModuleType(name)
    try:
        exec(compile(source, name + '.py', 'exec'), mod.__dict__)
    except Exception:
        return traceback.format_exc()
    sys.modules[name] = mod
    return ''

def _alias_module(alias, canonical):
    """Make `import alias` resolve to already-registered module `canonical`."""
    if canonical not in sys.modules:
        return 'ukjent modul: ' + canonical
    sys.modules[alias] = sys.modules[canonical]
    return ''
```

- [ ] **Step 4: Run the full runner test file**

Run: `python3 -m pytest brython/tests/test_brython_runner.py -q`
Expected: all PASS (previous tests + 6 new).

- [ ] **Step 5: Commit**

```bash
git add brython/brython_runner.py brython/tests/test_brython_runner.py
git commit -m "feat(brython): _register_module/_alias_module for lazy lib loading"
```

---

### Task 2: `scanImports` + `LIB_REGISTRY` in the engine

**Files:**
- Modify: `js/brython-engine.js` (add registry + function; expose `_scanImports` in the export object)
- Test: `brython/tests/test_engine_scan.py` (new — pytest shelling out to node)

**Interfaces:**
- Produces: `scanImports(code: string) -> string[]` — canonical registry names mentioned by import statements in `code`, deduplicated, in first-mention order. Dotted names match on the first segment; aliases resolve to canonical names.
- Produces: `LIB_REGISTRY` — `{ <canonical>: { aliases: string[], deps: string[], js: {url, global}[] } }`; canonical name == `brython/<name>.py`.
- Exposed for tests as `BrythonEngine._scanImports`.
- Consumed by: `run()` in Task 4.

- [ ] **Step 1: Write the failing test file**

Create `brython/tests/test_engine_scan.py`:

```python
# scanImports-tests: kjører engine-JS-en i node (ingen DOM trengs — IIFE-en
# definerer bare funksjoner og setter globalThis.BrythonEngine).
import json, os, shutil, subprocess
import pytest

ENGINE = os.path.abspath(os.path.join(
    os.path.dirname(__file__), '..', '..', 'js', 'brython-engine.js'))

def scan(code):
    if shutil.which('node') is None:
        pytest.skip('node er ikke installert')
    js = ("require(process.argv[1]);"
          "const code = require('fs').readFileSync(0, 'utf8');"
          "process.stdout.write(JSON.stringify("
          "globalThis.BrythonEngine._scanImports(code)));")
    r = subprocess.run(['node', '-e', js, ENGINE],
                       input=code, capture_output=True, text=True, check=True)
    return json.loads(r.stdout)

def test_plain_import():
    assert scan('import pandas_brython as pd') == ['pandas_brython']

def test_from_import():
    assert scan('from plotly_express_brython import bar') == ['plotly_express_brython']

def test_comma_separated_imports():
    assert scan('import json, pandas_brython') == ['pandas_brython']

def test_unknown_modules_ignored():
    assert scan('import os\nimport sys\nx = 1') == []

def test_indented_import_found():
    assert scan('def f():\n    import pandas_brython\n') == ['pandas_brython']

def test_no_duplicates_first_mention_order():
    code = ('import plotly_express_brython\n'
            'import pandas_brython\n'
            'import plotly_express_brython\n')
    assert scan(code) == ['plotly_express_brython', 'pandas_brython']

def test_dotted_import_matches_first_segment():
    # Framtidige libs (matplotlib.pyplot); i dag: dotted form av kjent navn.
    assert scan('import pandas_brython.whatever') == ['pandas_brython']

def test_import_mid_line_not_matched_but_string_line_start_overmatches():
    # 'import' midt på en linje matcher ikke (regexen krever linjestart)...
    assert scan('x = "import pandas_brython"\nprint(x)') == []
    # ...men en docstring-LINJE som starter med 'import' over-matcher.
    # AKSEPTERT: harmløst — registrerer bare en lib koden aldri bruker.
    assert scan('s = """\nimport pandas_brython\n"""') == ['pandas_brython']
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest brython/tests/test_engine_scan.py -q`
Expected: FAIL — node exits non-zero (`TypeError: globalThis.BrythonEngine._scanImports is not a function`), surfacing as `CalledProcessError`.

- [ ] **Step 3: Implement in js/brython-engine.js**

Add below the `PY_LIBS` line (leave `PY_LIBS` and `load()` untouched for now — the old eager path keeps working until Task 4 removes it):

```js
  // Library registry — single source of truth for lazily loaded Python libs.
  // Key = canonical module name (== brython/<key>.py).
  //   aliases: extra import names resolving to the same module.
  //   deps:    registry keys that must be registered first (module-level imports).
  //   js:      external JS scripts loaded (once) before the module registers;
  //            skipped when window[<global>] already exists.
  var LIB_REGISTRY = {
    pandas_brython:         { aliases: [], deps: [], js: [] },
    plotly_express_brython: { aliases: [], deps: [], js: [] }
  };

  function scanImports(code) {
    // Find registry libraries mentioned in import statements. Over-matching
    // (imports inside strings/docstrings) is harmless — it only registers a
    // library the code never uses. Dotted names count by their first segment.
    var needed = [];
    function add(rawName) {
      var name = rawName.split('.')[0];
      var canonical = LIB_REGISTRY.hasOwnProperty(name) ? name : null;
      if (!canonical) {
        for (var k in LIB_REGISTRY) {
          if (LIB_REGISTRY[k].aliases.indexOf(name) !== -1) { canonical = k; break; }
        }
      }
      if (canonical && needed.indexOf(canonical) === -1) needed.push(canonical);
    }
    var re = /^[ \t]*(?:from[ \t]+([A-Za-z_][A-Za-z0-9_.]*)|import[ \t]+([^#\r\n]+))/gm;
    var m, parts, i, t;
    while ((m = re.exec(code))) {
      if (m[1]) { add(m[1]); continue; }
      parts = m[2].split(',');
      for (i = 0; i < parts.length; i++) {
        t = parts[i].trim().split(/[ \t]/)[0];   // drop "as <alias>"
        if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(t)) add(t);
      }
    }
    return needed;
  }
```

And extend the export line at the bottom of the file:

```js
  global.BrythonEngine = { load: load, run: run, _scanImports: scanImports };
```

- [ ] **Step 4: Verify**

Run: `node --check js/brython-engine.js && python3 -m pytest brython/tests/test_engine_scan.py -q`
Expected: syntax check OK; all scan tests PASS.

- [ ] **Step 5: Commit**

```bash
git add js/brython-engine.js brython/tests/test_engine_scan.py
git commit -m "feat(brython-engine): LIB_REGISTRY + scanImports with node-backed tests"
```

---

### Task 3: Lazy `ensureLibs` + JS-dependency loader

**Files:**
- Modify: `js/brython-engine.js`

**Interfaces:**
- Consumes: `LIB_REGISTRY`, `addScript`, `fetchText` (existing), `mod._register_module` / `mod._alias_module` (Task 1).
- Produces: `ensureLibs(mod, names: string[]) -> Promise<void>` — registers each canonical lib (deps first, JS deps loaded once); throws `Error` with the runner's traceback text on registration failure. Idempotent via `__registered`.

- [ ] **Step 1: Implement**

Add after `scanImports` in `js/brython-engine.js`:

```js
  var __registered = {};   // canonical name -> true once registered in the runner
  var __jsLoaded = {};     // url -> load promise (shared across libs)

  function loadJsDep(dep) {
    if (global[dep.global]) return Promise.resolve();   // already on the page
    if (!__jsLoaded[dep.url]) __jsLoaded[dep.url] = addScript(dep.url);
    return __jsLoaded[dep.url];
  }

  async function ensureLibs(mod, names) {
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      if (__registered[name]) continue;
      var entry = LIB_REGISTRY[name];
      if (!entry) continue;
      await ensureLibs(mod, entry.deps);                 // deps first (module-level imports)
      for (var j = 0; j < entry.js.length; j++) await loadJsDep(entry.js[j]);
      var source = await fetchText('brython/' + name + '.py');
      var err = mod._register_module(name, source);
      if (err) throw new Error(String(err));
      for (var a = 0; a < entry.aliases.length; a++) {
        err = mod._alias_module(entry.aliases[a], name);
        if (err) throw new Error(String(err));
      }
      __registered[name] = true;
    }
  }
```

- [ ] **Step 2: Verify syntax + regressions**

Run: `node --check js/brython-engine.js && python3 -m pytest brython/tests/ -q`
Expected: OK / all PASS (ensureLibs is not wired in yet — that is Task 4).

- [ ] **Step 3: Commit**

```bash
git add js/brython-engine.js
git commit -m "feat(brython-engine): ensureLibs with dep ordering and lazy JS deps"
```

---

### Task 4: Wire lazy loading into `load()`/`run()`, remove the tag mechanism

**Files:**
- Modify: `js/brython-engine.js` (`load()`, `run()`, delete `addPyModule` + `PY_LIBS` + setTimeout race-yield; rewrite file header comment)

**Interfaces:**
- Consumes: `scanImports`, `ensureLibs` (Tasks 2–3).
- Produces: unchanged public API `BrythonEngine.load()` (now core+stdlib+runner only) and `BrythonEngine.run(script, opts)` (registers needed libs per run; forces `pandas_brython` when datasets bind).

- [ ] **Step 1: Replace `load()` and delete the tag machinery**

Delete `PY_LIBS`, `addPyModule()`, and the `setTimeout(0)` yield with its comment block. New `load()`:

```js
  function load() {
    if (__enginePromise) return __enginePromise;
    __enginePromise = (async function () {
      await addScript(BRYTHON_CORE);
      await addScript(BRYTHON_STDLIB);
      var source = await fetchText('brython/brython_runner.py');
      global.brython();                // no-args (see header)
      return global.__BRYTHON__.runPythonSource(source, 'brython_runner');
    })().catch(function (e) { __enginePromise = null; throw e; });
    return __enginePromise;
  }
```

- [ ] **Step 2: Wire `run()`**

Replace the body between `var spec = ...` and the `_bind_datasets` block:

```js
      var mod = await load();
      var spec = await buildDatasetSpec(opts && opts.loads);
      var needed = scanImports(script);
      if (Object.keys(spec).length && needed.indexOf('pandas_brython') === -1) {
        needed.push('pandas_brython');   // _bind_datasets bygger DataFrames
      }
      await ensureLibs(mod, needed);
      if (Object.keys(spec).length) {
        var bindErr = mod._bind_datasets(JSON.stringify(spec));
        if (bindErr) return { text: '', error: String(bindErr) };
      }
```

(The surrounding try/catch already folds `ensureLibs` throws into `{text:'', error}` — keep it.)

- [ ] **Step 3: Rewrite the file header comment**

Replace the entire header comment block (lines 1–69 of the old file) with:

```js
// js/brython-engine.js — lightweight Python engine (Brython) for openstat/safestat.
// Design: docs/superpowers/specs/2026-07-10-brython-engine-design.md
// Lazy libs: docs/superpowers/plans/2026-07-11-brython-lazy-registration.md
//
// Loads Brython 3.12 core+stdlib from CDN, compiles brython_runner.py once via
// __BRYTHON__.runPythonSource, and exposes run(). Python libraries are NOT
// loaded up front: before each run, scanImports() finds which LIB_REGISTRY
// libraries the user's code mentions and ensureLibs() fetches and registers
// only those — via the runner's _register_module(), which execs the source
// into a fresh module object and inserts it in sys.modules. External JS
// dependencies (e.g. a stats lib backing a wrapper module) are declared per
// library in LIB_REGISTRY and loaded on first use only.
//
// This replaces the original text/python script-tag mechanism and with it the
// MutationObserver race it required (tags had to be registered before
// brython() ran; the full analysis lives in git history of this file).
//
// Verified against the actual jsdelivr brython@3.12.0 bundle:
//   - brython() is called with NO arguments; its options object only reads
//     debug/args/breakpoint/indexedDB/python_extension — nothing else exists.
//   - __BRYTHON__.runPythonSource(source, script_id) takes the module name as
//     its second argument (compile-unit name; auto-generated only when the
//     argument is literally undefined).
//
// Output is embed-marker text; index.html renders it via buildOutputNodes().
```

- [ ] **Step 4: Verify syntax + full suite**

Run: `node --check js/brython-engine.js && python3 -m pytest brython/tests/ -q`
Expected: OK / all PASS.

- [ ] **Step 5: Commit**

```bash
git add js/brython-engine.js
git commit -m "feat(brython-engine): lazy per-run lib registration, drop script tags"
```

---

### Task 5: Browser verification (manual)

**Files:** none (verification only). Brython runs only in a real browser — the pytest suite cannot cover the load()/ensureLibs path end to end.

- [ ] **Step 1: Serve the app**

Run: `cd /Users/hom/Documents/GitHub/microdata && python3 -m http.server 8765`

- [ ] **Step 2: Verify lazy startup**

Open `http://localhost:8765`, open devtools Network tab, switch to Brython mode.
Expected after mode warm-up: `brython.min.js`, `brython_stdlib.js`, `brython_runner.py` fetched; `pandas_brython.py` / `plotly_express_brython.py` NOT fetched.

- [ ] **Step 3: Verify on-demand registration + dataset path**

Run the Brython startup example (imports pandas + plotly, loads iris via `# load`).
Expected: `pandas_brython.py` and `plotly_express_brython.py` fetched now; iris table renders; scatter chart renders. Re-run: no re-fetch (registry cache), identical output.

- [ ] **Step 4: Verify examples + error path**

Run examples `bry01_pandas_basics.txt` and `bry02_plotly_charts.txt` — both render as before.
Then run a script whose only statement is `import pandas_brython` after stopping the
HTTP server's access to the file (rename `brython/pandas_brython.py` temporarily):
expected a Norwegian error message (`Kunne ikke hente brython/pandas_brython.py (404)`)
in the output area, no unhandled rejection in the console. Restore the file.

- [ ] **Step 5: Commit any fixes found; otherwise nothing to commit.**

---

### Task 6: Port to safestat and openstat

**Files:**
- Modify: `../safestat/js/brython-engine.js`, `../safestat/brython/brython_runner.py`, `../safestat/brython/tests/test_brython_runner.py`, create `../safestat/brython/tests/test_engine_scan.py`
- Same four files in `../openstat/`

**Interfaces:** identical file contents — these are shared engine files (all three copies were byte-identical before this work).

- [ ] **Step 1: Copy (safestat first, per repo convention)**

```bash
cd /Users/hom/Documents/GitHub
for sib in safestat openstat; do
  cp microdata/js/brython-engine.js        $sib/js/brython-engine.js
  cp microdata/brython/brython_runner.py   $sib/brython/brython_runner.py
  cp microdata/brython/tests/test_brython_runner.py $sib/brython/tests/
  cp microdata/brython/tests/test_engine_scan.py    $sib/brython/tests/
done
```

- [ ] **Step 2: Run each sibling's Brython tests**

```bash
(cd safestat && python3 -m pytest brython/tests/ -q)
(cd openstat && python3 -m pytest brython/tests/ -q)
```
Expected: all PASS in both.

- [ ] **Step 3: Run the sync check**

Run: `cd /Users/hom/Documents/GitHub/safestat && sh scripts/sync_check.sh`
Expected: `OK: alle kjernefiler er i sync.` (Note: `brython/` and `js/brython-engine.js` are not yet in the script's core list — consider adding `brython` and `js/brython-engine.js` to the `core=` list in `scripts/sync_check.sh` so future drift is caught. Decision for Hans; the script header currently excludes `js/` deliberately.)

- [ ] **Step 4: Quick browser smoke test in safestat**

Serve safestat (`python3 -m http.server 8766`), switch to Brython mode, run the startup example. Expected: renders as in microdata.

- [ ] **Step 5: Commit in each repo**

```bash
(cd safestat && git add js/brython-engine.js brython/ && git commit -m "feat(brython-engine): lazy lib registration (ported from microdata)")
(cd openstat && git add js/brython-engine.js brython/ && git commit -m "feat(brython-engine): lazy lib registration (ported from microdata)")
```
