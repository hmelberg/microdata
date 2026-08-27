// js/ai-transport.js — transportlaget for /api/*-kallene i AI-chatten.
//
// To jobber, begge født av en udiagnostiserbar «✗ NetworkError when
// attempting to fetch resource» (Firefox' generiske «tilkoblingen røk»):
//
//   postWithRetry  — fetch som tåler nettblipp og 429/502/503/504 med kort
//                    backoff. Retry skjer KUN før vi har fått et svar å lese;
//                    et brudd midt i en SSE-strøm skal aldri re-POSTes herfra
//                    (delvis tekst kan alt være rendret, og et data-svar-hopp
//                    ville kjørt — og fakturert — samme modell-turn på nytt).
//   describeError  — navngir endepunkt og fase (før svar / underveis, evt.
//                    fortsettelses-runde) slik at neste feilmelding forklarer
//                    seg selv. Bevisste, allerede oversatte meldinger (401-
//                    tekstene osv.) passerer urørt; originalen beholdes i
//                    parentes for feilsøking.
//
// Egen fil, ikke inne i ai-chat.js: samme mønster som js/ai-credential.js —
// ai-chat.js krever ekte DOM ved lasting, ren logikk må bo for seg for å
// være node-testbar.
(function (global) {
  'use strict';

  var RETRYABLE_STATUS = { 429: true, 502: true, 503: true, 504: true };
  var DEFAULT_BACKOFF_MS = [500, 1500];
  var MAX_RETRY_AFTER_MS = 5000;

  async function postWithRetry(url, init, deps) {
    deps = deps || {};
    var fetchImpl = deps.fetchImpl || global.fetch.bind(global);
    var sleep = deps.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var retries = typeof deps.retries === 'number' ? deps.retries : 2;

    var lastError = null;
    for (var attempt = 0; attempt <= retries; attempt++) {
      var backoff = DEFAULT_BACKOFF_MS[Math.min(attempt, DEFAULT_BACKOFF_MS.length - 1)];
      try {
        var resp = await fetchImpl(url, init);
        if (RETRYABLE_STATUS[resp.status] && attempt < retries) {
          var ra = parseInt((resp.headers && resp.headers.get && resp.headers.get('retry-after')) || '', 10);
          await sleep(isFinite(ra) && ra > 0 ? Math.min(ra * 1000, MAX_RETRY_AFTER_MS) : backoff);
          continue;
        }
        return resp;   // alle andre statuser er kallstedets ansvar
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;   // brukeren avbrøt — aldri retry
        lastError = e;
        if (attempt < retries) { await sleep(backoff); continue; }
        throw e;
      }
    }
    throw lastError;
  }

  // Nettleseren sier «tilkoblingen røk» på tre dialekter.
  function isNetworkError(e) {
    var m = (e && e.message) || '';
    return /NetworkError|Failed to fetch|Load failed/i.test(m);
  }

  function describeError(e, ctx) {
    ctx = ctx || {};
    var msg = (e && e.message) ? e.message : String(e);
    var api = '/api/' + (ctx.endpoint || 'ukjent');
    var hop = typeof ctx.hop === 'number' ? ' i fortsettelses-runde ' + ctx.hop : '';
    if (isNetworkError(e)) {
      return ctx.phase === 'stream'
        ? 'Strømmen fra ' + api + ' røk underveis' + hop + ' (nettverksfeil: ' + msg + '). Prøv igjen.'
        : 'Fikk ikke kontakt med ' + api + hop + ' — nettverksfeil etter flere forsøk (' + msg + '). Sjekk nettet og prøv igjen.';
    }
    if (/^HTTP \d/.test(msg)) return msg + ' [' + api + ']';
    return msg;   // bevisst kastet, allerede forståelig — ikke pakk inn
  }

  global.AiTransport = { postWithRetry: postWithRetry, describeError: describeError };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { postWithRetry: postWithRetry, describeError: describeError };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
