# Roadmap — safestat/openstat

*Levende dokument. Oppdatert 2026-07-09 (kveld). Punktene er ikke forpliktelser, men
prioritert idéliste. Kilder: designdok/reviews fra jamovi 2.0 fase 1–3
(docs/PLAN_jamovi_*.md, docs/jamovi-validation.md) + løpende samtaler og Hans' testing.*

## jamovi-modus — gjenstående arbeid

**Analyser (24 av ~26 i menyen; disse to gjenstår):**
- [ ] **Repeated Measures ANOVA** (anovaRM) — den tyngste gjenstående biten: krever
      RM-design-UI (definer faktorer med navn+nivåer via `rm`, tilordne målekolonner
      til celler via `rmCells`) + rmTerms/bsTerms (modellbyggeren gjenbrukes),
      kontraster og utvidet postHoc-form. Estimat: egen dedikert økt.
- [ ] **CFA** — faktor-definisjons-UI (`factors` = Array of Group {label, vars}:
      navngi latente faktorer og tilordne variabler; ligner rolleboksene med
      redigerbart navn + «legg til faktor»-knapp) + `resCov` (Pairs, finnes).
      FØRSTESTEG: lavaan-røyktest i webR (kjøring er utestet; lasting virker).
      Estimat: én økt, forutsatt at lavaan kjører.

**Figurer (utsatt av Hans 9/7 — tas når han sier fra):**
- [ ] Bygge nyere `scatr` fra jamovi sitt GitHub-repo som wasm (rwasm-verktøyet;
      finnes IKKE ferdigbygget på r-universe — verifisert). Gir Bar/Box/Histogram/
      Line/Pareto som egne analyser med alle ~60 stilopsjonene (error bars, titler,
      akser, legend, fonter). Krever eget wasm-byggmiljø (emscripten) — den tyngste
      enkeltjobben i køen.
- [ ] Pareto Plot tilbake i menyen (avhenger av punktet over)

**Validering:**
- [ ] Manuell side-om-side-validering av TALLENE mot ekte jamovi-appen —
      sjekklisten med 9 rader står klar i docs/jamovi-validation.md (UX er testet
      av Hans 9/7; den numeriske gjennomgangen gjenstår)

**Teknisk gjeld (fra reviewene, småting):**
- [ ] Skille pliktige/valgfrie roller i «Velg variabler»-hintet (i dag kan hintet
      maskere reelle R-feil når en valgfri rolle står tom)
- [ ] `refLevels`: feilet nivå-henting gir permanent deaktivert nedtrekksliste
      uten retry (kun ved motorfeil; lav prioritet)
- [ ] NMXList: tømt valg sender `character(0)` — live-verifisert kun for
      jmv::mancova; de 6 andre analysene med NMXList deler antakelsen uverifisert
- [ ] Bilde-rekkefølgenøkler i `.jmv_serialize` (i dag ordre-basert matching mot
      captureGraphics; robust nok, men skjørt ved fremtidige jmv-endringer)
- [ ] `console.warn` ved bilde-underskudd i renderJmvResults (feilsøkingshjelp)
- [ ] Bayes factor-opsjonene (bf/bfPrior): krever wasm-bygg eller stub av `deSolve`
- [ ] Måle minnebruk på svake maskiner; `jamovi_v1`/«Jamovi light» er nødbrems

**Avklaringer (Hans bestemmer):**
- [ ] Output-rens ved modusbytte: jamovi-resultater tømmes også ved
      jamovi→python→jamovi (konsekvens av ønsket rensing ved inngang).
      Alternativ: bevare jamovi-resultatene over en tur innom andre moduser.
- [ ] Modus-gjenoppretting ved sidelast: appen kan i dag ikke starte rett i
      jamovi-modus (lazy-registrering; faller tilbake til standardmodus).
      Ville kreve at MODE_MODULES-moduler lastes før restoreEditorMode.

**Ferdig (jamovi fase 1–3, alt merget 2026-07-09):** ekte jmv 2.7.7 i webR (pinnet
v0.6.0, SW-cachet); 24 analyser inkl. ANCOVA/MANCOVA/Friedman/Log-Linear/Factor-
gruppen; u.yaml-genererte dialoger m/ grupper, grid, nøsting, enable-avhengigheter,
NMXList-checkparts og radiogrupper; modellbygger (interaksjoner/post hoc/blocks);
refLevels-velger m/ nivåer fra data; live-oppdatering uten Kjør-knapp; skjult
toppmeny m/ bryter; ikoner + finpolish; «Jamovi light» (v1) som egen modus;
websocket-stub for contTables; kopier-knapp på tabeller og figurer; datasett-synk
på tvers av moduser; output-rens ved inngang.

