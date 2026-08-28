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
