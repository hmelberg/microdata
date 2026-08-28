# Edge Functions — lokal testing

AI-endepunkter (se `netlify.toml` for path-mapping):

- `svar` → `/api/svar` — den samlede AI-pipelinen (spec 2026-08-28): ETT
  agentisk løp der modellen skriver script, får dem KJØRT i emulatoren via
  klientutført `run_code`, slår opp variabler med `variabel_info`, og svarer
  basert på faktiske kjøringsresultater. SSE-events:
  progress/text/run_code/continue/done/error. Fortsettelsesprotokoll: Netlify
  har CPU-tak per invokasjon, så serveren kjører én API-tur per POST og
  avslutter med `{type:"continue", state, run_ok_calls}` når den ikke er
  ferdig; klienten re-POSTer samme body pluss `resume` (og `run_result` etter
  en kjøring) til svaret kommer. Kvalitetsvelgeren styrer modell/effort OG
  rundebudsjett (8/3 · 12/4 · 20/6). Instruks: `_lib/svar-instruks.ts`;
  prefiks: `_lib/prefiks.ts`; evalsett: `docs/eval/svar-evalsett.md`.
  (Erstattet kode-svar/kode-svar-v2/data-svar 2026-08-28.)
- `dm-vurder` → `/api/dm-vurder` — personvern-/dataminimerings-vurdering av et script
- `tolk-resultat` → `/api/tolk-resultat` — tolker output fra en kjøring
- `hent` → `/api/hent?url=…[&body=…]` — SSRF-herdet GET-proxy (kun admin).
  Injiserer API-nøkler server-side for register-kilder (host-matchet);
  `body` GET-innpakker POST-json (PxWeb v1 o.l.).

## Forutsetninger

1. Installer Netlify CLI: `npm install -g netlify-cli`
2. Sett env-vars: `cp .env.example .env`, fyll inn `ANTHROPIC_API_KEY` og
   `M2PY_ACCESS_TOKEN` (delt token for lokal/admin-tilgang). Samme variabler må
   settes i Netlify-konsollen før prod-deploy.
   - `M2PY_ACCESS_TOKEN_PERSONAL` + `ANTHROPIC_API_KEY_PERSONAL` (valgfrie) —
     et andre passord-nivå: det personlige passordet autentiserer likt (og
     teller som admin), men forbruket går på den personlige nøkkelen i stedet
     for den delte, og passordet er UNNTATT ratelimiten (feilgjetninger
     rate-limites fortsatt). Personlig passord uten personlig nøkkel er 500
     med vilje.
   - `FRED_API_KEY` (valgfri) — server-side nøkkel `hent` injiserer
     for FRED-kilder i registeret (host-matchet, aldri sendt til klienten).
   - `SVAR_MODEL` (valgfri) — override av modellen `/api/svar` bruker
     (standard: samme som `ANTHROPIC_MODEL`/`claude-sonnet-5`).

## Start lokal dev-server

```
netlify dev
```

Server starter typisk på `http://localhost:8888`.

## Auth

Alle tre endepunktene krever `Authorization: Bearer <token>` (felles
`_lib/auth.ts`-gate: token-sjekk → metode → body-grense → rate-limit →
passord-sjekk, med konstant-tid-sammenligning). De eneste gyldige tokens er
de to passordene `M2PY_ACCESS_TOKEN` og `M2PY_ACCESS_TOKEN_PERSONAL`; alt
annet gir umiddelbar 401 (Anvil-fallbacken ble fjernet 2026-08-28).

## Test dm-vurder med curl

```bash
curl -N -X POST http://localhost:8888/api/dm-vurder \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $M2PY_ACCESS_TOKEN" \
  -d '{
    "script": "// personvern: formål: Studere inntektsforskjeller\nimport all from BEFOLKNING\nkeep if alder >= 18\nsummarize INNTEKT, by(kommune)"
  }'
```

Forventet output: en strøm av `data: {"type":"text","text":"..."}`-linjer,
deretter en `data: {"type":"done","inputTokens":...,"outputTokens":...}`-linje.
Innholdet er norsk markdown (Klassifisering, Samlet vurdering, Observasjoner).

## Feil-scenarioer

- Mangler/ugyldig token → 401
- Feil metode (ikke POST) → 405
- For stor body (`content-length` over grensen) → 413
- For mange kall fra samme IP → 429 (med `Retry-After`)

## Struktur

- `svar.ts`, `dm-vurder.ts`, `tolk-resultat.ts` — endepunktene
- `_lib/auth.ts` — felles request-gate (auth + rate-limit + body-guard)
- `_lib/rate-limit.ts` — per-IP token-bucket (Netlify Blobs; failer åpent)
- `_lib/anthropic.ts` — Anthropic streaming-klient (timeout + 429/529-retry)
- `_lib/parse-script-context.ts` — personvern-kommentarer + språk-deteksjon
- `prompts/` — kildefiler for prompt-tekstene (duplisert som TypeScript-
  konstanter i endepunkt-filene siden Deno Deploy ikke bundler .md i runtime;
  oppdater begge stedene ved endring)

## Tester

```
deno check *.ts _lib/*.ts
deno test --allow-all _lib/
```
(kjøres også i CI via `.github/workflows/edge-tests.yml`)
