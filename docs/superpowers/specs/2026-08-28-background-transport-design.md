# Background-transport for /api/svar — design

**Dato:** 2026-08-28
**Status:** godkjent av Hans (brainstorming), klar for implementasjonsplan
**Erstatter:** «Background-transport for dype turer» under *Utsatt* i
`2026-08-28-samlet-svar-pipeline-design.md`

## 1. Problemet

To symptomer, som brukeren opplevde som «den raske modellen er en helt annen
app enn den balanserte»:

1. **60-sekundersveggen.** Netlify kutter HVER synkron invokasjon — edge som
   vanlig funksjon — hardt ved ~60 s. Målt 2026-08-28 med et
   tick-strøm-diagnoseendepunkt: ren utstrømming kuttet ved 60,2 s.
   Heartbeats hjelper ikke. Én lang modelltur sprenger taket og gir
   «Error in input stream». Dagens lindring er en 50 s-frist per tur som gjør
   kuttet om til en forklart feilmelding — den fjerner ikke årsaken.
2. **Stillhet under tenkefasen.** Brukeren ser ingenting i 26–31 s.

### 1.1 Målt grunnlag for stillheten (steg 0, 2026-08-28)

Tre direkte prober mot `claude-sonnet-5`:

| Konfigurasjon | Thinking-blokk | `thinking_delta` | Tenketegn | Første tekst |
|---|---|---|---|---|
| `output_config.effort: medium` | ingen | – | – | **1,12 s** |
| `output_config.effort: high` | ja | 1 stk @ 26,47 s | **0** | 26,47 s |
| `thinking:{type:adaptive}` + `high` | ja | 1 stk @ 31,05 s | **0** | 31,09 s |

**Konklusjon:** tenkingen er kryptert. API-et sender signaturen, aldri lesbar
tekst, og ingenting underveis. `thinking.type.enabled` avvises av modellen
(400: bruk `adaptive` + `output_config.effort`).

Dette **avlyser** planen om å strømme tenketeksten i et sammenfoldet panel —
det finnes ingen tekst å vise. Det korrigerer også en tidligere hypotese: at
`anthropic.ts:477` bare videresender `text_delta` er sant, men ikke bindende
årsak. Stillheten oppstår oppstrøms.

Samtidig viser `medium`-raden at effort er **adaptivt**: modellen valgte å ikke
tenke, og strømmet fra 1,12 s. Derfor var «Balansert» ustabil — noen ganger
øyeblikkelig, noen ganger 30 s stum — framfor jevnt treg.

## 2. Mål og ikke-mål

**Mål**
- Ingen forespørsel i pipelinen kan lenger kuttes av plattformtaket.
- Modellturer får inntil 15 min (background-funksjonens budsjett).
- Brukeren får synlig, ekte respons innen ~2 s på alle kvalitetsnivåer.
- SSE-event-kontrakten mot `ai-chat.js` står uendret.

**Ikke-mål**
- Ingen endring i prompt, verktøy, run_code-disiplin eller svarformat.
- Ingen ny leverandørstøtte. `providers/*` forblir byte-identisk med askstat.
- Ingen flytting av endepunkter til annen sky (vurdert og forkastet: splitter
  deploy, env, auth og CD for én endepunktfamilie).

## 3. Plattformfakta som designet hviler på

Verifisert 2026-08-28 mot konto `hmelberg` (plan: **Free**):

- `background_functions: {included: true}` — tilgjengelig på Free.
- Synkron funksjon: 60 s. Background: **15 min**. Scheduled: 30 s.
- `functions_gb_hour: {included: 100}`. En 60 s-jobb ≈ 0,017 GB-h → rikelig.
- `edge_functions: {included: 1 000 000}`.
- Deno-flaten i `_lib` er liten: `Deno.env.get` fem steder, to `esm.sh`-importer
  (`feiljournal.ts`, `rate-limit.ts`). `anthropic.ts` er ren `fetch`/
  `ReadableStream`/`TextEncoder` og kjører uendret på Node 20.

## 4. Arkitektur

```
klient ──POST /api/svar──▶ edge: auth → jobId → POST /api/svar/jobb (202)
                             │                        │
                             │                        ▼
                             │            background-funksjon (15 min)
                             │            runAgenticStream → rå SSE-frames
                             │                        │
                             │                        ▼
                             │                 Blobs «svarjobb»
                             ▼                        │
                       edge-tailer ◀──────────────────┘
                             │  poll head hver ~120 ms, hent nye chunks
                             ▼
                     SSE til klienten
                             │
              ved 45 s: {type:"tail", job, cursor} + lukk
                             │
klient ──GET /api/svar/tail?job=&from=──▶ ny tailer, samme rutine
```

