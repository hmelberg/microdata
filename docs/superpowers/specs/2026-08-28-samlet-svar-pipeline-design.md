# Samlet svar-pipeline for microdata — design

**Dato:** 2026-08-28
**Status:** Godkjent retning (designdiskusjon med Hans 2026-08-28); spec til gjennomsyn.
**Gjelder:** `microdata/` alene. Deler porteres fra `askstat/`; filer som kopieres
ordrett merkes COPIED og skal ikke re-styles (holder `git cherry-pick` mellom
søsken-repoene i live — samme regel som multi-provider-runden).

## Mål

Én Send-knapp og ETT agentisk løp der modellen skriver microdata-script, får dem
**kjørt i emulatoren** via et klientutført `run_code`-verktøy, ser de faktiske
resultatene og itererer til et begrunnet svar. Dette er askstats endestasjon
(`/api/svar`, spec 2026-07-29 der) overført til microdata.

Dagens tre chat-veier — `kode-svar`, `kode-svar-v2` (⚡ fast) og `data-svar`
(⚗ web) — **erstattes og slettes** (ingen bakoverkompat-prinsippet: ingen brukere
å frede). Tolkning av kjøringer skjer i løpet selv i stedet for som eget klikk.

Gevinsten over dagens flyt: fast-veien validerer i dag bare *strukturelt* på
syntetiske data — modellen ser aldri hva scriptet faktisk gir, unntatt
feilmeldinger i reparasjonsrunder, og tolk er et eget knappetrykk. Med løkka ser
modellen utskriften og svarer på spørsmålet, ikke bare på «lag et script».

## Ikke-mål

- **`dm-vurder`** (personvern-vurderingen): urørt.
- **`tolk-resultat`-endepunktet beholdes** for output-panelets Tolk-knapp — den er
  egen UX utenfor chatten. Bare *chat*-tolkingen flytter inn i løpet.
- **Ruter-pass** (askstats `ask-ruter`): utsatt. Én systemprompt; modellen velger
  selv mellom å forklare, generere og kjøre.
- **`get_pack`/kildepakker, kontoer, lokale modeller**: som før — finnes ikke /
  utsatt i microdata.
- **Egen dybdemeny**: bevisst utelatt. Askstat prøvde og fjernet den
  (deep-only-runden 2026-08-05); grundighet styres av kvalitetsvelgeren (§3).

## Bakgrunn

microdata har allerede askstats transport-skjelett: `runAgenticStream` med
continue/resume-protokoll (én modell-turn per edge-invokasjon, state re-POSTes),
verktøybudsjett (`clientCalls`), serverutførte verktøy (`search_catalog`,
`table_metadata`, `probe`) og hostet websøk — men **uten** `pending`-tilstanden
som lar et verktøy utføres av KLIENTEN mellom to invokasjoner. Det er den biten
`run_code` trenger, og den finnes ferdig i askstats `anthropic.ts`/`svar.ts`.

Klienten har på sin side allerede: auto-run med bekreftelse + 3 reparasjonsrunder
mot den lokale motoren (`webAnswerWithRepair`), script-innsetting i editor, og
(fra 2026-08-28) transportlaget `js/ai-transport.js` med retry og
endepunkt+fase-navngitte feil.

## Design

### 1. Endepunkt og protokoll

Ny `netlify/edge-functions/svar.ts` portert fra askstats — med mikrodata-tilpasset
systemprompt og verktøysett. SSE-hendelser som i askstat: `text`, `progress`,
`continue {state, probed}`, `run_code {script}`, `sources`, `error`.
Rundtur for kjøring: `run_code`-event → invokasjonen ender med `continue` →
klienten kjører scriptet → re-POST med `resume` + `run_result {ok, result}`.

`pending`-utvidelsen av `AgenticResumeState` porteres til microdatas
`anthropic.ts`. **Valideringen (`validResumeState`) og rekonstruksjonen
(`rebuildResumeState`) par-testes** — askstats review-funn 2026-08-06 #1: den
eneste garantien for at et resume-objekt som passerer valideringen også
rekonstrueres riktig, er å teste paret. `run-disiplin.ts` (klassifisering av
kjøreresultater, påminnelses-injeksjon, run_ok-telling) porteres som COPIED der
den ikke må tilpasses.

### 2. Verktøyene — microdatas domene, ikke askstats

Nøkkelinnsikt (Hans, 2026-08-28): askstats vanskelige problem er å FINNE riktige
data. Det problemet finnes ikke her — vi vet at dataene er microdata-registeret,
og vi har rik metadata (`variable_metadata.json`, 652 KB + `codelists/`).
Verktøysettet speiler det:

| Verktøy | Utføres | Status |
|---|---|---|
| `run_code` | **Klienten** (emulatoren) | NY — porteres fra askstat |
| `variabel_info` | Edge (over `variable_metadata.json` + `codelists/`, hentet samme-origin med in-isolat-cache) | NY |
| websøk, `search_catalog`, `table_metadata`, `probe` | — | **UT av løkka** (askstats finn-data-verktøy; koden blir liggende i `_lib` — se Utsatt) |

