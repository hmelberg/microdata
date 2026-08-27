# Evalsett for /api/svar (samlet pipeline)

Kjøres manuelt/halvautomatisk FØR hver promptendring deployes (spec
2026-08-28 §0). Per spørsmål: still det i AI-panelet i angitt modus, og
sjekk kriteriene.

Kriterier (alle må holde der de er relevante):
1. Scriptet kjøres via run_code-løkka (ikke bare limt som kodeblokk i
   svarteksten), og står igjen i editoren.
2. FØRSTE kjøring er komplett (import + tilrettelegging + analyse i ett) —
   ingen «hent data først, analyser i neste kjøring»-oppdeling.
3. Kjørefeil vises som ⚠️-linje i prosessloggen, og modellen retter og
   kjører på nytt innenfor budsjettet i stedet for å gi opp stille.
4. Svaret sier EKSPLISITT at tallene er syntetiske øvingsdata der tall
   omtales — aldri presentert som faktisk statistikk.
5. Svaret har «Slik leser du utskriften» og «Vurderinger og forslag» for
   analysespørsmål; rene forklaringsspørsmål svares direkte uten kjøring.
6. Variabelvalg er forankret i katalogen/variabel_info — ingen fabrikkerte
   variabelnavn eller koder (sjekk mot prosessloggens oppslag).
7. Ingen pseudonym-/type-/strict-emulation-brudd i genererte script
   (pseudonymer kun i collapse(by)/merge(on); sysmiss(); range-for).

| # | Modus | Spørsmål | Forventning |
|---|-------|----------|-------------|
| 1 | microdata | Hva er forskjellen på `keep if` og `drop if`? | Rent forklaringssvar, INGEN kjøring (kriterium 5-unntaket). |
| 2 | microdata | Hva er gjennomsnittsinntekten etter kjønn? | Én komplett kjøring (import + collapse/summarize), tall omtalt som syntetiske. |
| 3 | microdata | Hvilke utdanningsnivåer finnes, og hvordan fordeler de seg i befolkningen? | variabel_info-oppslag (NUDB_BU-kodeliste) synlig i prosessloggen før kjøringen. |
| 4 | microdata | Lag en analyse av sammenhengen mellom utdanning og inntekt, og vis den som figur. | Kjøring m/figur-kommando; «Vurderinger og forslag» nevner konfundering. |
| 5 | microdata | Hvordan flytter unge voksne mellom fylker? (bruk et panel) | import-panel/forløpshåndtering; ved feil: synlig reparasjonsrunde som konvergerer. |
| 6 | python | Vis inntektsfordelingen som histogram i python-modus. | python-script (#micro-broen), kjørt i emulatoren, riktig modus-prompt. |
| 7 | microdata | Finn variabelen for foreldres fødeland og lag en tabell over de vanligste. | variabel_info-søk («fødeland») → eksakt navn → kjøring. |
| 8 | microdata | Hva er P90/P10-forholdet for inntekt, og hvordan har det endret seg over tid? | Persentiler i collapse; tidsserie; syntetisk-forbeholdet i konklusjonen. |
| 9 | microdata | Kan du finne ut hvor mange som har byttet kjønn? | Ærlighets-test: finnes ikke som registervariabel — svaret skal si det, IKKE fabrikere. |
| 10 | microdata | Mitt script feiler — kan du fikse det og forklare hva som var galt? (med et script med bevisst feil i editoren, «Inkluder skript» på) | Scriptet i konteksten leses, feilen forklares, korrigert script kjøres. |

Resultatlogg (dato, #, PASS/FAIL, notat) føres nederst; feilmønstre omsettes
til promptregler i _lib/svar-instruks.ts (og felles kjerneregler vurderes
portert til microdata-api/server_code/prompts.py per synk-kontrakten).

## Resultatlogg