**Én jobb per hopp.** `run_code`- og `continue`-eventene passerer uendret
gjennom Blobs til klienten, som kjører scriptet i emulatoren og POSTer et nytt
`/api/svar`-kall med resume-tilstanden. Det starter en NY jobb med ny `jobId`.
Hoppgrensen er altså uendret fra i dag — det er bare den enkelte turens
tidsbudsjett som går fra 60 s til 15 min.

**Alle** kvalitetsnivåer går gjennom transporten. Det koster ~1 s ekstra til
første byte mot dagens direkte edge-strøm, men gir én kodevei i stedet for to
løkkeveier å holde i synk — og pålitelighet var klagen. (Hybriden — `fast`/
`balanced` inline, bare `best` i bakgrunnen — er vurdert og forkastet: den
lar `balanced` fortsatt treffe veggen på et langt svar.)

## 5. Blobs-protokollen

Store: `svarjobb`, **alltid** `consistency: "strong"`. Dette er repoets
dokumenterte felle — eventual consistency drepte rate-limit-telleren i fire
repoer, og en tailer som leser gammel head ville stå stille.

```
<jobId>/head     → {"seq": N, "state": "kjorer"|"ferdig"|"feil", "start": <ms>}
<jobId>/000001   → rå SSE-tekst: "data: {...}\n\n" × n
<jobId>/000002   → …
```

Chunkene holder **rå SSE-bytes**, ikke parsede objekter. Taileren blir en ren
bytepumpe: event-kontrakten overlever uendret, og `anthropic.ts` trenger ingen
ny krok. `jobId` = `crypto.randomUUID()`.

**Skriveren** buffrer og flusher hver ~150 ms, og alltid umiddelbart på
`run_code`, `continue`, `done` og `error`.

**Invarianten:** chunk skrives FØRST, head oppdateres ETTERPÅ. Leseren rykker
bare fram når head flytter seg, og kan derfor aldri be om en chunk som ikke
finnes ennå. Én skriver per jobb, så read-modify-write på head er trygt.

**Leseren** poller head hvert ~120 ms; ved `head.seq > cursor` hentes chunkene
`cursor+1 … head.seq` parallelt, emitteres i rekkefølge, og cursor settes.
Avslutter når `head.state != "kjorer"` OG cursor har nådd `head.seq`.
Mangler head fortsatt etter 10 s: `error` — bakgrunnsjobben startet aldri.

## 6. Endepunkter

### 6.1 `netlify/functions/svar-jobb.mts` (ny, Node, background)

```ts
export const config: Config = { path: "/api/svar/jobb", background: true };
```

Konsumerer `ReadableStream`-en fra `runAgenticStream` og pumper rå frames til
Blobs. Setter `head.state` til `ferdig`/`feil` når strømmen lukkes.

`turnDeadlineMs` settes til **780 000** (13 min, under background-taket), slik
at en løpsk tur fortsatt får en forklart feil i stedet for stille død.

### 6.2 `netlify/edge-functions/svar-tail.ts` (ny)

`GET /api/svar/tail?job=<id>&from=<cursor>` → `text/event-stream`.
Kjører den delte tailer-rutinen. Overleverer på 45 s.

### 6.3 `netlify/edge-functions/svar.ts` (endret)

Beholder auth, rate-limit, `resolveLlm`, prefiks-bygging og feiljournalens
`sporsmal`-hendelse. Slutter å kjøre løkka: lager `jobId`, POSTer til
jobb-funksjonen, venter kun på 202-en, og blir så tailer fra markør 0.

### 6.4 `_lib/jobb-tail.ts` (ny, delt)

Tailer-rutinen som både `svar.ts` og `svar-tail.ts` bruker.

### 6.5 `netlify/functions/rydd-jobber.mts` (ny, scheduled)

`schedule: "@hourly"`. Feier jobber eldre enn én time basert på `head.start`.
Fanger foreldreløse jobber der brukeren lukket fanen. (Taileren sletter selv
jobben når den har drenert en `ferdig`-jobb — dette er nettet under.)

## 7. Auth

Jobb-funksjonen er **offentlig nåbar** på `/api/svar/jobb`. Den kjører derfor
hele auth-porten på nytt (`auth.ts`, uendret logikk) — og krever i tillegg
`X-Jobb-Nokkel` mot ny env `SVAR_JOBB_SECRET`, slik at ingen kan gå rundt
rate-limiten ved å kalle den direkte.

Rate-limiting blir stående på `/api/svar` alene: én telling per spørsmål, som i
dag. `/api/svar/tail` teller ikke (det er samme spørsmål).

`erPersonlig` regnes ut på nytt i jobb-funksjonen — den styrer feiljournalen og
`verboseUpstream`.

BYOK-nøkkel og provider-config følger med i POST-kroppen til jobb-funksjonen,
same-origin over TLS internt i Netlify. Det er samme nøkkel som ville blitt
brukt uansett.

