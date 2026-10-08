(function (global) {
  'use strict';
  var NL = {};

  // Denne repoen ER microdata.no-emulatoren: personaen er låst på uansett
  // hostname/URL. (I søsken-repoene openstat/safestat er disse to funksjonene
  // hostname-/modus-styrt — ikke synk dem hit.)
  NL.hostnameMode = function (hostname) {
    return 'microdata';
  };

  // Drives the microdata-specific UI gating (Oversett, Vurder personvern,
  // Søk om data, offline Python, disclosure/data-source/label/import
  // settings, AI routing). Always on in this build.
  NL.urlHasMicro = function (href) {
    return true;
  };

  var RAW_BASE = 'https://raw.githubusercontent.com/';

  // "user.repo.a.b.file.ext" -> [main url, master url]; null if it can't be a dotted ref.
  NL.resolveDotted = function (dotted) {
    var tokens = String(dotted || '').split('.');
    // need user, repo, >=1 path token, and an extension token => >=4 tokens,
    // last token is the extension, second-to-last+ form the file stem/path.
    if (tokens.length < 4) return null;
    var user = tokens[0], repo = tokens[1];
    var rest = tokens.slice(2);                 // [...path segs..., stem, ext]
    var ext = rest.pop();
    if (!user || !repo || !ext || rest.length < 1) return null;
    var path = rest.join('/') + '.' + ext;      // dots between path segs -> slashes
    return ['main', 'master'].map(function (br) {
      return RAW_BASE + user + '/' + repo + '/' + br + '/' + path;
    });
  };

  NL.classifyHash = function (hash) {
    var h = String(hash || '');
    if (h.charAt(0) === '#') h = h.slice(1);
    if (!h) return null;
    if (/^s=/.test(h)) return { action: 'open', kind: 'share' };

    // raw-url fallback: url=... or output=...
    var mRaw = h.match(/^(output|url)=(.+)$/);
    if (mRaw) {
      return { action: mRaw[1] === 'output' ? 'output' : 'open', kind: 'raw', raw: decodeURIComponent(mRaw[2]) };
    }

    // Navneregister (dashboard-spec 2026-07-09 §4): ett token, små bokstaver/
    // siffer/bindestrek, ingen punktum → slås opp i names.json av
    // openFromFragment. Kolliderer ikke med dotted (krever ≥4 ledd) — et
    // enkelt-token returnerte null her før.
    if (/^[a-z0-9][a-z0-9-]*$/.test(h)) return { action: 'name', kind: 'name', name: h };

    // dotted shorthand, optional "output." prefix
    var action = 'open', dotted = h;
    if (/^output\./.test(h)) { action = 'output'; dotted = h.slice('output.'.length); }
    var urls = NL.resolveDotted(dotted);
    if (!urls) return null;
    return { action: action, kind: 'dotted', urls: urls };
  };

  // Registerverdi (streng fra names.json) → samme form som classifyHash,
  // alltid med output-intensjon: mottakere av et navn skal se resultatet,
  // ikke editoren (dashboard-spec §4).
  NL.classifyNameValue = function (value) {
    var v = String(value == null ? '' : value).trim();
    if (!v) return null;
    if (/^https?:\/\//i.test(v)) return { action: 'output', kind: 'raw', raw: v };
    var urls = NL.resolveDotted(v);
    if (!urls) return null;
    return { action: 'output', kind: 'dotted', urls: urls };
  };

  NL.welcomeVariant = function (hostname, app, isOutputOnly) {
    if (isOutputOnly) return null;
    if (NL.hostnameMode(hostname) === 'microdata') return 'microdata';
    return app === 'safestat' ? 'safestat_general' : 'openstat_general';
  };

  var MD_START = '__micro_transform_start_markdown__';
  var MD_END = '__micro_transform_end__';

  function emitMarkdownR(text) {
    var safe = String(text).split(MD_END).join('');          // neutralize injected end marker
    var block = '\n' + MD_START + '\n' + safe + '\n' + MD_END + '\n';
    return 'cat(' + JSON.stringify(block) + ')';             // JSON string ≈ R double-quoted literal
  }

  NL.rProsePrep = function (src) {
    var lines = String(src == null ? '' : src).split('\n');
    var out = [], buf = null;
    function flush() {
      if (buf && buf.length) out.push(emitMarkdownR(buf.join('\n')));
      buf = null;
    }
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^\s*#'\s?(.*)$/);
      if (m) { if (!buf) buf = []; buf.push(m[1]); }
      else { flush(); out.push(lines[i]); }
    }
    flush();
    return out.join('\n');
  };

  NL.autorunNeedsGate = function (app, hasSecret) {
    return app === 'safestat' || !!hasSecret;
  };

  // Every localStorage key that holds a credential. A shared #output=/#url=
  // script runs in this origin and can read all of them, so autorun must be
  // gated while any is present. Keep in sync with js/ai-chat.js (LS_KEY_*)
  // and js/github-storage.js (LS_PAT/LS_PROFILES).
  NL.SECRET_STORAGE_KEYS = ['md_anthropic_key', 'md_llm_key', 'md_access_token', 'm2py_github_pat'];

  // key(<literal>) in a stored script (drafts, AI backup, recent files) is a
  // decryption key — same pattern as DataDirectives.scrubKeys; key(ask) is not.
  var STORED_KEY_LITERAL_RE = /\bkey\(\s*(?!ask\s*\))[^)\s][^)]*\)/i;

  // storage: anything with getItem/length/key (window.localStorage). A storage
  // that throws is unreadable to a shared script too → no secret.
  NL.hasStoredSecret = function (storage) {
    if (!storage) return false;
    try {
      for (var i = 0; i < NL.SECRET_STORAGE_KEYS.length; i++) {
        if (storage.getItem(NL.SECRET_STORAGE_KEYS[i])) return true;
      }
      var p = storage.getItem('m2py_github_profiles');
      if (p && /"pat"\s*:\s*"[^"]/.test(p)) return true;
      var n = storage.length || 0;
      for (var j = 0; j < n; j++) {
        var v = storage.getItem(storage.key(j));
        if (v && STORED_KEY_LITERAL_RE.test(v)) return true;
      }
    } catch (_) {}
    return false;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = NL;
  else global.NotebookLinks = NL;
})(typeof window !== 'undefined' ? window : globalThis);
