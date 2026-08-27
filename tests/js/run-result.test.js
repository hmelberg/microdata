// tests/js/run-result.test.js — byte-kontrakten for kjøreresultater:
// serverens klassifiserer (run-disiplin.ts) sjekker startsWith('OK.'),
// så prefiksene er KONTRAKT, ikke kosmetikk.
const test = require('node:test');
const assert = require('node:assert');
const { formatRunResult } = require('../../js/run-result.js');

test('suksess får OK.-prefikset klassifisereren krever', () => {
  const s = formatRunResult({ ok: true, output: 'x' });
  assert.ok(s.startsWith('OK. OUTPUT (truncated):\n'));
  assert.ok(s.includes('x'));
});

test('feil får FEIL:-prefiks', () => {
  const s = formatRunResult({ ok: false, output: 'Traceback: kaboom' });
  assert.ok(s.startsWith('FEIL:\n'));
  assert.ok(s.includes('kaboom'));
});

test('lang output cappes på 6000 med avkortet-markør, prefikset overlever', () => {
  const s = formatRunResult({ ok: true, output: 'a'.repeat(9000) });
  assert.ok(s.length < 6200);
  assert.ok(s.includes('avkortet'));
  assert.ok(s.startsWith('OK. OUTPUT (truncated):\n'));
});

test('tom output blir eksplisitt tekst, ikke tom streng', () => {
  const s = formatRunResult({ ok: true, output: '' });
  assert.ok(s.includes('(ingen tekst-output)'));
});
