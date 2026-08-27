# Samlet svar-pipeline — implementasjonsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Én Send-knapp og ett agentisk `/api/svar`-løp der modellen kjører microdata-script i emulatoren via klientutført `run_code`, ser resultatene og svarer begrunnet; `kode-svar`/`kode-svar-v2`/`data-svar` slettes.

**Architecture:** Motorlaget (`_lib/anthropic.ts` + `_lib/providers/*`) er BYTE-IDENTISK med askstat og har allerede pending-protokollen (`clientTools`, `maxRunCode`, `runResult`, SSE-event `{type:"run_code",script}`) — det RØRES IKKE. Nytt: `svar.ts`-endepunkt, mikrodata-egen systeminstruks oppå eksisterende `buildCachedPrefix` (ekstraheres til `_lib/prefiks.ts`), `variabel_info`-verktøy, `run-disiplin.ts` COPIED fra askstat, og klientløkke i `js/ai-chat.js`.

**Tech Stack:** Deno edge functions (test: `cd netlify/edge-functions && deno check *.ts _lib/*.ts && deno test --allow-all _lib/`), vanilla JS-klient (test: `node --test "tests/js/*.test.js"` — glob-formen, katalogformen feiler).

**Spec:** `docs/superpowers/specs/2026-08-28-samlet-svar-pipeline-design.md`

## Global Constraints

- `_lib/anthropic.ts` og `_lib/providers/*.ts` skal forbli byte-identiske med askstat (cherry-pick-kontrakten). Diff-sjekk før commit i hver task som er i nærheten.
- Filer kopiert fra askstat merkes `// COPIED fra askstat/<sti> — ikke re-style` øverst.
- Byte-kontrakt for kjøreresultat (kryss-lag, fra askstats run-disiplin): suksess = `"OK. OUTPUT (truncated):\n" + output`, feil = `"FEIL:\n" + tekst`. Klassifisereren sjekker `startsWith("OK.")`.
- Kvalitet→budsjett: fast 8 verktøykall/3 kjøringer, balanced 12/4, best 20/6.
- Ingen bakoverkompat: gamle endepunkter og klientveier slettes, ikke fryses.
- Norsk i kommentarer/UI-tekster; commit-stil som repoet (historie-fortellende).
- Hver task: kjør relevante tester FØR commit; push etter commit (Git-CD deployer).

---

### Task 1: run-disiplin COPIED fra askstat

**Files:**
- Create: `netlify/edge-functions/_lib/run-disiplin.ts` (kopi av `../askstat/netlify/edge-functions/_lib/run-disiplin.ts`)
- Create: `netlify/edge-functions/_lib/run-disiplin.test.ts` (kopi av askstats)

**Interfaces:**
- Produces: `klassifiserRunResult(s): "ok"|"feil"`, `coerceRunOkCalls(u): number`, `skalStengeRunCode(n): boolean`, `medPaaminnelse(s): string`, `filtrerRunCode(tools, runOkCalls): unknown[]`, `PAAMINNELSE`

- [ ] **Step 1:** `cp ../askstat/netlify/edge-functions/_lib/run-disiplin.ts netlify/edge-functions/_lib/` og samme for `.test.ts`. Legg `// COPIED fra askstat/netlify/edge-functions/_lib/run-disiplin.ts — ikke re-style.` øverst i BEGGE. Endre header-kommentarens klient-referanse fra `mdAskExecuteScript (js/ai-chat.js)` til `run_code-armen i js/ai-chat.js (runSvar)`.
- [ ] **Step 2:** `cd netlify/edge-functions && deno test --allow-all _lib/run-disiplin.test.ts` → PASS.
- [ ] **Step 3:** Commit `feat(edge): run-disiplin COPIED fra askstat — svar-klart-stopp for run_code`.

### Task 2: ekstraher prefiks-byggeren til `_lib/prefiks.ts`

**Files:**
- Create: `netlify/edge-functions/_lib/prefiks.ts`
- Modify: `netlify/edge-functions/kode-svar.ts` (fjern flyttet kode, importer fra `_lib/prefiks.ts`)
- Modify: `netlify/edge-functions/kode-svar-v2.ts` (oppdater import hvis den importerer fra kode-svar.ts)

