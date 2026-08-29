// Drift-vakt for evalsett-parseren i scripts/eval-motor.mjs.
//
// Tabellen i docs/eval/svar-evalsett.md er en kontrakt med et dokument et
// MENNESKE redigerer. Endres kolonnene der, ville kjøringen ellers stille
// hoppet over spørsmål — en eval som tror den dekker ti spørsmål mens den
// kjører fire er verre enn ingen eval. Derfor testes parseren mot den EKTE
// fila, ikke mot en håndskrevet tabell.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROT = path.join(__dirname, '..', '..');
const EVALSETT = path.join(ROT, 'docs/eval/svar-evalsett.md');

async function parser() {
  const mod = await import(path.join(ROT, 'scripts/eval-motor.mjs'));
  return mod.parseEvalsett;
}

test('parser den EKTE evalsett-fila og finner alle spørsmålene', async () => {
  const parseEvalsett = await parser();
  const md = fs.readFileSync(EVALSETT, 'utf8');
  const sp = parseEvalsett(md);

  // Antallet er bevisst hardkodet: vokser settet, skal denne ryke så noen
  // bekrefter at de nye spørsmålene faktisk plukkes opp.
  assert.strictEqual(sp.length, 10, 'evalsettet skal ha 10 spørsmål');
  assert.deepStrictEqual(sp.map((s) => s.nr), [1,2,3,4,5,6,7,8,9,10]);
  assert.ok(sp.every((s) => s.sporsmal.length > 5), 'alle skal ha en spørsmålstekst');
  assert.ok(sp.every((s) => s.forventning.length > 5), 'alle skal ha en forventning');
});

test('modus leses ut, og python-spørsmålet er merket python', async () => {
  const parseEvalsett = await parser();
  const sp = parseEvalsett(fs.readFileSync(EVALSETT, 'utf8'));
  const moduser = new Set(sp.map((s) => s.mode));
  assert.ok(moduser.has('microdata'), 'microdata-modus skal finnes');
  assert.strictEqual(sp.find((s) => s.nr === 6).mode, 'python');
});

test('overskriftsrad og skillelinje plukkes ikke opp som spørsmål', async () => {
  const parseEvalsett = await parser();
  const sp = parseEvalsett([
    '| # | Modus | Spørsmål | Forventning |',
    '|---|-------|----------|-------------|',
    '| 1 | microdata | Hva er dette? | Et svar. |',
  ].join('\n'));
  assert.strictEqual(sp.length, 1);
  assert.strictEqual(sp[0].sporsmal, 'Hva er dette?');
});
