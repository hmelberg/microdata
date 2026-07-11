# Brython Library Expansion — Staged Roadmap

**Goal:** Grow Brython mode from 2 libraries (pandas_brython, plotly_express_brython) to a
family of statistics-teaching libraries, while keeping startup fast: libraries (and any JS
they wrap) load only when a user's code actually imports them.

**How to use this document:** Each stage gets its own detailed implementation plan
(written with superpowers:writing-plans) when work on it starts. Stage 1's plan exists:
`2026-07-11-brython-lazy-registration.md`. Stages are ordered by dependency and user value;
each produces working, testable software on its own.

## Cross-cutting rules (apply to every stage)

- **One file per library** in `brython/`, importable in CPython too (guard browser-only
  imports with `try: from browser import ... except ImportError`). This preserves the
  dual-run test contract.
- **Diff-tests against the real library** in `brython/tests/test_<lib>_diff.py`
  (pattern: `test_pandas_brython_diff.py`) — numerical results compared to real
  scipy/statsmodels/numpy running on the dev machine.
- **Registry, not code changes:** adding a library to the engine = one entry in
  `LIB_REGISTRY` in `js/brython-engine.js` (built in Stage 1). JS dependencies are
  declared there and lazy-loaded.
- **One example file per library** in `examples/bryNN_<lib>.txt` + a button in index.html
  (respect the data-mode-only/showsButton gating principle — no hardcoded mode exceptions).
- **Sync:** develop in microdata, port `brython/*.py`, `brython/tests/*`, and
  `js/brython-engine.js` to safestat first, then openstat; run
  `safestat/scripts/sync_check.sh`.
- **Norwegian user-facing error strings**, English/Norwegian code comments per existing
  file conventions.

## Stage 1 — Lazy registration infrastructure (size: S) — plan written

Replace the eager text/python script-tag mechanism with on-demand registration:
the engine scans the user's code for imports before each run, fetches only the mentioned
libraries, and registers them via a new `_register_module(name, source)` in
brython_runner.py (exec into a fresh module object + `sys.modules` insert — no tags, which
also removes the old MutationObserver race). `LIB_REGISTRY` declares per-library aliases,
Python deps, and external JS deps (loaded once, on first use).

Detailed plan: `docs/superpowers/plans/2026-07-11-brython-lazy-registration.md`.

**Benefit even before new libs:** startup stops fetching+compiling ~7 300 lines of Python
that a "just show a table" dashboard never imports.

## Stage 2 — matplotlib.pyplot shim (size: M)

`matplotlib_brython.py` — a `plt` façade that builds the same Plotly figure objects
plotly_express_brython already emits (shim-over-shim; deps: `plotly_express_brython`).
Unlocks the huge body of existing teaching examples written in matplotlib.

- Scope v1 (function API): `plot`, `scatter`, `bar`, `barh`, `hist`, `boxplot`, `pie`,
  `title`, `xlabel`, `ylabel`, `xlim`, `ylim`, `legend`, `grid`, `figure`, `show`.
- Stretch: `fig, ax = plt.subplots()` object API (much teaching code uses it).
- **Known tricky bit:** `import matplotlib.pyplot as plt` is a dotted import. Stage 2 must
  extend the runner with a submodule helper (register `matplotlib` package module +
  `sys.modules['matplotlib.pyplot']`, parent exposing `.pyplot`). scanImports already
  matches on the first dotted segment (`matplotlib` as alias).
- Testing: structural diff of emitted Plotly JSON (like existing plotly tests) — not
  pixel-comparison against real matplotlib.

## Stage 3 — scipy.stats subset (size: M–L)

`scipy_stats_brython.py` — the biggest content gap for statistics teaching.

- Distributions: `norm`, `t`, `chi2`, `f` with `pdf`, `cdf`, `ppf`, `sf`.
- Tests: `ttest_1samp`, `ttest_ind`, `ttest_rel`, `chi2_contingency`, `pearsonr`,
  `mannwhitneyu`.
- **Implementation decision: pure Python first.** The only hard parts are the special
  functions (log-gamma via Lanczos, regularized incomplete beta/gamma via continued
  fractions — ~150 lines, standard numerics). Pure Python keeps the module fully
  diff-testable against real scipy in CPython and avoids a CDN dependency. Fall back to a
  jStat wrapper (`js: [{url: jsdelivr jstat, global: 'jStat'}]`) only if precision problems
  surface in diff-tests.
- Alias `scipy` with submodule `scipy.stats` (reuses Stage 2's submodule helper), so
  `from scipy import stats` and `from scipy.stats import norm` both work.

## Stage 4 — statsmodels formula API (size: M)

`statsmodels_brython.py` — `smf.ols('y ~ alder + region', data=df).fit().summary()` is the
single most teaching-relevant feature. Deps: `scipy_stats_brython` (p-values),
`pandas_brython` (data input).

- Scope: formula parser (`y ~ x1 + x2 + C(kat)`, intercept handling), OLS via pure-Python
  normal equations + Gaussian elimination, Logit via Newton–Raphson; results object with
  `params`, `bse`, `tvalues`, `pvalues`, `rsquared`, `predict()`, and `summary()` rendering
  through the existing `to_html` embed-marker path.
- Numerical caveat is acceptable at teaching scale (small n, few regressors); diff-tests
  against real statsmodels define the tolerance.

## Stage 5 — numpy subset (size: M)

`numpy_brython.py`, alias `numpy` — added late deliberately: at teaching scale plain lists
are fast enough, and Stages 2–4 reveal which numpy calls example code actually needs.

- Scope: 1D/2D `array`, `arange`, `linspace`, `zeros`, `ones`; elementwise arithmetic and
  comparisons (broadcast scalar↔array); `mean`, `std`, `var`, `median`, `percentile`,
  `min`, `max`, `sum`; `where`; `dot`; seeded `random` (`normal`, `uniform`, `integers`,
  `choice` — Python's `random.Random` as the generator).
- tinynumpy (MIT, pure Python 1D/2D) is a candidate seed — evaluate before writing from
  scratch.
- Diff-test against real numpy.

## Stage 6 — Backlog (decide after Stage 5)

- **seaborn shim** — near-renames of plotly express calls; cheap once Stage 2 exists.
- **sklearn-lite** — wrapper over ml.js packages (KMeans, PCA, regressions); would be the
  first real user of the lazy JS-dependency mechanism.
- **duckdb_brython** — `duckdb.sql("...").df()` over the DuckDB-WASM instance the app
  already loads for parquet; ties Brython mode into the DuckDB-primary data-layer decision
  (2026-07-11).