**Interfaces:**
- Produces: `buildCachedPrefix(origin: string, mode?: GenMode): Promise<string>`, `type GenMode = "microdata"|"python"|"r"`, `fetchText(origin, path): Promise<string>` — SAMME signaturer som i dag (ren flytting).

- [ ] **Step 1:** Finn alt buildCachedPrefix trenger i `kode-svar.ts` (`buildCachedPrefix`, `_cachedPrefix`, `renderCatalog`, `renderKommuneCodes`, `renderCommands`, `renderFunctions`, `fetchText`, `GenMode`, prompt-konstantene prefiksen sammenstiller — følg referansene fra `buildCachedPrefix` og ta med NØYAKTIG det transitive settet). Flytt til `_lib/prefiks.ts` med `export` på de tre i Interfaces; resten forblir modul-privat.
- [ ] **Step 2:** I `kode-svar.ts`: erstatt flyttet kode med `import { buildCachedPrefix } from "./_lib/prefiks.ts";` (+ det v2 måtte trenge). `grep -n "buildCachedPrefix\|fetchText" netlify/edge-functions/kode-svar-v2.ts` og oppdater dens importer tilsvarende.
- [ ] **Step 3:** `deno check *.ts _lib/*.ts && deno test --allow-all _lib/` → alt grønt (742-linjers flytting, null semantikk-endring; `prompt-assembly.test.ts` er vokteren).
- [ ] **Step 4:** Commit `refactor(edge): prefiks-byggeren ut av kode-svar.ts — svar.ts skal gjenbruke den`.

### Task 3: `variabel_info`-verktøyet

**Files:**
- Create: `netlify/edge-functions/_lib/tools/variabel-info.ts`
- Test: `netlify/edge-functions/_lib/tools/variabel-info.test.ts`

**Interfaces:**
- Produces: `variabelInfo(origin: string, navnEllerSok: string, deps?: {fetchImpl?: typeof fetch}): Promise<string>` — tekstblokk klar som tool_result.

- [ ] **Step 1: Failing test.** Mock fetchImpl som svarer med en liten `variable_metadata.json`-form (bruk NØYAKTIG feltnavnene fra ekte fil — les `head -c 2000 variable_metadata.json` først og speil formen) + én kodeliste. Tester: (a) eksakt navn → blokk med beskrivelse/type/periode + kodeliste-innhold når `/codelists/<NAVN>.json` finnes (mock 200), (b) substring-søk → inntil 10 treff med énlinjes oppsummering, (c) ukjent navn → `"Ingen variabel matcher …"`-melding (ALDRI kast), (d) kodeliste-404 → blokk uten kodeliste, ingen feil.

```ts
Deno.test("variabelInfo: eksakt navn gir detaljblokk med kodeliste", async () => {
  const svar = await variabelInfo("https://x.test", "NUDB_BU", { fetchImpl: mockFetch });
  assertStringIncludes(svar, "NUDB_BU");
  assertStringIncludes(svar, "KODELISTE");
});
```

- [ ] **Step 2:** Kjør → FAIL (modul finnes ikke).
- [ ] **Step 3:** Implementer: hent `variable_metadata.json` via samme-origin fetch med in-isolat-cache (samme mønster som `_cachedPrefix` i prefiks.ts: modul-nivå `let`-cache). Eksakt match først; ellers case-insensitivt substring-søk over navn+beskrivelse, cap 10 treff. For eksakt match: prøv `/codelists/<NAVN>.json`, 404 tolereres. Returstreng cappes til 8000 tegn med `…avkortet`-markør.
- [ ] **Step 4:** Kjør → PASS. Commit `feat(edge): variabel_info — on-demand variabeldetalj + kodelister (erstatter v2s picker-pass)`.

### Task 4: mikrodata-instruksen — `_lib/svar-instruks.ts`

**Files:**
- Create: `netlify/edge-functions/_lib/svar-instruks.ts`
- Test: `netlify/edge-functions/_lib/svar-instruks.test.ts`

