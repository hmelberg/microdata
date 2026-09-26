// Pyodide-fri SQL-hjelpere for duckdb-modusens native kjørevei (fase 1,
// docs/superpowers/plans/2026-07-11-phase1-duckdb-native.md). 1:1-port av
// parsefunksjonene i duckdb_bridge.py — Python-utgaven forblir sannheten for
// fallback-veien (hybride/montering/remote), denne for rene SQL-kjøringer.
// Ingen DOM- eller duckdb-wasm-avhengighet: kjører under node --test.
(function (global) {
  'use strict';

  // Dollar-kvote-tag ($$ / $tag$). Tag-identifikatoren kan ikke starte med
  // siffer, så $1-parametre er ikke tags (samme som _DOLLAR_TAG_RE i Python).
  var DOLLAR_TAG_RE = /\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/uy;
  var IDENT_CHAR_RE = /[\p{L}\p{N}_$]/u;

  function identChar(ch) { return IDENT_CHAR_RE.test(ch); }

  // Tagen ($$ eller $tag$) som åpner på sql[i], ellers null. Kan ikke starte
  // midt i en identifikator.
  function dollarTagAt(sql, i) {
    if (sql[i] !== '$' || (i > 0 && identChar(sql[i - 1]))) return null;
    DOLLAR_TAG_RE.lastIndex = i;
    var m = DOLLAR_TAG_RE.exec(sql);
    return m ? m[0] : null;
  }

  // Sann hvis en E'…'-streng (backslash-escapes) åpner på sql[i].
  function estringAt(sql, i) {
    return (sql[i] === 'e' || sql[i] === 'E') && i + 1 < sql.length && sql[i + 1] === "'" &&
      !(i > 0 && identChar(sql[i - 1]));
  }

  // Split a SQL script on top-level semicolons, ignoring those inside string
  // literals ('…'/"…", E'…' with backslash escapes, $$…$$/$tag$…$tag$),
  // -- line comments and /* … */ block comments. Returns non-empty, trimmed
  // statements (their own comments preserved).
  function splitSqlStatements(sql) {
    var stmts = [], buf = [];
    var i = 0, n = sql.length;
    var inSingle = false, inDouble = false, inLine = false, inBlock = false, inEstr = false;
    var dollarTag = null;
    while (i < n) {
      var c = sql[i];
      var nxt = i + 1 < n ? sql[i + 1] : '';
      if (dollarTag) {
        var j = sql.indexOf(dollarTag, i);
        var end = j === -1 ? n : j + dollarTag.length;
        buf.push(sql.slice(i, end));
        i = end;
        dollarTag = null;
      } else if (inEstr) {
        if (c === '\\' || (c === "'" && nxt === "'")) { buf.push(c); buf.push(nxt); i += 2; }
        else { buf.push(c); if (c === "'") inEstr = false; i += 1; }
      } else if (inLine) {
        buf.push(c);
        if (c === '\n') inLine = false;
        i += 1;
      } else if (inBlock) {
        buf.push(c);
        if (c === '*' && nxt === '/') { buf.push(nxt); i += 2; inBlock = false; }
        else i += 1;
      } else if (inSingle) {
        if (c === "'" && nxt === "'") { buf.push(c); buf.push(nxt); i += 2; }
        else { buf.push(c); if (c === "'") inSingle = false; i += 1; }
      } else if (inDouble) {
        buf.push(c);
        if (c === '"') inDouble = false;
        i += 1;
      } else if (c === '-' && nxt === '-') { inLine = true; buf.push(c); i += 1; }
      else if (c === '/' && nxt === '*') { inBlock = true; buf.push(c); i += 1; }
      else if (estringAt(sql, i)) { inEstr = true; buf.push(c); buf.push(nxt); i += 2; }
      else if (c === '$' && dollarTagAt(sql, i)) {
        dollarTag = dollarTagAt(sql, i);
        buf.push(dollarTag);
        i += dollarTag.length;
      }
      else if (c === "'") { inSingle = true; buf.push(c); i += 1; }
      else if (c === '"') { inDouble = true; buf.push(c); i += 1; }
      else if (c === ';') {
        var s = buf.join('').trim();
        // Rene kommentar-biter («-- ferdig» etter siste ;) er ikke setninger.
        if (s && scrub(s).trim()) stmts.push(s);
        buf = [];
        i += 1;
      } else { buf.push(c); i += 1; }
    }
    var tail = buf.join('').trim();
    if (tail && scrub(tail).trim()) stmts.push(tail);
    return stmts;
  }

  // sql med -- og /* */-kommentarer fjernet, innholdet i '…'-, E'…'- og
  // $$…$$/$tag$…$tag$-strenger erstattet med mellomrom, og "-tegn droppet (kvoterte identifikatorer overlever som
  // bare tokens). Brukes til identifikator-skanning og tom-script-sjekken.
  function scrub(sql, keepDquotes) {
    var out = [];
    var i = 0, n = sql.length;
    var inSingle = false, inLine = false, inBlock = false, inEstr = false;
    var dollarTag = null;
    while (i < n) {
      var c = sql[i];
      var nxt = i + 1 < n ? sql[i + 1] : '';
      if (dollarTag) {
        var j = sql.indexOf(dollarTag, i);
        if (j === -1) i = n;
        else { i = j + dollarTag.length; out.push(' '); }
        dollarTag = null;
      } else if (inEstr) {
        if (c === '\\' || (c === "'" && nxt === "'")) i += 2;
        else if (c === "'") { inEstr = false; out.push(' '); i += 1; }
        else i += 1;
      } else if (inLine) {
        if (c === '\n') { inLine = false; out.push(c); }
        i += 1;
      } else if (inBlock) {
        if (c === '*' && nxt === '/') { inBlock = false; i += 2; out.push(' '); }
        else i += 1;
      } else if (inSingle) {
        if (c === "'" && nxt === "'") i += 2;
        else if (c === "'") { inSingle = false; out.push(' '); i += 1; }
        else i += 1;
      } else if (c === '-' && nxt === '-') { inLine = true; i += 2; }
      else if (c === '/' && nxt === '*') { inBlock = true; i += 2; }
      else if (estringAt(sql, i)) { inEstr = true; i += 2; }  // E-prefikset droppes også
      else if (c === '$' && dollarTagAt(sql, i)) { dollarTag = dollarTagAt(sql, i); i += dollarTag.length; }
      else if (c === "'") { inSingle = true; i += 1; }
      else if (c === '"') { if (keepDquotes) out.push(c); i += 1; }
      else { out.push(c); i += 1; }
    }
    return out.join('');
  }

  // NB: \w er ASCII-only i JS men unicode i Python — fortsettelsestegnene må
  // derfor være \p{L}\p{N}_ (med u-flagg) for at «lønn» o.l. skal matche som
  // i duckdb_bridge.py (review 2026-07-11 funn 3).
  var IDENT = '(?:"(?:[^"]|"")+"|[A-Za-z_][\\p{L}\\p{N}_]*)';
  var CREATE_RE = new RegExp('\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:TEMP(?:ORARY)?\\s+)?TABLE\\s+' +
    '(?:IF\\s+NOT\\s+EXISTS\\s+)?((?:' + IDENT + '\\s*\\.\\s*){0,2}' + IDENT + ')', 'giu');
  var IDENT_RE = new RegExp(IDENT, 'gu');

  // Targets of CREATE [OR REPLACE] [TEMP] TABLE [IF NOT EXISTS] name.
  // Order-preserving, deduped, unquoted. Kvalifisert navn (main.res) → siste
  // del; kvotert ("my-t") → hele teksten.
  function extractCreatedTables(statements) {
    var names = [];
    statements.forEach(function (stmt) {
      var scrubbed = scrub(stmt, true);
      var m;
      CREATE_RE.lastIndex = 0;
      while ((m = CREATE_RE.exec(scrubbed)) !== null) {
        var parts = m[1].match(IDENT_RE);
        var nm = parts[parts.length - 1];
        if (nm.charAt(0) === '"') nm = nm.slice(1, -1).replace(/""/g, '"');
        if (names.indexOf(nm) === -1) names.push(nm);
      }
    });
    return names;
  }

  // The last statement if it begins with SELECT or WITH (a previewable result
  // set), else null.
  function buildPreviewSelect(statements) {
    if (!statements.length) return null;
    var last = statements[statements.length - 1];
    var head = scrub(last).replace(/^\s+/, '').toUpperCase();
    if (head.indexOf('SELECT') === 0 || head.indexOf('WITH') === 0) return last;
    return null;
  }

  // Tekst-tabell fra __arrowToColumns-kolonner ({navn: [verdier]}) — erstatter
  // DataFrame.to_string(index=False) i den native veien: høyrejusterte
  // kolonner med to mellomrom imellom, null → "NaN" som pandas viser det.
  function formatColumnsText(cols) {
    var names = Object.keys(cols);
    if (!names.length) return '';
    var nRows = cols[names[0]].length;
    var cells = names.map(function (name) {
      var out = [name];
      for (var r = 0; r < nRows; r++) {
        var v = cols[name][r];
        out.push(v === null || v === undefined ? 'NaN' : String(v));
      }
      return out;
    });
    var widths = cells.map(function (col) {
      return col.reduce(function (w, s) { return Math.max(w, s.length); }, 0);
    });
    var lines = [];
    for (var r = 0; r <= nRows; r++) {
      var line = cells.map(function (col, ci) {
        var s = col[r];
        return new Array(widths[ci] - s.length + 1).join(' ') + s;
      }).join('  ');
      lines.push(line.replace(/\s+$/, ''));
    }
    return lines.join('\n');
  }

  var api = {
    splitSqlStatements: splitSqlStatements,
    scrub: scrub,
    extractCreatedTables: extractCreatedTables,
    buildPreviewSelect: buildPreviewSelect,
    formatColumnsText: formatColumnsText
  };
  global.DuckdbNative = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
