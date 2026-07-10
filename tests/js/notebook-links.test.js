// tests/js/notebook-links.test.js
const test = require('node:test');
const assert = require('node:assert');
const NL = require('../../js/notebook-links.js');

// Persona er låst på i denne repoen (microdata.no-emulatoren): alle hosts
// gir microdata som default-modus, uansett subdomene.
test('hostnameMode: locked to microdata for every host', () => {
  assert.equal(NL.hostnameMode('py.openstat.app'), 'microdata');
  assert.equal(NL.hostnameMode('r.safestat.app'), 'microdata');
  assert.equal(NL.hostnameMode('localhost'), 'microdata');
  assert.equal(NL.hostnameMode('deploy-preview-1--microdata.netlify.app'), 'microdata');
  assert.equal(NL.hostnameMode(''), 'microdata');
});

test('classifyHash: dotted open → main+master candidates', () => {
  const r = NL.classifyHash('#hans.demo.analyses.income.py');
  assert.equal(r.action, 'open');
  assert.equal(r.kind, 'dotted');
  assert.deepEqual(r.urls, [
    'https://raw.githubusercontent.com/hans/demo/main/analyses/income.py',
    'https://raw.githubusercontent.com/hans/demo/master/analyses/income.py',
  ]);
});
test('classifyHash: dotted output prefix', () => {
  const r = NL.classifyHash('#output.hans.demo.income.py');
  assert.equal(r.action, 'output');
  assert.deepEqual(r.urls, [
    'https://raw.githubusercontent.com/hans/demo/main/income.py',
    'https://raw.githubusercontent.com/hans/demo/master/income.py',
  ]);
});
test('classifyHash: raw url fallback', () => {
  const r = NL.classifyHash('#url=https://gist.githubusercontent.com/u/abc/raw/x.py');
  assert.equal(r.action, 'open');
  assert.equal(r.kind, 'raw');
  assert.equal(r.raw, 'https://gist.githubusercontent.com/u/abc/raw/x.py');
});
test('classifyHash: output raw url', () => {
  const r = NL.classifyHash('#output=https://raw.githubusercontent.com/u/rr/main/a.r');
  assert.equal(r.action, 'output');
  assert.equal(r.kind, 'raw');
});
test('classifyHash: legacy share defers', () => {
  assert.deepEqual(NL.classifyHash('#s=H4sIAAA'), { action: 'open', kind: 'share' });
});
test('classifyHash: non-matching returns null', () => {
  assert.equal(NL.classifyHash(''), null);
  assert.equal(NL.classifyHash('#'), null);
  // '#section-heading' er nå et registernavn (dashboard-spec §4) — appen
  // (index.html) har ingen egne side-ankre, så tokenet var ledig.
  assert.equal(NL.classifyHash('#section-heading').action, 'name');
  assert.equal(NL.classifyHash('#only.two'), null);         // needs user.repo.path.ext
});

test('welcomeVariant: output-only shows nothing', () => {
  assert.equal(NL.welcomeVariant('micro.safestat.app', 'safestat', true), null);
});
test('welcomeVariant: micro host → microdata framing (either app)', () => {
  assert.equal(NL.welcomeVariant('microdata.run', 'openstat', false), 'microdata');
  assert.equal(NL.welcomeVariant('micro.safestat.app', 'safestat', false), 'microdata');
});
test('welcomeVariant: microdata framing on every host (persona locked)', () => {
  assert.equal(NL.welcomeVariant('py.openstat.app', 'openstat', false), 'microdata');
  assert.equal(NL.welcomeVariant('safestat.app', 'safestat', false), 'microdata');
  assert.equal(NL.welcomeVariant('r.safestat.app', 'safestat', false), 'microdata');
});

test('rProsePrep: contiguous #\' block becomes one markdown cat', () => {
  const src = "#' # Title\n#' body text\nx <- 1\nprint(x)";
  const out = NL.rProsePrep(src);
  assert.match(out, /cat\(/);
  assert.match(out, /__micro_transform_start_markdown__/);
  assert.match(out, /# Title\\nbody text/);       // joined, prefix stripped
  assert.match(out, /x <- 1\nprint\(x\)/);          // code untouched
});
test('rProsePrep: ordinary # comments untouched', () => {
  const src = "# not prose\ny <- 2";
  assert.equal(NL.rProsePrep(src), src);
});
test('rProsePrep: END marker in content is neutralized', () => {
  const src = "#' hi __micro_transform_end__ there\nz<-3";
  const out = NL.rProsePrep(src);
  assert.doesNotMatch(out.replace(/__micro_transform_end__\\n"\)/,''), /__micro_transform_end__ there/);
});

test('autorunNeedsGate: safestat always gates', () => {
  assert.equal(NL.autorunNeedsGate('safestat', false), true);
  assert.equal(NL.autorunNeedsGate('safestat', true), true);
});
test('autorunNeedsGate: openstat gates only when a secret is present', () => {
  assert.equal(NL.autorunNeedsGate('openstat', false), false);
  assert.equal(NL.autorunNeedsGate('openstat', true), true);
});

test('urlHasMicro: always on in this build (persona locked)', () => {
  assert.equal(NL.urlHasMicro('https://micro.safestat.app/'), true);
  assert.equal(NL.urlHasMicro('http://localhost:8080/'), true);
  assert.equal(NL.urlHasMicro(''), true);
  assert.equal(NL.urlHasMicro(null), true);
});

test('classifyHash: single lowercase token → name lookup', () => {
  assert.deepEqual(NL.classifyHash('#dodsarsaker'), { action: 'name', kind: 'name', name: 'dodsarsaker' });
  assert.deepEqual(NL.classifyHash('#kommune-helse'), { action: 'name', kind: 'name', name: 'kommune-helse' });
  assert.equal(NL.classifyHash('#Hans.demo.analyser.dod.py').action, 'open');  // dotted urørt
  assert.equal(NL.classifyHash('#s=abc').kind, 'share');                       // share urørt
  assert.equal(NL.classifyHash('#UPPER'), null);                               // ikke navn, ikke dotted
});

test('classifyNameValue: url and dotted values', () => {
  const r1 = NL.classifyNameValue('https://x.example/a.py');
  assert.deepEqual(r1, { action: 'output', kind: 'raw', raw: 'https://x.example/a.py' });
  const r2 = NL.classifyNameValue('hans.demo.analyser.dod.py');
  assert.equal(r2.action, 'output');
  assert.equal(r2.kind, 'dotted');
  assert.ok(r2.urls[0].includes('raw.githubusercontent.com/hans/demo/main/analyser/dod.py'));
  assert.equal(NL.classifyNameValue('ugyldig'), null);
  assert.equal(NL.classifyNameValue(''), null);
});
