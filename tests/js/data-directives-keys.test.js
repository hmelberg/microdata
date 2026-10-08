// tests/js/data-directives-keys.test.js — key(<literal>) forlater aldri
// nettleseren (scrubKeys), og et AI-revidert script som kommer tilbake med
// key(***) får brukerens egne nøkler satt inn igjen (restoreKeys) før det
// erstatter editoren.
const test = require('node:test');
const assert = require('node:assert');
require('../../js/data-directives.js');
const DD = globalThis.DataDirectives;

test('scrubKeys: literal maskeres, key(ask) beholdes', () => {
  assert.equal(DD.scrubKeys('a key(abc) b key(ask) c KEY( x y )'), 'a key(***) b key(ask) c KEY(***)');
});

test('restoreKeys: én unik nøkkel settes inn i alle key(***)', () => {
  const orig = 'require a key(s1)\nrequire b key(s1)';
  const revised = 'require a key(***)\n// ny linje\nrequire b key(***)\nrequire c key(***)';
  assert.equal(DD.restoreKeys(revised, orig), 'require a key(s1)\n// ny linje\nrequire b key(s1)\nrequire c key(s1)');
});

test('restoreKeys: flere nøkler, samme antall → posisjonsvis', () => {
  const orig = 'x key(k1) y key(k2)';
  assert.equal(DD.restoreKeys('X key(***) Y key(***)', orig), 'X key(k1) Y key(k2)');
});

test('restoreKeys: flere nøkler, ulikt antall → urørt (ingen gjetting)', () => {
  const orig = 'x key(k1) y key(k2)';
  assert.equal(DD.restoreKeys('X key(***)', orig), 'X key(***)');
});

test('restoreKeys: ingen nøkler i originalen / key(ask) → urørt', () => {
  assert.equal(DD.restoreKeys('X key(***)', 'x key(ask)'), 'X key(***)');
  assert.equal(DD.restoreKeys('X', 'x key(k)'), 'X');
});
