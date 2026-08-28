// Materialisering av connect/load-direktiver: parse → resolve → fetch.
// Ingen runtime-binding her — index.html binder bytes inn i pyodide/webr/
// duckdb med ~10 linjer per modus. deps er injiserbar for tester.
(function (global) {
  'use strict';

  var _registryCache = null;
  async function loadRegistry(fetchImpl) {
    if (_registryCache) return _registryCache;
    try {
      var r = await fetchImpl('data/data-sources.json');
      _registryCache = r.ok ? await r.json() : [];
    } catch (e) { _registryCache = []; }
    return _registryCache;
  }

  // Module-scoped (not per-call, like _registryCache above): every click of
  // Run previously re-fetched (and for duckdb/sqlite, re-extracted) every
  // source from scratch, even when nothing about the script changed since
  // the last run — the highest-frequency friction point in the app given
  // how often a script gets tweaked and re-run during iteration. Keyed by
  // resolved URL; only raw bytes are cached (decryption still runs fresh
  // per item/run). No TTL/invalidation, same as
  // _registryCache above — a page reload is the reset, by design (2026-07-07,
  // docs/superpowers/2026-07-07-code-review.md §6 item 1).
  var _bufCache = {};

  // Proxy-auth: innloggingstoken har forrang; ellers BYOK-nøkkel (hent-
  // endepunktet godtar X-Anthropic-Key via allowByok, jf. B5 i roadmapen).
  function proxyHeaders(authToken, anthropicKey) {
    if (authToken) return { 'Authorization': 'Bearer ' + authToken };
    if (anthropicKey) return { 'X-Anthropic-Key': anthropicKey };
    return {};
  }

  async function fetchLoadTarget(item, fetchImpl, authToken, anthropicKey) {
    async function viaProxy() {
      var pr = await fetchImpl('/api/hent?url=' + encodeURIComponent(item.url), { headers: proxyHeaders(authToken, anthropicKey) });
      if (!pr.ok) throw new Error('proxy ' + pr.status + ' for ' + item.alias);
      return pr;
    }
    if (item.url.indexOf('/api/hent?') === 0) {
      var r0 = await fetchImpl(item.url, { headers: proxyHeaders(authToken, anthropicKey) });
      if (!r0.ok) throw new Error('proxy ' + r0.status + ' for ' + item.alias);
      return r0;
    }
    if (item.viaProxy) return viaProxy();
    try {
      var r1 = await fetchImpl(item.url);
      if (!r1.ok) throw new Error('HTTP ' + r1.status + ' for ' + item.alias + ' (' + item.url + ')');
      return r1;
    } catch (e) {
      if (e instanceof TypeError) return viaProxy();   // CORS/nettverk → proxy
      throw e;
    }
  }

  function sniffFormat(resp, url, kind) {
    // Eksplisitt kind() vinner alltid — sniffing er en heuristikk for de
    // uregistrerte tilfellene (spec 2026-07-06-remote-columnar-sources §4).
    if (kind) return kind;
    var ct = (resp.headers.get('content-type') || '').toLowerCase();
    if (ct.indexOf('parquet') >= 0 || /\.parquet(\?|$)/.test(url)) return 'parquet';
    if (/\.duckdb(\?|$)/.test(url)) return 'duckdb';
    if (/\.sqlite3?(\?|$)/.test(url)) return 'sqlite';
    if (ct.indexOf('json') >= 0) return 'json';
    if (ct.indexOf('html') >= 0) return 'html';   // f.eks. Wikipedia: bind som råtekst
    return 'csv';
  }

  // Hoved-API: {loads: [{alias, bytes(Uint8Array), format}], remote: []}
  // eller kast norsk feil. remote er ALLTID tom i denne offentlige BYOK-
  // byggen (ingen server-side kjøring) — feltet beholdes kun som form, siden
  // kallere sjekker `.remote` på resultatet.
  async function resolveAndFetchLoads(script, deps) {
    deps = deps || {};
    var fetchImpl = deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(global) : null);
    var DD = global.DataDirectives;
    if (!DD || !fetchImpl) return { loads: [], remote: [] };
    var parsed = DD.parse(script);
    if (!parsed.loads.length) return { loads: [], remote: [] };
    var registry = deps.registry || await loadRegistry(fetchImpl);
    var resolved = DD.resolve(parsed, registry);
    var bad = resolved.filter(function (r) { return r.error; });
    if (bad.length) throw new Error('Direktivfeil: ' + bad.map(function (b) { return b.error; }).join('; '));

    var loads = await fetchResolvedItems(resolved, deps);
    return { loads: loads, remote: [] };
  }

  // Fetch+decrypt+cache for an already-resolved item list (each
  // {alias, url, kind, key, table, viaProxy}) — the part of
  // resolveAndFetchLoads that doesn't depend on connect/load-directive
  // syntax at all. Extracted (2026-07-09) so a mode with its OWN directive
  // syntax (SafeStat mode's bare `require <url> as <alias>` DSL statement,
  // not a "#"/"--"/"//"-prefixed comment directive DataDirectives.parse can
  // recognize) can still get key()/kind()/caching for free instead of a
  // second, narrower hand-rolled fetch — see index.html's runSafeStatScript.
  // -> [{alias, bytes, format, table?, kind?}]
  async function fetchResolvedItems(localItems, deps) {
    deps = deps || {};
    var fetchImpl = deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(global) : null);

    function fetchBytes(item) {
      var k = item.url;
      if (!_bufCache[k]) {
        _bufCache[k] = fetchLoadTarget(item, fetchImpl, deps.authToken || null, deps.anthropicKey || null)
          .then(function (resp) {
            return resp.arrayBuffer().then(function (ab) { return { resp: resp, buf: new Uint8Array(ab) }; });
          });
        // A failed fetch must NOT poison future runs — _bufCache is now
        // module-scoped (persists across runs, not just within one), so a
        // transient network error would otherwise be "cached" forever until
        // a page reload. Drop the entry on rejection so the next run retries.
        _bufCache[k].catch(function () { delete _bufCache[k]; });
      }
      return _bufCache[k];
    }
    return Promise.all(localItems.map(async function (item) {
      var fetched = await fetchBytes(item);
      var format = sniffFormat(fetched.resp, item.url, item.kind);
      var dec = await maybeDecrypt(item, fetched.buf, format, deps);
      var out = { alias: item.alias, bytes: dec.bytes, format: dec.format };
      if (item.table) out.table = item.table;
      if (item.kind) out.kind = item.kind;
      return out;
    }));
  }

  // safepy-enc-v1: sniffFormat sier json — sjekk konvolutt, verifiser
  // fingerprint (bytte-vern) og dekrypter lokalt (WebCrypto).
  async function maybeDecrypt(item, buf, format, deps) {
    var EC = global.EncCrypto;
    if (!EC || format !== 'json') return { bytes: buf, format: format };
    var env;
    try { env = JSON.parse(new TextDecoder().decode(buf)); } catch (e) { return { bytes: buf, format: format }; }
    if (!EC.isEnvelope(env)) return { bytes: buf, format: format };
    var computed = await EC.envelopeFingerprint(env);
    if (env.fingerprint && computed !== env.fingerprint)
      throw new Error('«' + item.alias + '»: ødelagt fil (fingerprint stemmer ikke)');
    var key = (item.key && item.key !== 'ask') ? item.key
        : deps.promptKey ? await deps.promptKey(item.alias)
        : null;
    if (!key) throw new Error('«' + item.alias + '» er kryptert og krever nøkkel — bruk key(...) eller key(ask)');
    var plain = await EC.decryptEnvelope(env, key);
    return { bytes: plain, format: env.payload_format || 'csv' };
  }

  // Project A: fetch the SOURCES a spec needs (each connect alias as a whole
  // table), honoring key()/decrypt exactly like load does, and
  // return the spec so the runtime can assemble. Same fetch layer as
  // resolveAndFetchLoads — only the shape of the request changes.
  async function resolveAndAssemble(script, deps) {
    deps = deps || {};
    var DD = global.DataDirectives;
    if (!DD) return { sources: [], remote: [], spec: { sources: [], datasets: [] } };
    var parsed = DD.parseAssembly(script);
    if (parsed.errors.length) throw new Error('Monteringsfeil: ' + parsed.errors.join('; '));
    var spec = parsed.spec;
    if (!spec.sources.length) return { sources: [], remote: [], spec: spec };

    // Synthesize a "load <alias> as <alias>" per source and run the existing
    // pipeline against just the connect lines, so each source is fetched
    // exactly once (skip any original bare `load` lines from the script).
    var connectLines = script.split(/\r?\n/).filter(function (ln) { return /^[ \t]*(?:#|--|\/\/)[ \t]*connect\b/i.test(ln); }).join('\n');
    var tables = spec.sourceTables || {};
    var srcScript = connectLines + '\n' + spec.sources.map(function (a) {
      var t = tables[a];
      var target = t ? (t.source + '/' + t.table) : a;
      return '# load ' + target + ' as ' + a;
    }).join('\n');
    var loaded = await resolveAndFetchLoads(srcScript, deps);
    return { sources: loaded.loads, remote: loaded.remote, spec: spec };
  }

  // Phase 2: resolve connect/load/import/join into per-source {url, format,
  // table} WITHOUT fetching bytes — used to decide pushdown-eligibility and
  // to feed AssemblyDuckdb.compile() before any network request happens.
  async function resolveSourcesOnly(script, deps) {
    deps = deps || {};
    var DD = global.DataDirectives;
    if (!DD) return { spec: { sources: [], datasets: [] }, descriptors: {} };
    var parsed = DD.parseAssembly(script);
    if (parsed.errors.length) throw new Error('Monteringsfeil: ' + parsed.errors.join('; '));
    var spec = parsed.spec;
    var tables = spec.sourceTables || {};
    var connectLines = script.split(/\r?\n/).filter(function (ln) { return /^[ \t]*(?:#|--|\/\/)[ \t]*connect\b/i.test(ln); }).join('\n');
    var descLines = connectLines + '\n' + spec.sources.map(function (a) {
      var t = tables[a];
      return '# load ' + (t ? (t.source + '/' + t.table) : a) + ' as ' + a;
    }).join('\n');
    var parsedLoads = DD.parse(descLines);
    // Same registry-loading convention as resolveAndFetchLoads: use whatever
    // was passed in, or load+memoize the web registry on demand (a tiny JSON
    // manifest, not the large source itself — resolving named registry
    // sources correctly here matters more than avoiding this one small fetch).
    var fetchImpl = deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(global) : null);
    var registry = deps.registry || (fetchImpl ? await loadRegistry(fetchImpl) : []);
    var resolved = DD.resolve(parsedLoads, registry);
    var descriptors = {};
    resolved.forEach(function (r) {
      if (r.error) return; // error sources are never pushdown-eligible
      // .csv-sniff siden trinn B: bare .parquet/.csv-endelser gjenkjennes uten
      // eksplisitt kind() — alt annet er 'other' og aldri pushdown-kandidat.
      descriptors[r.alias] = { url: r.url,
        format: r.kind || (/\.parquet(\?|$)/.test(r.url) ? 'parquet' : /\.csv(\?|$)/.test(r.url) ? 'csv' : 'other'),
        table: r.table };
    });
    return { spec: spec, descriptors: descriptors };
  }

  global.DataLoader = { resolveAndFetchLoads: resolveAndFetchLoads, resolveAndAssemble: resolveAndAssemble,
    resolveSourcesOnly: resolveSourcesOnly, fetchResolvedItems: fetchResolvedItems, _sniffFormat: sniffFormat,
    // Test-only: the cross-run fetch cache is module-scoped by design (see
    // _bufCache above), which is exactly wrong for a test file that evals
    // this module once and shares it across every Deno.test case — without
    // this, tests using the same placeholder URL leak cached bytes into
    // each other. Not used by index.html.
    _resetCacheForTests: function () { _bufCache = {}; } };
})(typeof window !== 'undefined' ? window : globalThis);
