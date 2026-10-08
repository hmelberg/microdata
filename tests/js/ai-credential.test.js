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

// Bytte av leverandør i nedtrekkslista: forrige presets URL/modell må byttes
// ut, ellers sendes en Mistral-nøkkel til api.openai.com.
const { swapPresetField, baseUrlMismatch } = require("../../js/ai-credential.js");

test('swapPresetField: forrige presets verdi byttes til den nye', () => {
  assert.equal(swapPresetField('https://api.openai.com/v1', 'https://api.openai.com/v1', 'https://api.mistral.ai/v1'),
    'https://api.mistral.ai/v1');
  assert.equal(swapPresetField('gpt-5.6', 'gpt-5.6', 'mistral-large-latest'), 'mistral-large-latest');
});

test('swapPresetField: trailing slash / mellomrom teller som samme preset-verdi', () => {
  assert.equal(swapPresetField(' https://api.openai.com/v1/ ', 'https://api.openai.com/v1', 'https://api.mistral.ai/v1'),
    'https://api.mistral.ai/v1');
});

test('swapPresetField: tomt felt fylles', () => {
  assert.equal(swapPresetField('', 'https://api.openai.com/v1', 'https://api.mistral.ai/v1'), 'https://api.mistral.ai/v1');
  assert.equal(swapPresetField('   ', '', 'mistral-large-latest'), 'mistral-large-latest');
});

test('swapPresetField: forrige presets modell tømmes når ny preset ikke har modell', () => {
  assert.equal(swapPresetField('gpt-5.6', 'gpt-5.6', ''), '');
  assert.equal(swapPresetField('https://api.openai.com/v1', 'https://api.openai.com/v1', undefined), '');
});

test('swapPresetField: egen verdi brukeren skrev beholdes', () => {
  assert.equal(swapPresetField('https://llm.example.org/v1', 'https://api.openai.com/v1', 'https://api.mistral.ai/v1'),
    'https://llm.example.org/v1');
  // Forrige preset hadde ingen default (Annen) — det brukeren skrev er eget.
  assert.equal(swapPresetField('https://llm.example.org/v1', '', 'https://api.mistral.ai/v1'), 'https://llm.example.org/v1');
});

test('baseUrlMismatch: egen URL med annen vert enn presetets → advarsel', () => {
  assert.equal(baseUrlMismatch('https://llm.example.org/v1', 'https://api.mistral.ai/v1'), true);
  assert.equal(baseUrlMismatch('https://api.openai.com/v1', 'https://api.mistral.ai/v1'), true);
});

test('baseUrlMismatch: samme vert, tom URL eller preset uten URL → ingen advarsel', () => {
  assert.equal(baseUrlMismatch('https://api.mistral.ai/v1/', 'https://api.mistral.ai/v1'), false);
  assert.equal(baseUrlMismatch('https://API.mistral.ai/v2', 'https://api.mistral.ai/v1'), false);
  assert.equal(baseUrlMismatch('', 'https://api.mistral.ai/v1'), false);
  assert.equal(baseUrlMismatch('https://llm.example.org/v1', ''), false);
});

test('baseUrlMismatch: ugyldig URL mot en preset → advarsel', () => {
  assert.equal(baseUrlMismatch('ikke en url', 'https://api.mistral.ai/v1'), true);
});