**Felle:** `netlify env:import .env` setter ALT i fila og blanker live-verdier
som mangler. `SVAR_JOBB_SECRET` må derfor inn i `.env` samtidig som den settes.

## 8. Klienten

`js/ai-transport.js`
- Fanger `{type:"tail", job, cursor}` og kobler seg umiddelbart på
  `/api/svar/tail` med samme auth-headere og markør. Usynlig for `ai-chat.js`,
  som beholder sin event-håndtering uendret.
- Samme figur som dagens `continue`-hopp ved `run_code`.
- Retry med backoff på nettverksfeil under en tail-gjenkobling. Markøren er
  varig, så et nettverksglipp midt i et svar blir en gjenopptakelse i stedet
  for et tapt svar. Dette faller gratis ut av designet.

`js/ai-chat.js`
- Progress-linjen pulser hvert sekund fra en lokal timer i stedet for hvert
  tiende fra serveren, så den er levende også når serveren er stille.
- Ny event-type `forord` (se §9) rendres dempet over svaret og ryddes bort ved
  første ekte `delta`.

## 9. De tre stillhets-tiltakene

Tenketeksten finnes ikke (§1.1), så stillheten angripes fra tre kanter:

1. **`balanced` mister effort.** `llm-choice.ts`:
   `balanced: { model: "claude-sonnet-5" }`. Målt: strømmer fra 1,12 s.
   `best` beholder `high`, og kan måles mot `xhigh` igjen når taket er borte.

   **Også `DEFAULTS["svar"]` må miste effort.** `resolveLlm` bruker
   `coerceQuality(body.quality)` — som er `null` når klienten ikke sender
   `quality` — og faller da til `DEFAULTS`, mens `svar.ts` samtidig velger
   budsjett med `?? "balanced"`. I dag betyr det at et kall uten `quality`
   får balanced-budsjett men effort `medium`. Lar vi den stå, beholder
   default-veien nøyaktig stillheten vi fjerner. `DEFAULTS["svar"]` settes
   derfor til `{ model: "claude-sonnet-5" }`. `dm-vurder` og `tolk-resultat`
   er utenfor denne pipelinen og røres ikke.
2. **Ekte levende statuslinje** (§8), for `best` der tenking er uunngåelig.
3. **Haiku-forord.** Når turen faktisk har effort satt (altså `best`), fyrer
   bakgrunnsjobben et parallelt `claude-haiku-4-5`-kall — brukerens spørsmål
   pluss «Skriv én til to setninger om hvordan du vil gripe an spørsmålet.
   Ikke svar på det.» — og strømmer det inn som `{type:"forord", text}` innen
   ~1 s. Fyres aldri på `fast`/`balanced`, som nå strømmer umiddelbart selv.

## 10. Testing

All logikk bor i `_lib/` (Deno-testbar); `.mts`-filene er ren kabling.
`Deno.env.get` byttes mot injisert env-aksessor — `resolveLlm` støtter det
allerede.

Nye tester:
- `_lib/jobb-blobb.test.ts` — skriverekkefølge (chunk før head), leser aldri
  forbi head, gjenopptak fra vilkårlig markør, flush tvinges på kontroll-events.
- `_lib/jobb-tail.test.ts` — overlevering på frist emitterer `tail` med riktig
  markør; `ferdig` + drenert cursor lukker; manglende head → `error` etter 10 s.

Kommando som i dag:
`cd netlify/edge-functions && deno check *.ts _lib/*.ts && deno test --allow-all _lib/`

Ende-til-ende: `scripts/eval_svar.py` mot en deploy-preview før merge til main.

## 11. Risiko

1. **Strømmen blir litt hakkete.** Strong consistency koster ~100 ms, og
   polling hvert 120 ms gir ~250 ms effektiv granularitet mot dagens direkte
   rør. Akseptert bytte mot aldri å bli kuttet.
2. **~1 s ekstra til første byte** på alle nivåer (§4). Haiku-forordet dekker
   det på `best`; på `fast`/`balanced` går første tekst fra ~1,1 s til ~2 s.
   Blir det for tregt i praksis, er hybriden retretten.
3. **Node-porten av `_lib`.** De to `esm.sh`-importene må bli npm
   `@netlify/blobs` i Node-funksjonen. Løses med én tynn adaptermodul per
   kjøretid; resten av `_lib` er kjøretidsnøytralt.
4. **Ny offentlig flate.** `/api/svar/jobb` må ikke kunne brukes til å brenne
   servernøkkelen. §7 er derfor ikke valgfri.

## 12. Utsatt

- `xhigh` på `best` — gjenåpnes først etter måling når taket er borte.
- Feiljournal-UI og «Forbedre instruksjonene»-knappen (uendret parkert).
- Ratelimit-fritak per continuation-hopp for delt passord (askstats
  resume-hopp-fritak er fortsatt ikke portert).
