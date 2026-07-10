# Microdata — microdata.no-emulator (public, BYOK-only build)

> Sister projects: [SafeStat](https://github.com/hmelberg/safestat) — the full
> build with login, protected data sources and remote analysis — and
> [OpenStat](https://github.com/hmelberg/openstat) — the general browser
> statistics workbench (microdata, Python, R, DuckDB, Brython, jamovi, Statx).
> This repo is the dedicated microdata.no emulator: the microdata persona is
> always on, and the UI is meant to track microdata.no as closely as possible
> over time. Engine fixes land in SafeStat first and are ported here.

A browser app that emulates [microdata.no](https://microdata.no): it translates
microdata scripts to Python and runs them in the browser via Pyodide, generates
synthetic register data from metadata, and adds tools around it — Python/R
runners, Python/R → microdata translators, an editor that mimics microdata.no,
a step-by-step tutorial mode, and AI features (code generation, a
data-minimization/privacy review, and result interpretation).

This is the **public, lite** version: no login, no accounts, no protected/
sensitive data sources, and no server-side remote execution. The AI features
work only via a user-supplied Anthropic API key (BYOK), pasted into the
Settings dialog and stored only in the browser's `localStorage` — our Netlify
edge functions relay each request straight to Anthropic and don't store the
key or the request content. See `personvern.html` for the full privacy
statement.

## Layout

| Path | What |
|------|------|
| `index.html` | The front-end app shell (editor, runners, mode system, settings) + remaining inline modules. |
| `app.css`, `js/` | Extracted front-end: `app.css` (styles); `js/ai-chat.js`, `js/github-storage.js`, `js/data-directives.js`, `js/data-loader.js`, `js/enc-crypto.js` (classic `<script src>` modules loaded after the inline block, sharing the `window.*` surface). |
| `m2py.py` | The interpreter: `MicroParser` + `MicroInterpreter` (engine, mock-data, stats, disclosure control). |
| `functions.py` | microdata functions used in generate/replace/if expressions. |
| `protect.py` | `scrub-*` data-protection verbs (noise, swap, k-anon, risk, …) — a local disclosure-control toolkit you can call on your own scripts; no server involved. |
| `mockdata_export.py`, `static_source.py`, `build_static_data.py` | Static synthetic-data build (Parquet/DuckDB) + the static data source. |
| `py2m/`, `r2m/` | Python→microdata and R→microdata translators (each with its own runner + tests). |
| `netlify/edge-functions/` | The AI endpoints (`dm-vurder`, `kode-svar`, `kode-svar-v2`, `tolk-resultat`, `data-svar`, `hent`) + shared `_lib/`. All accept a BYOK Anthropic key (`X-Anthropic-Key`) — no account/token required. |
| `manual_scripts/` | End-to-end example scripts run as a smoke suite. |
| `tests/` | pytest suite (engine, regressions, equivalence, mock-data, performance). |

### Relationship to the sibling repos (safestat, openstat)

This repo was cloned from `openstat` (2026-07-10) with full git history, so
changes can be ported between the repos with `git cherry-pick` (remotes
`openstat-local` and `safestat` point at the local sibling checkouts).
`openstat` was in turn forked from `safestat`, which additionally supports
protected/sensitive data sources, login, and server-side remote execution.

What differs here from `openstat`:
- The microdata persona is **locked on**: `NL.hostnameMode()` and
  `NL.urlHasMicro()` in `js/notebook-links.js` return constants, so the
  microdata UI (Oversett, Søk om data, disclosure control, data source,
  label/import settings, microdata AI routing) is always visible and
  microdata is always the default mode. Other languages stay available in
  the mode menu, but are never the default.
- The UI is allowed to drift toward microdata.no (layout, icons, menus)
  independently of the siblings.

The three repos share a core engine — `m2py.py`, `functions.py`,
`m2py_translate.py`, `mockdata_*.py`, `py2m/`, `r2m/`, `protect.py`,
`variable_metadata.json`, `codelists/` — with no shared package or submodule
(deliberately). **Engine fixes land in SafeStat first** and are ported to
openstat and here; when you fix a bug in a core file, check the siblings.
UI files (`index.html`, `js/`) drift freely and should not be blind-synced.

## Common commands

```bash
# Python tests (engine, regressions, equivalence, mock-data)
.venv/bin/python -m pytest tests/

# End-to-end smoke suite (exits non-zero on any CRASH/PARTIAL)
.venv/bin/python manual_scripts/run_manual_scripts.py

# Translator tests
.venv/bin/python -m pytest py2m/tests/
Rscript r2m/test_r2m.R

# Edge functions (Deno)
cd netlify/edge-functions && deno check *.ts _lib/*.ts && deno test --allow-all _lib/

# Build the static synthetic dataset (writes static_data/*.parquet + manifest.json)
.venv/bin/python build_static_data.py --persons 100000 --from 2015 --to 2023
```

CI lives in `.github/workflows/` (pytest + manual scripts, py2m, r2m, edge).

## Deployment

The site deploys on Netlify (`netlify.toml`): static files + the edge
functions. Set `ANTHROPIC_API_KEY` only if you want a server-side fallback for
non-BYOK requests — otherwise every AI request requires the caller's own key.
`sw.js` precaches Pyodide — **bump `CACHE` whenever the precache list
changes.**