## AI-assistenten

### Evalsettet — status og neste steg (oppdatert 2026-08-30)

Fire av ti spørsmål er kjørt gjennom appens egen motor
(`node scripts/eval-motor.mjs`, som driver en ekte nettleser så scriptene
faktisk kjøres). Alle fire bestod:

| # | Tid | Observasjon |
|---|-----|-------------|
| 1 | 14 s | Ingen kjøring, ingen oppslag — kriterium 5s unntak oppfylt presist |
| 2 | 34 s | Én kjøring; syntetisk-forbeholdet i andre linje, før første tall |
| 5 | 120 s | Kjørte, slo opp `BEFOLKNING_KOMMNR_FORMELL`, kjørte igjen — verktøykall MIDT i løpet som svar på hva utskriften viste |
| 10 | 37 s | Leste scriptet i editoren, forklarte regelen bak feilen (Akkumulert-variabler tar året som importdato), viste rettelsen |

Kriteriene 1, 2, 4, 5, 6 og 7 er dermed observert i praksis.

- [ ] **Kjør 3, 4, 6, 7, 8 og 9** — ikke kjørt ennå. #9 (ærlighetstesten: «hvor
      mange har byttet kjønn?») og #6 (python-modus) er de mest informative.
      Koster reelle penger; ~2-3 min per analysespørsmål på `balanced`.

- [ ] **Kriterium 3 er ALDRI utøvt** — at en kjørefeil vises som ⚠️ og at
      modellen retter og kjører på nytt. Grunnen er lærerik: modellen er god nok
      til å unngå feilene vi klarer å konstruere. Fixturen til #10
      (`docs/eval/fixtures/feilende-script.txt`, årssuffiks-fella) ble oppdaget
      ved LESING — modellen skrev korrigert script direkte og kjørte det én gang
      uten feil.
      Skal reparasjonsrunden utøves, må feilen være usynlig i koden og først
      vise seg mot dataene: en variabel som finnes men har feil temporalitet, en
      merge på en nøkkel som ikke matcher, eller et filter som tømmer utvalget.
      Uten en slik fixture vet vi ikke om reparasjonsløkka konvergerer.

- [ ] **`MAX_OUTPUT = 6000` i `js/run-result.js` kappet et halvferdig svar.**
      Målt 2026-08-29: en kjøring med to modeller (far/mor) fikk mor-modellens
      koeffisienter klippet bort før modellen så dem. Den nektet ærlig å gjette
      på tallene — riktig oppførsel, men brukeren satt igjen med et halvt svar.
      Vurder å heve grensen, eller å instruere om én modell per kjøring.


- [ ] **Auto-retting for python- og r-modus i v2-flyten** (i dag kun microdata).
      Backend er klar (`kode-svar-v2` tar `prior_script`+`errors` uansett modus);
      det som mangler er klientvalidator. To nivåer:
      - Nivå 1 (liten jobb, start her — python først): syntakssjekk via
        `compile()` i Pyodide / `parse()` i webR + kolonnenavn-sjekk mot aktivt
        datasett (`lastDatasetInfo`). Flytt `if (mode === 'microdata')`-grenen i
        `runFastQueryV2` til en modus-dispatch.
      - Nivå 2 (senere, hvis nivå 1 ikke fanger nok): sandkasse-prøvekjøring mot
        kopi av aktivt datasett med timeout; send runtime-feilen til
        reparasjonsrunden. Utfordringer: bivirkninger, nettkall, kjøretid.
- [ ] Vurdere Send⚗︎-flyten (v2) også for openstat-brukere på ikke-micro-URL-er
      (i dag går de til data-svar som er admin-gated — bevisst valg 9/7, men verdt
      å revurdere hvis vanlige brukere trenger AI-hjelp uten egen nøkkel)

## Pakkeinstallasjon (python/r)

*Status i dag: autoinstallasjon er PÅ i begge språk — Python: `loadPackagesFromImports`
+ micropip-fallback per import (index.html preRun); R: `library()`-overstyring som
kjører `webr::install()`. Service workeren cacher pakke-hostene (offline etter første gang).*

Mål: brukeren skal kunne installere alt fra Pyodide-wheels til ting man kan
prøve fra PyPI eller GitHub. Nivåene:

- [ ] **`# requires:`-direktiv** (husets direktiv-stil à la `# load`) med:
      - versjonspinning (`plotnine==0.13`)
      - alias-kart for navne-mismatch (`sklearn`→scikit-learn, `PIL`→pillow, `cv2`→opencv)
      - eksplisitte kilder, se nivåene under