**Interfaces:**
- Consumes: `buildCachedPrefix` (Task 2).
- Produces: `buildSvarSystem(origin: string, mode: GenMode): Promise<string>`; `RUN_CODE_TOOL`, `VARIABEL_INFO_TOOL` (tool-defs); `svarBudsjett(q: "fast"|"balanced"|"best"): {clientCalls: number, runCalls: number}`; `progressLabel(name, input): string`; `questionTurn(question: string, script?: string): string`.

- [ ] **Step 1: Failing tests.** (a) `buildSvarSystem` inneholder SYNTETISK-blokkens nøkkelsetning `"syntetiske"` og `"aldri presenteres som faktisk statistikk"`, (b) svarformatet inneholder `"Vurderinger og forslag"`, (c) `svarBudsjett("fast")` → `{clientCalls: 8, runCalls: 3}` osv. for alle tre, (d) run_code-instruksen nevner OK./FEIL-kontrakten, (e) mode `"python"` bygger uten kommando-referansen (arver prefiks-forskjellen). Mock fetch for prefiksen der det trengs (eller injiser prefiks-tekst — enklest: `buildSvarSystem` tar valgfri `deps: {prefix?: string}` for test).
- [ ] **Step 2:** Kjør → FAIL.
- [ ] **Step 3:** Implementer. `RUN_CODE_TOOL` kopieres fra askstats `svar-prompt.ts:1106-1115` med description tilpasset: «Kjør et komplett script i brukerens emulator-miljø (microdata-DSL, python eller r — modusblokken sier hvilket)…». `VARIABEL_INFO_TOOL`:

```ts
export const VARIABEL_INFO_TOOL = {
  name: "variabel_info",
  description: "Slå opp detaljer for registervariabler: full beskrivelse, type, gyldighetsperiode og kodeliste. Kall med eksakt variabelnavn, eller et søkeord for å finne kandidater.",
  input_schema: {
    type: "object",
    properties: { navn: { type: "string", description: "variabelnavn eller søkeord" } },
    required: ["navn"],
  },
};
```

  `buildSvarSystem` = prefiks (fra `buildCachedPrefix`) + LØKKE-INSTRUKS (tilpasset fra askstats §«Kjøring og sluttsvar (run_code)»: kjør HELE script, rett-og-kjør-igjen innen budsjett, skriv sluttsvar når output foreligger) + SYNTETISK-blokk (NY: dataene er syntetiske øvingsdata; metoden og tolkningsmåten er poenget; tall er illustrasjon og skal aldri presenteres som faktisk statistikk; si det eksplisitt i svaret der tall vises) + SVARFORMAT (kort svar først, deretter script-blokk, «Slik leser du utskriften», og til slutt «Vurderinger og forslag» — mekanisme-kandidater, forbehold, videre analyser — v2s SVARFORMAT_TILLEGG-arv). `progressLabel`: `run_code` → `"▶ Kjører scriptet …"`, `variabel_info` → `` `Slår opp ${input.navn} …` ``.
- [ ] **Step 4:** Kjør → PASS. Commit `feat(edge): svar-instruks — løkke-regler, syntetisk premiss og svarformat oppå kode-svar-prefiksen`.

### Task 5: `svar`-kallstedet i llm-choice

**Files:**
- Modify: `netlify/edge-functions/_lib/llm-choice.ts` (DEFAULTS + OVERRIDES)
- Test: `netlify/edge-functions/_lib/llm-choice.test.ts`

**Interfaces:**
- Produces: `CallSite`-verdien `"svar"`; env-override `SVAR_MODEL` (foran `ANTHROPIC_MODEL`).

- [ ] **Step 1: Failing test.** `chooseModel("svar", null, env)` → `{model:"claude-sonnet-5", effort:"high"}`; `SVAR_MODEL`-override vinner; kvalitet flytter modellen som for andre kallsteder.
- [ ] **Step 2:** FAIL → legg `"svar": { model: "claude-sonnet-5", effort: "high" }` i DEFAULTS og `"svar": ["SVAR_MODEL", "ANTHROPIC_MODEL"]` i override-lista (samme form som `data-svar`-oppføringene — les fila og speil).
- [ ] **Step 3:** PASS. Commit `feat(edge): svar-kallstedet i llm-choice (SVAR_MODEL-override)`.