`variabel_info` gir on-demand detaljer (typer, kodeverk, gyldighetsperioder) for
navngitte eller søkte variabler, og **erstatter v2s eget variabelvelger-pass** —
modellen slår opp når den trenger det i stedet for at et Haiku-pass gjetter
utvalget på forhånd. Systemprompten bærer som i dag de kuraterte referansene
(`katalog-taksonomi-reference.md` — generert fra metadataen, `nokkelvariabler-
reference.md`, syntaks/funksjoner) i en cachet systemblokk (1h-TTL-støtten i
`streamAnthropic` finnes allerede); full metadata er for stor til å embeddes rått.

### 3. Kvalitetsvelgeren styrer alt («hvor grundig»)

Én meny — dagens Rask/Balansert/Best — styrer BÅDE modell/effort OG
løkkebudsjett. Ingen meny-matrise:

| Nivå | Modell/effort (som i dag) | Verktøykall | run_code |
|---|---|---|---|
| Rask | claude-haiku-4-5, uten effort | 8 | 3 |
| Balansert | claude-sonnet-5, high | 12 | 4 |
| Best («Grundig») | claude-opus-5, xhigh | 20 | 6 |

Balansert-tallene er askstats felt-testede deep-verdier. Env-overstyringene
består; `DATA_SVAR_MODEL` omdøpes til `SVAR_MODEL` (data-svar dør). UI-teksten
for nivåene kan justeres til å kommunisere grundighet, ikke bare modell.

UI-modellen er drawcasts (Hans, 2026-08-28): ÉN åpnebar meny som styrer flere
ting — microdatas eksisterende AI-innstillinger (legitimasjon, leverandør,
grundighet) er allerede den menyen; grundighetsvelgeren bor der, ikke som egen
knapperad i chatvinduet.

### 4. Kjøring og høsting i emulatoren

- Scriptet settes **synlig inn i editoren** før kjøring (brukeren ser og beholder
  det), og kjøres slik brukeren selv ville kjørt: samme modus, **vern på**.
- **Motor-side resultatfangst** — askstat KODESAK A (d45444d der): utskrift hentes
  fra kjøremotoren, ALDRI fra DOM-`innerText` (som er tom når panelet ikke er
  synlig). microdatas motpart bygges der scriptkjøringen alt bor
  (`runScriptAndCaptureError`-familien utvides til å returnere output, ikke bare
  feil).
- `run_result.result` trunkeres (størrelses-cap ~6000 tegn) med eksplisitt
  «…avkortet»-markør.
- **Bekreftelse:** første `run_code` per spørsmål krever dagens kjør-bekreftelse
  (`md_ai_autorun=1` hopper over); resten av rundene går automatisk — samme
  kontrakt som dagens reparasjonsløkke.
- **FEIL-linja i prosessloggen** porteres (askstat-spec 2026-08-15 §1: tre
  blinddiagnose-runder før kjørefeil ble synlige for mennesker).

### 5. Det syntetiske premisset (må skrives nytt — kan ikke kopieres)

Emulatoren kjører på syntetiske data. Systemprompten sier det eksplisitt, og
svarformatet krever innramming deretter: **metoden er poenget** («slik gjør du
det på microdata.no, slik leser du utskriften»), tallene er illustrasjon og skal
aldri presenteres som faktisk statistikk. Dette er samtidig grunnen til at
resultat-deling med modellen er personvernmessig trivielt her, i motsetning til i
safestat.

### 6. Klient og UI

- Én Send-knapp; ⚡/⚗-splitten fjernes. Tråden beholder prosessloggen
  (verktøylinjer, FEIL-linjer, kjørte kilder).
- `js/ai-transport.js` gjelder uendret: per-hopp `postWithRetry`, feil navngir
  endepunkt/fase/runde.
- Slettes: `kode-svar.ts`, `kode-svar-v2.ts`, `data-svar.ts`, klientveiene
  `runFastQuery`/`runFastQueryV2`/`runWebAnswer`-navnet (webAnswerWithRepair-
  logikken gjenbrukes som løkkas kjøre-arm), tilhørende tester ryddes/flyttes.
  Variabelvelger-passet fra v2 utgår: `variabel_info`-verktøyet (§2) + kjøring
  dekker jobben.

### 7. Testing

TDD hele veien. Minimum: par-test av resume-validering/-rekonstruksjon,
run-disiplin-testene portert, budsjett-uttømming (verktøy og run_code hver for
seg), avbrutt-og-gjenopptatt løp, syntetisk-premiss-instruksen til stede i
prompten, motor-side fangst med usynlig panel, og klient-rundturen
run_code→run_result mot en mocket SSE-strøm.

## Utsatt

Ruter-pass, dybdemeny, get_pack/kildepakker, lokale modeller, safestat-port av
løkka (annet vern-regime), og **ekstern-data-verktøyene i løkka**
(websøk/search_catalog/table_metadata/probe): de løser askstats finn-data-
problem, ikke microdatas. `_lib/tools/`-koden beholdes og kan gjeninnføres som
verktøy hvis «hent eksterne data inn i script» viser seg savnet.
