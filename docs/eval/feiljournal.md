# Feiljournal — /api/svar-pipelinen

Ledger for feilmønstre og forbedringsfunn, etter drawcast-repoets
STYLE.md-mønster: **hver observasjon appendes som datert entry** (sitat/symptom
+ rotårsak/hypotese + status), og destilleres **periodisk** til promptregler i
`_lib/svar-instruks.ts` eller kodeendringer — aldri en prompt som bare vokser.

Arbeidsflyt: TEKNISKE feil fanges AUTOMATISK — kall autentisert med det
personlige passordet journalføres server-side til Netlify Blobs-storen
`feiljournal` (hendelser: `sporsmal`, `run_feil`, `feil`; delt passord/BYOK
journalføres aldri). Les fra repoet med:
`netlify blobs:list feiljournal` og `netlify blobs:get feiljournal <nøkkel>`.
KVALITETSDOMMER (dårlige-men-feilfrie svar) kan ikke fanges automatisk — de
limes inn av Hans med et par ords kommentar. Claude legger til funn fra
eval-kjøringer (`scripts/eval_svar.py` → `docs/eval/kjoringer/`).
En entry lukkes med commit-referanse når den er destillert eller fikset.
Kvalitetsfunn måles mot kriteriene i `svar-evalsett.md` (spesielt #4
syntetisk-merking, #6 ingen fabrikkerte variabler, #7 syntaksregler).

Format:

```
## ÅÅÅÅ-MM-DD — <kort tittel>                          [ÅPEN|LUKKET <commit>]
**Symptom:** <sitat av feilmelding/dårlig svar, evt. spørsmålet>
**Rotårsak/hypotese:** <hva som faktisk skjer>
**Destillat:** <promptregel/kodeendring som følger av det — eller «ingen»>
```

---

## 2026-08-28 — «Error in input stream» på balansert/best      [LUKKET 0aa9f96+]
**Symptom:** «✗ Error in input stream» på «Hva påvirker om en person får
sosialhjelp?» (balansert); reprodusert som forbindelseskutt ved nøyaktig 60.2 s.
**Rotårsak:** Netlify kutter HVER edge-invokasjon hardt ved ~60 s — også med
aktiv strøm (bevist med tick-strøm-diagnose-endepunkt). Tenkefasen strømmer
ingenting (målt 32.5 s stillhet), så én effort-high-tur sprengte taket.
**Destillat:** Strømmende turer (streamOneTurn), effort senket til
medium/high, 50 s-frist per tur med forklart feilmelding. Dypere effort
krever background-transport (utsatt, spec §Utsatt).

**Endelig lukket denne runden:** background-transporten fjerner
60-sekundersveggen helt — /api/svar-jobb kjører som Netlify Background
Function (15 min budsjett), relayet gjennom Netlify Blobs til en edge-tailer
som overleverer hvert 45. sekund (godt under edge-veggen) og gjenopptas
transparent av klienten. Målingen bak effort-endringen viste dessuten at
tenketeksten er kryptert — thinking_delta kommer én gang, med 0 tegn, ved
slutten av tenkefasen — så stillheten kunne aldri fylles med modellens egen
tenking uansett hvor mye tak man fjernet. Løst i stedet med effort av på
balansert (målt 1,12 s til første tekst mot 26-31 s stum), en levende
statuslinje (lokal klokke i stedet for serverens 10 s-heartbeat), og et
Haiku-forord på Grundig (kun første tur, kun den native Anthropic-veien —
portet mot `!choice.provider` etter et review-funn om at et forord på en
egendefinert-leverandør-tur ville sendt brukerens fremmede nøkkel til
api.anthropic.com; se `_lib/forord-provider-vakt.test.ts`).

## 2026-08-28 — 400 på resume etter tenke-tur                  [LUKKET f.o.m. thinking-fiksen]
**Symptom:** «Anthropic API error 400» på hop 1, begge kvalitetsnivåer, etter
at streaming-turene kom inn.
**Rotårsak:** streamOneTurn akkumulerte ikke thinking_delta/signature_delta —
thinking-blokker ble rundturet UTEN signatur = malformert ved replay.
**Destillat:** Kodefix i streamOneTurn. VAKT: askstat-originalen mangler
dette (de kjører uten effort) — må ikke kopieres bort ved motor-synk.

## 2026-08-28 — Blind «Anthropic API error 400» uten detalj    [LUKKET denne runden]
**Symptom:** Oppstrøms-detaljen (som ville avslørt thinking-rotårsaken over på
ett blikk) fantes kun i Netlifys flyktige edge-logg — diagnosen krevde full
reproduksjonsrunde.
**Destillat:** Kall autentisert med personlig passord får skrubbet
oppstrøms-detalj i error-eventet; delt/BYOK forblir generisk.

## 2026-08-29 — Chatten har ingen hukommelse mellom spørsmål      [ÅPEN]
**Symptom:** Journalen 2026-08-28 viser at Hans svarte på oppklarende spørsmål
med fragmenter — «2022, 35-55 år, ja filltrer. nei, ikke panel.» (20:38) og
«yrkeslønn, filtere for å finne de foreldrene som er enslige slik du sa»
(20:39) — og fire minutter senere gjentok hele det opprinnelige spørsmålet
(20:43). Det er atferden til noen hvis svar ikke lander.
**Rotårsak:** `questionTurn()` (svar-instruks.ts:135) bygger brukerturen av
DAGENS spørsmål alene. `state.history` i ai-chat.js brukes KUN til å tegne
tråden — den sendes aldri. Modellen mottok altså «2022, 35-55 år» som et
helt nytt, kontekstløst spørsmål og kunne umulig vite hva den hadde spurt om.
Statsløsheten er arvet fra den gamle tre-veis-designen (kode-svar var «ETT
enkelt kall»), og ble aldri revurdert da pipelinen ble samtalepreget. Speccen
2026-08-28 nevner samtalehistorikk verken i designet eller under «Utsatt» —
dette er ikke en dokumentert beslutning, det er et hull ingen så.
**Klassifisering:** KODE, ikke prompt. En perfekt modell ville feilet likt.
**Destillat:** venter på Hans' beslutning om omfang (se runde-notat under).

## 2026-08-29 — Ett forskningsspørsmål, åtte forsøk, aldri besvart  [LUKKET 649339a]
**Symptom:** Samme spørsmål — effekten på voksne barns yrkesinntekt når en
forelder blir syk — stilt i åtte varianter over 17 timer (28. kl. 20:35 til
29. kl. 09:38). Tre eksplisitte «Svaret overskred plattformtaket (60 s)» og
til slutt en stille heng.
**Rotårsak:** to feil i serie. 60 s-veggen (lukket av background-transporten),
og deretter at en max_tokens-avkortet tur ble meldt som `done` (649339a).
**Destillat:** ingen promptregel — dette var kode hele veien. Tatt med i
ledgeren fordi den MÅLTE kostnaden: null svar på et ekte forskningsspørsmål,
og en bruker som prøvde åtte ganger før han ga opp.

## 2026-08-29 — Runde-notat: hva evalen ENNÅ ikke kan bedømme
Forklaringsspørsmål oppfører seg riktig (tre kjøringer, alle svarte direkte
uten kjøring og uten oppslag — kriterium 5s unntak). Promptcachen er verifisert
virksom (81 664 tokens LEST, ikke skapt).
Men kriteriene 2, 3, 4, 6 og 7 handler alle om hva som skjer under en ekte
analysekjøring, og **ingen analysespørsmål har noensinne fullført** i denne
pipelinen. Evalsettets resultatlogg er tom av samme grunn. Runden kan derfor
ikke uttale seg om kjernen: om modellen leser utskriften og svarer på
spørsmålet i stedet for på «lag et script». Neste runde må starte der.
