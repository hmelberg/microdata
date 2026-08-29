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
//                    Navnet er historisk (opprinnelig kun POST); ai-chat.js
//                    bruker den også med method:'GET' mot /api/svar-tail
//                    (Task 7) — trygt der fordi en GET mot tail-avspillingen
//                    ikke fakturerer noe og er idempotent (ren avlesning fra
//                    Blobs, samme markør gir samme innhold).
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

  var MAKS_OVERLEVERINGER = 40;   // speiler hop > 40-vakten i ai-chat.js sin ytre løkke

  // Ren beslutning, uten DOM og uten nettverk: gitt hvor mange overleveringer
  // som er brukt og om DENNE overleveringen alt er forsøkt på nytt, hva gjør vi?
  // Ligger her og ikke i ai-chat.js fordi consumeMedTail med vilje er bundet til
  // DOM-closuren (markdown/bubble) og derfor ikke kan node-testes — mens nettopp
  // denne logikken er den eneste i overleveringskjeden som kan miste HELE svaret.
  //
  // Kalles fra to steder i consumeMedTail, med to ulike state-former:
  //   1. Før hvert forsøk (feilet:false) — er det budsjett igjen?
  //   2. I catch-blokken rett etter et mislykket forsøk (feilet:true) — prøv
  //      denne overleveringen på nytt én gang, eller gi opp med feilen?
  //
  // Tellersemantikk (bevisst, ikke opplagt): `overleveringer` teller FORSØK,
  // ikke distinkte overleveringer — et retry-forsøk på samme markør bruker
  // OGSÅ ett budsjett-hakk. Grunnen: 'prov-igjen' sender kallstedet tilbake
  // til beslutning 1 (feilet:false) FØR neste fetch, og den kalles med
  // `overleveringer` alt økt med det mislykkede forsøket. Uten det kunne en
  // flaky forbindelse som feiler annethvert forsøk holdt løkka i live langt
  // forbi de tiltenkte ~30 minuttene (40 × 45s).
  function nesteTailSteg(state) {
    state = state || {};
    var overleveringer = state.overleveringer || 0;
    var maks = typeof state.maks === 'number' ? state.maks : MAKS_OVERLEVERINGER;
    if (state.feilet) {
      // Andre feil på SAMME overlevering (samme markør) — gi opp med den
      // underliggende feilen. Budsjettet spiller ingen rolle her: et forsøk
      // som allerede har brukt sin ene omkamp, skal ikke få en til.
      return state.forsokt ? 'gi-opp-feil' : 'prov-igjen';
    }
    return overleveringer < maks ? 'hent' : 'gi-opp-overleveringer';
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

  global.AiTransport = { postWithRetry: postWithRetry, describeError: describeError, nesteTailSteg: nesteTailSteg };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { postWithRetry: postWithRetry, describeError: describeError, nesteTailSteg: nesteTailSteg };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
