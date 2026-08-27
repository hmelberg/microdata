// tests/js/ai-credential.test.js — hvilken legitimasjon skrev brukeren inn?
// Ett felt tar BÅDE en Anthropic-nøkkel og det delte tilgangspassordet;
// klassifiseringen avgjør hvilken header den sendes som.
const test = require('node:test');
const assert = require('node:assert');
const { classifyCredential } = require("../../js/ai-credential.js");

test('sk-ant--prefiks → Anthropic-nøkkel', () => {
  assert.equal(classifyCredential('sk-ant-api03-abc123'), 'anthropic');
  assert.equal(classifyCredential('  sk-ant-api03-abc123  '), 'anthropic');
});

test('alt annet ikke-tomt → tilgangspassord', () => {
  assert.equal(classifyCredential('Letusus...'), 'access');
  assert.equal(classifyCredential('et langt passord med mellomrom'), 'access');
  // Feilklipt nøkkel (mistet prefikset) leses som passord — dokumentert
  // konsekvens, og grunnen til at hjelpeteksten nevner det.
  assert.equal(classifyCredential('api03-abc123'), 'access');
});

test('tomt / bare mellomrom / ikke-streng → ingenting', () => {
  assert.equal(classifyCredential(''), 'none');
  assert.equal(classifyCredential('   '), 'none');
  assert.equal(classifyCredential(null), 'none');
  assert.equal(classifyCredential(undefined), 'none');
  assert.equal(classifyCredential(42), 'none');
});

test('prefikset må stå FØRST — ikke bare finnes i strengen', () => {
  assert.equal(classifyCredential('passord-sk-ant-lureri'), 'access');
});