- [ ] **Python-kilder**, i økende dristighet:
      1. Pyodide-bundlede pakker (auto, virker i dag)
      2. PyPI rene Python-wheels via micropip (auto, virker i dag)
      3. Wheel-URL: `micropip.install('https://…/pakke.whl')` — inkl. wheels fra
         GitHub-releases (raw/objects.githubusercontent har CORS)
      4. GitHub-repo uten wheel (kun ren Python): hent zip → `pyodide.unpackArchive`
         → sys.path; direktivsyntaks f.eks. `# requires: github:bruker/repo`
      (Grense: pakker med ubygget C/Fortran kan ikke installeres i nettleseren.)
- [ ] **R-kilder**:
      1. repo.r-wasm.org-binærer (auto, virker i dag)
      2. **r-universe**: nesten alle CRAN- og GitHub-R-pakker finnes som wasm-binærer
         der — `webr::install(pkg, repos='https://<bruker>.r-universe.dev')`;
         direktivet kan ta `bruker/repo` og utlede universe-URL-en
      3. Egenbygde wasm-pakker med rwasm (som planlagt for nyere scatr)
      4. `require()`/`pkg::` trigges ikke av dagens `library()`-overstyring — dekkes
         av direktivet
- [ ] **`!pip install X`-høflighet**: preprosesser Jupyter-vane-linjer til
      micropip-kall (eller vis vennlig melding om at import auto-installerer)
- [ ] Tydelig feilmelding når en pakke ikke finnes som wasm (med peker til
      hva som faktisk støttes)

## Flernivåanalyse (regress-mml) — å tenke på

Implementert 2026-08-30 mot microdata.no sin beskrivelse
(https://www.microdata.no/ny-analysefunksjonalitet-flernivaanalyse/ og
manualens §regress-mml). Modellen (MixedLM, REML, nøstede tilfeldige
konstantledd, høyeste nivå først) og statistikkblokken (Antall obs, Log
likelihood, LR-test mot OLS, Wald coef, Wald total, N/min/maks/gjennomsnitt
per gruppevariabel, Random Effects Variance) følger beskrivelsen.

- [ ] **Rådene om valg av gruppevariabel bør nå brukeren tidligere enn i
      hjelpeteksten.** microdata.no gir fem kriterier: teoretisk mening,
      hierarki, variasjon mellom OG innenfor grupper, gruppestørrelse, og
      ingen overlapp (overlapp krever kryssede effekter, som kommandoen ikke
      støtter). De ligger nå i `command_help.js`. Vurder: en advarsel i
      outputen når en gruppe er svært liten, eller når en gruppevariabel har
      nesten ingen varians mellom grupper — det er da modellen er verdiløs,
      og det er ikke synlig for en nybegynner.
- [ ] **Forarbeidet er en egen arbeidsflyt.** `boxplot lønn, by(fylke)`,
      `histogram lønn, by(fylke)` og `tabulate fylke, summarize(lønn) std`
      er det microdata.no anbefaler før man velger gruppevariabel, og
      `regress` med samme variabler er ettnivå-referansen. Vurder å foreslå
      denne sekvensen i AI-prompten, eller som et eksempelskript.
- [ ] **LR-testen er vår tolkning, ikke verifisert mot microdata.no.**
      REML-loglikelihood kan ikke sammenliknes med OLS sin ML-verdi, så
      OLS-referansen regnes analytisk (`_reml_llf_ols`, verifisert mot
      MixedLM på data uten gruppeeffekt). Vi vet ikke om microdata.no gjør
      det på samme måte — sammenlign mot ekte output når noen har tilgang.
      Merk også at LR-testen på variansledd er på grensen av
      parameterrommet, så p-verdien er konservativ.
- [ ] **Wald coef teller control()-variablene med** blant
      forklaringsvariablene. Det er den rimelige lesningen av «df = antall
      forklaringsvariabler», men er ikke bekreftet.
- [ ] **Kryssede effekter** støttes ikke av microdata.no i dag, og ikke av
      oss. Hvis de åpner for det, er `VCSpec` allerede veien inn.
- [ ] **`control()` finnes nå for `regress` og `regress-mml`.** Andre
      regresjonskommandoer avviser den høyt i stedet for å ignorere den
      stille. Sjekk om microdata.no faktisk støtter den bredere.

## Diverse / uavklart

- [ ] Pandas-basert GUI som egen modus (Hans' idé — holdes adskilt fra
      jamovi-modus, som skal forbli tro mot ekte jamovi/R)
- [ ] «Kjør»-knappen reinitialiserer Python-tolken hver gang (modus-uavhengig,
      eldre oppførsel) — datasett laget i jamovi overlever bytte til python-modus,
      men ikke et nytt «Kjør»-trykk der. Vurder varmere tolk-gjenbruk.
