# micro — microdata.no emulator (public, BYOK-only build)

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

### Relationship to the full/advanced `m2py` repo

This repo was forked from the sibling `m2py` repo, which additionally supports
protected/sensitive data sources, Anvil-hosted login and AI, and server-side
remote execution. Those features (and their supporting files —
`m2py_remote.py`, `m2py_protection.py`, `js/login.js`, `js/strict-worker.js`,
`vendor/safepy.zip`, `sync_to_api.py`) were removed here on purpose; they are
not needed for the public/lite use case.

The two repos share a core engine — `m2py.py`, `functions.py`,
`m2py_translate.py`, `m2py_runtime/`, `py2m/`, `r2m/`, `protect.py`, and most of
`index.html`'s mode-switching/editor/run-pipeline logic. There is no shared
package or submodule between them (deliberately, to avoid infrastructure this
project doesn't need yet) — when you fix a bug in one of those files, check
whether the sibling repo has the same bug.

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