### Task 6: `/api/svar`-endepunktet

**Files:**
- Create: `netlify/edge-functions/svar.ts`
- Create: `netlify/edge-functions/_lib/svar-resume.test.ts` (PAR-test validering+rekonstruksjon)
- Modify: `netlify.toml` (nytt `[[edge_functions]]`-innslag `svar` → `/api/svar`; gamle innslag står til Task 9)

**Interfaces:**
- Consumes: `runAgenticStream`/`runProviderAgenticStream` (urørt motor: `clientTools: ["run_code"]`, `maxRunCode`, `runResult`, `continueExtra`), `resolveLlm(request, body, "svar")`, `buildSvarSystem`, `RUN_CODE_TOOL`, `VARIABEL_INFO_TOOL`, `svarBudsjett`, `variabelInfo`, run-disiplin-settet (Task 1), `gate` fra auth.ts (`allowByok: true, allowLlmKey: true`, `maxBodyBytes: 2_000_000`).
- Produces: POST-kontrakt `{question, mode?, script?, quality?, provider?, resume?: {state, run_ok_calls}, run_result?}`; SSE-events `text|progress|continue|run_code|error`.

- [ ] **Step 1: Failing par-test.** Porter askstats mønster (`../askstat/netlify/edge-functions/_lib/svar-resume.test.ts` er malen — les den): eksporter `validResumeState` og `rebuildResumeState` fra `svar.ts`; test at et gyldig state-objekt med `pending` (inkl. `awaitingId`, `results`) passerer valideringen OG rekonstrueres felt-likt (`pending` kopieres som ETT objekt), og at ugyldige former (messages>400, turn>64, pending uten awaitingId) avvises. microdata-varianten har IKKE `getPackCalls`/`pdfVern`-feltene — dropp dem.
- [ ] **Step 2:** FAIL → skriv `svar.ts` med askstats `svar.ts` som strukturmal, minus ruter/packs/keys/discover/guides/probe/repair. Kjerne:

```ts
const gateResp = await gate(request, { endpoint: "svar", maxBodyBytes: MAX_BODY_BYTES, allowByok: true, allowLlmKey: true }, context);
if (gateResp) return gateResp;
const body = await request.json();  // try/catch → 400
const question = (body.question ?? "").trim();  // tom → 400
const mode = coerceMode(body.mode);             // definér i svar.ts:
// const coerceMode = (m: unknown): GenMode => (m === "python" || m === "r") ? m : "microdata";
const choice = resolveLlm(request, body, "svar");
if (choice instanceof Response) return choice;
const budsjett = svarBudsjett(coerceQuality(body.quality) ?? "balanced");
let runOkCalls = coerceRunOkCalls(body.resume?.run_ok_calls);
let runResultTilLopet = typeof body.run_result === "string" ? body.run_result.slice(0, 20_000) : undefined;
if (runResultTilLopet !== undefined && klassifiserRunResult(runResultTilLopet) === "ok") {
  runOkCalls++;
  if (runOkCalls === 1) runResultTilLopet = medPaaminnelse(runResultTilLopet);
}
const tools = filtrerRunCode([RUN_CODE_TOOL, VARIABEL_INFO_TOOL], runOkCalls);
const system = await buildSvarSystem(new URL(request.url).origin, mode);
const commonOpts = {
  system, userContent: questionTurn(question, body.script),
  tools, executeTool: (name, input) => name === "variabel_info"
    ? variabelInfo(new URL(request.url).origin, String((input as {navn?: unknown}).navn ?? ""))
    : Promise.reject(new Error(`ukjent verktøy ${name}`)),
  progressLabel, maxTokens: 8192,
  maxClientToolCalls: budsjett.clientCalls,
  clientTools: ["run_code"], maxRunCode: budsjett.runCalls,
  runResult: runResultTilLopet,
  resume: resumeState,          // fra validResumeState + rebuildResumeState
  continueExtra: () => ({ run_ok_calls: runOkCalls }),
};
```

  Provider-grenene speiler data-svar.ts:139-152 (`runProviderAgenticStream` med `makeOpenAiCompatTurn`/`makeOpenAiResponsesTurn`, `deps {timeoutMs: 180_000, retries: 1}`), else `runAgenticStream({ apiKey: choice.apiKey, model: choice.model, effort: choice.effort, ...commonOpts })` — les data-svar.ts og speil inpakkingen (SSE-headere, feilhåndtering med `upstreamErrorResponse`).
