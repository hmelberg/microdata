// tests/js/sw-cache.test.js — service-workeren skal BARE legge uforanderlige,
// versjonspinnede bibliotek-URL-er i Cache Storage. Brukerdata
// (cdn.jsdelivr.net/gh/…, også @<sha>) og muterbare oppslag (@main,
// pypi.org-JSON, webR-indeksen) skal aldri havne der.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadSw() {
  const listeners = {};
  const ctx = {
    URL, Request: class { constructor(u) { this.url = u; } }, Set, RegExp, String, Promise,
    self: { addEventListener: (t, f) => { listeners[t] = f; }, location: { origin: 'https://app.example' } },
    caches: { open: async () => ({ match: async () => null, put: async () => {} }), keys: async () => [] },
    fetch: async () => ({ ok: true, clone() { return this; } }),
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../sw.js'), 'utf8'), ctx);
  return { ctx, listeners };
}

function handled(listeners, url) {
  let responded = false;
  listeners.fetch({ request: { method: 'GET', url }, respondWith: (p) => { responded = true; Promise.resolve(p).catch(() => {}); } });
  return responded;
}

test('sw: pinned library URLs are cached (cache-first)', () => {
  const { listeners } = loadSw();
  for (const u of [
    'https://cdn.jsdelivr.net/pyodide/v314.0.2/full/pyodide.js',
    'https://cdn.jsdelivr.net/npm/markdown-it@14.1.0/dist/markdown-it.min.js',
    'https://cdn.plot.ly/plotly-2.32.0.min.js',
    'https://files.pythonhosted.org/packages/ab/cd/pkg-1.0-py3-none-any.whl',
    'https://webr.r-wasm.org/v0.4.2/webr.mjs',
    'https://repo.r-wasm.org/bin/emscripten/contrib/4.4/jmv_2.5.6.tgz',
  ]) assert.equal(handled(listeners, u), true, u);
});

test('sw: user data and mutable refs are never intercepted or cached', () => {
  const { listeners } = loadSw();
  for (const u of [
    'https://cdn.jsdelivr.net/gh/someone/data@main/people.csv',
    'https://cdn.jsdelivr.net/gh/someone/data@0123abc/people.csv',
    'https://cdn.jsdelivr.net/gh/someone/data@1.2.3/people.csv',
    'https://cdn.jsdelivr.net/npm/foo@latest/x.js',
    'https://cdn.jsdelivr.net/npm/foo@1/x.js',
    'https://pypi.org/pypi/polars/json',
    'https://webr.r-wasm.org/latest/webr.mjs',
    'https://repo.r-wasm.org/bin/emscripten/contrib/4.4/PACKAGES',
    'https://raw.githubusercontent.com/someone/data/main/x.csv',
  ]) assert.equal(handled(listeners, u), false, u);
});

test('sw: no network-first runtime cache remains', () => {
  const { ctx } = loadSw();
  assert.equal(typeof ctx.networkFirst, 'undefined');
});
