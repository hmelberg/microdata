// js/run-result.js — formatterer en kjøring til run_result-strengen serveren
// klassifiserer på (run-disiplin.ts: startsWith('OK.') = suksess, alt annet
// = feil). Prefiksene er KRYSS-LAG-KONTRAKT — endres de her, må
// klassifisereren endres i samme commit.
//
// Egen fil (samme mønster som js/ai-credential.js): ai-chat.js krever DOM
// ved lasting; en ren regel må bo for seg for å være node-testbar.
(function (global) {
  'use strict';

  var MAX_OUTPUT = 6000;

  function formatRunResult(res) {
    var ok = !!(res && res.ok);
    var output = String((res && res.output) || '').trim();
    if (!output) output = ok ? '(ingen tekst-output)' : '(ingen feiltekst)';
    if (output.length > MAX_OUTPUT) {
      output = output.slice(0, MAX_OUTPUT) + '\n[…avkortet]';
    }
    return ok ? 'OK. OUTPUT (truncated):\n' + output : 'FEIL:\n' + output;
  }

  global.RunResult = { format: formatRunResult };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { formatRunResult: formatRunResult };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