- [ ] **Step 3:** Par-test + `deno check *.ts _lib/*.ts` → PASS. `netlify.toml`: legg til `[[edge_functions]] function = "svar" / path = "/api/svar"`.
- [ ] **Step 4:** `diff ../askstat/netlify/edge-functions/_lib/anthropic.ts netlify/edge-functions/_lib/anthropic.ts` → tom (kontrakten holdt).
- [ ] **Step 5:** Commit `feat(edge): /api/svar — samlet agentisk løp med run_code + variabel_info`.

### Task 7: run_result-formatteringen (klient, ren regel)

**Files:**
- Create: `js/run-result.js`
- Test: `tests/js/run-result.test.js`

**Interfaces:**
- Produces: `formatRunResult({ok: boolean, output: string}): string` — byte-kontrakten (`"OK. OUTPUT (truncated):\n"`-prefiks / `"FEIL:\n"`), cap 6000 tegn med `\n[…avkortet]`-hale. Global: `window.RunResult.format`.

- [ ] **Step 1: Failing test** (node, samme dual-mønster som `js/ai-credential.js` — IIFE + `module.exports`):

```js
const { formatRunResult } = require('../../js/run-result.js');
test('suksess får OK.-prefikset klassifisereren krever', () => {
  assert.ok(formatRunResult({ ok: true, output: 'x' }).startsWith('OK. OUTPUT (truncated):\n'));
});
test('feil får FEIL:-prefiks', () => {
  assert.ok(formatRunResult({ ok: false, output: 'Traceback' }).startsWith('FEIL:\n'));
});
test('lang output cappes på 6000 med avkortet-markør', () => {
  const s = formatRunResult({ ok: true, output: 'a'.repeat(9000) });
  assert.ok(s.length < 6200 && s.includes('avkortet'));
});
test('tom output blir eksplisitt tekst, ikke tom streng', () => {
  assert.ok(formatRunResult({ ok: true, output: '' }).includes('(ingen tekst-output)'));
});
```

- [ ] **Step 2:** FAIL → implementer (trunker OUTPUT-delen, ikke prefikset). **Step 3:** PASS.
- [ ] **Step 4:** `index.html`: `<script src="js/run-result.js"></script>` rett før ai-transport-include; og ved `window.mdIsScriptRunning` (index.html:8913) legg motor-høsteren:

```js
window.mdRunHarvest = function () {
  const errEl = document.getElementById('outputArea')?.querySelector('pre.error');
  if (errEl) return { ok: false, output: errEl.textContent || '' };
  return { ok: true, output: (typeof lastOutput === 'string' ? lastOutput : '') };
};
```

  (`textContent`, ALDRI `innerText` — layout-uavhengig; `lastOutput` er motor-sannheten for suksess-output, index.html:4278.)
- [ ] **Step 5:** `node --test "tests/js/*.test.js"` alle grønne. Commit `feat(klient): run_result-formattering + motor-høster (OK./FEIL-bytekontrakten)`.

### Task 8: klientløkka — én Send

**Files:**
- Modify: `js/ai-chat.js` (ny `runSvar` + `sendSvarMessage`; SLETT `runFastQuery`, `runFastQueryV2`, `streamKodeSvarV2`, `runWebAnswer`, `webAnswerWithRepair`, `extractWebScriptBlock` hvis kun web-veien brukte den — behold `runInterpretQuery` (tolk-knappen), `confirmAutoRun`, `insertScriptIntoEditor`, `runScriptAndCaptureError`-ventelogikken gjenbrukes i kjøre-armen)
- Modify: `index.html` (én Send-knapp: `aiSendFastBtn`/`aiSendWebBtn` → én `aiSendBtn`; grundighets-tekst i AI-innstillingene)

**Interfaces:**
- Consumes: `AiTransport.postWithRetry`/`describeError` (endpoint `'svar'`), `RunResult.format`, `window.mdRunHarvest`, eksisterende `edgeAuthHeaders`/`edgeBodyExtras`/`consumeSse`/`confirmAutoRun`.

- [ ] **Step 1:** Skriv `runSvar(question, thinkingNode, signal)` — kopier `runWebAnswer`s hop-løkke-form (den er riktig), med disse endringene: URL `'/api/svar'`; body `{question, mode, script (som i dag når avkrysset), quality: aiQuality(), provider, resume, run_result}`; event-håndtering utvidet med run_code-armen (mønster fra askstats klient, `../askstat/js/ai-chat.js:760-800`):

```js
let runResult = null, confirmed = false;
for (let hop = 0; ; hop++) {
  if (hop > 40) throw new Error(T('Avbrutt: svaret ble ikke ferdig etter 40 fortsettelses-runder.'));
  const resp = await AiTransport.postWithRetry('/api/svar', { method: 'POST', headers: edgeAuthHeaders(),
    body: JSON.stringify(Object.assign({ question, mode, script: includeScript ? scrubScript(dom.scriptInput.value) : undefined,
      resume: resume || undefined, run_result: runResult == null ? undefined : runResult }, edgeBodyExtras())), signal })
    .catch((e) => rethrowDescribed(e, 'svar', 'request', hop));
  runResult = null;
  // 401/403/!ok-sjekker som i runWebAnswer i dag
  let cont = null, pendingRun = null;
  await consumeSse(resp, (ev) => {
    if (ev.type === 'continue') { cont = { state: ev.state, run_ok_calls: ev.run_ok_calls }; return; }
    if (ev.type === 'run_code') { pendingRun = ev.script || ''; return; }
    handleSvarEvent(ev);   // text/progress/error — som handleWebEvent i dag, minus sources
  }).catch((e) => rethrowDescribed(e, 'svar', 'stream', hop));
  if (pendingRun != null) {
    insertScriptIntoEditor(pendingRun);
    if (!confirmed) { const ok = await confirmAutoRun(); if (!ok) return; confirmed = true; }
    const err = await runScriptAndCaptureError();          // venter på motoren, klikker Kjør
    const h = (typeof window.mdRunHarvest === 'function') ? window.mdRunHarvest() : { ok: !err, output: err || '' };
    runResult = RunResult.format(err ? { ok: false, output: err } : h);
    if (!h.ok || err) { /* FEIL-linja: */ const fl = String(err || h.output).split('\n')[0].slice(0, 160);
      if (fl) handleSvarEvent({ type: 'progress', text: '⚠️ Kjøring feilet: ' + fl }); }
    resume = cont; continue;   // run_code ender alltid invokasjonen med continue
  }
  if (!cont) break;
  resume = cont;
}
```

- [ ] **Step 2:** `sendSvarMessage()` = dagens `sendMessage`-boilerplate (credential-gate, user-boble, thinking-node, abort-knapp) men dispatch til `runSvar`. Koble til den ENE Send-knappen. Slett de gamle funksjonene og deres kallpunkter (grep `runFastQuery\|runWebAnswer\|aiSendFastBtn\|aiSendWebBtn` til null treff i ai-chat.js utover det nye).
- [ ] **Step 3:** `index.html`: én Send-knapp (id `aiSendBtn`), fjern ⚡/⚗-splitten og deres tooltips; i AI-innstillingenes kvalitetsvelger: oppdater hjelpeteksten til å si at nivået også styrer hvor mange kjøringer/verktøykall modellen får (Rask 8/3 · Balansert 12/4 · Grundig 20/6).
- [ ] **Step 4:** `node --check js/ai-chat.js` + `node --test "tests/js/*.test.js"` grønne; `grep -c "kode-svar\|data-svar" js/ai-chat.js` → kun tolk/dm-referanser igjen. NB: specens «klient-rundtur mot mocket SSE»-test dekkes IKKE her — ai-chat.js er bevisst ikke node-lastbar (lærdom 4dd2864); rundturen verifiseres av de rene regel-testene (run-result, ai-transport, run-disiplin, par-testen) + ende-til-ende-smoken i Task 11.
- [ ] **Step 5:** Commit `feat(klient): samlet Send — runSvar-løkka med run_code-rundtur erstatter fast/web-veiene`.

### Task 9: sletting av de gamle endepunktene

**Files:**
- Delete: `netlify/edge-functions/kode-svar.ts`, `kode-svar-v2.ts`, `data-svar.ts`
- Delete/Modify: tilhørende tester (`_lib/data-svar-prompt.test.ts` + data-svar-prompt.ts slettes; `_lib/variable-picker.ts`+test slettes (v2s picker); tools `search-catalog`/`table-metadata`/`probe` BEHOLDES i `_lib/tools/` med test (spec: kan gjeninnføres) — men fjern importene deres fra slettede filer)
- Modify: `netlify.toml` (fjern kode-svar/kode-svar-v2/data-svar-innslagene), `netlify/edge-functions/prompts/kode-svar.md` og `data-svar.md` (header-notis: «Endepunktet er erstattet av /api/svar 2026-08-28; prefiks-delene lever videre i _lib/prefiks.ts» — kildedokumentene BEHOLDES som synk-anker mot prompts.py), `.env.example` (DATA_SVAR_MODEL → SVAR_MODEL), `.env` (samme), README.md + `netlify/edge-functions/README.md` (endepunktlista).

- [ ] **Step 1:** Slett filene; `grep -rn "kode-svar\|data-svar" netlify/ --include="*.ts"` → null treff utenom kommentarer/prompts-notiser. VIKTIG: `kode-svar-v2.ts`s codelist-fokusblokk er alt erstattet av variabel_info; ingenting skal reddes derfra.
- [ ] **Step 2:** `deno check *.ts _lib/*.ts && deno test --allow-all _lib/` → grønt (minus de 6 kjente pre-eksisterende røde i data-directives/data-loader — de er URELATERT klient-js-testet i deno? NB: de ligger i _lib og VAR røde før — status quo aksepteres, dokumentert i memory).
- [ ] **Step 3:** `netlify env:unset DATA_SVAR_MODEL` (tom uansett). Commit `feat!: kode-svar/v2/data-svar slettet — /api/svar er eneste chat-vei`.

### Task 10: evalsett

**Files:**
- Create: `docs/eval/svar-evalsett.md`

- [ ] **Step 1:** Skriv 10 spørsmål med FASIT-kriterier, minst: rent forklaringsspørsmål (ingen kjøring forventet), enkel deskriptiv analyse (én kjøring, tall omtalt som syntetiske), analyse som krever variabel_info-oppslag (kodeliste), spørsmål der første script feiler (iterasjon forventes), python-modus-spørsmål, og ett der ærlig «finnes ikke i registrene»-svar er fasit. Format som `docs/eval/data-svar-evalsett.md` (les den først og speil kolonnene).
- [ ] **Step 2:** Commit `docs: evalsett for /api/svar — kjøres før promptendringer deployes`.

### Task 11: full verifisering + prod-smoke

- [ ] **Step 1:** Full suite: `cd netlify/edge-functions && deno check *.ts _lib/*.ts && deno test --allow-all _lib/`; `node --test "tests/js/*.test.js"`; `node --check js/ai-chat.js`.
- [ ] **Step 2:** Push → vent på Netlify-deploy ready (`netlify api listSiteDeploys` poll).
- [ ] **Step 3:** Prod-smoke mot `https://microstat.melberg.app/api/svar` med delt passord: POST `{"question":"Hva er gjennomsnittsinntekten etter kjønn?","mode":"microdata","quality":"fast"}` → forvent SSE med `progress`/`text` og enten `run_code`-event eller rent svar; deretter samme med personlig passord. Kjør evalsettets to første spørsmål manuelt i appen (Hans eller browser hvis tilgjengelig) — run_code-rundturen må sees ende-til-ende i ekte nettleser før saken lukkes.
- [ ] **Step 4:** Commit ev. smoke-fikser; sluttrapport med «pushet og live på microstat.melberg.app».
