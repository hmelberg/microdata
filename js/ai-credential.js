// js/ai-credential.js — hvilken legitimasjon skrev brukeren inn?
//
// AI-innstillingene har ETT felt som tar både en Anthropic-nøkkel og det
// delte tilgangspassordet. Skillet er entydig: en Anthropic-nøkkel starter
// ALLTID med «sk-ant-» (serverens extractByokKey håndhever samme prefiks),
// og et passord gjør det aldri.
//
// Konsekvens verdt å kjenne: en feilklipt nøkkel som mistet prefikset leses
// som passord, og brukeren får «feil passord» i stedet for «ugyldig nøkkel».
// Derfor sier hjelpeteksten i innstillingene fra om det.
//
// Egen fil, ikke inne i ai-chat.js: den fila krever ekte DOM ved lasting
// (window.t, window.markdownit), så en ren regel som denne er bare testbar
// når den bor for seg — samme mønster som js/names.js.
(function (global) {
  'use strict';

  function classify(value) {
    if (typeof value !== 'string') return 'none';
    var v = value.trim();
    if (!v) return 'none';
    return v.indexOf('sk-ant-') === 0 ? 'anthropic' : 'access';
  }

  global.AiCredential = { classify: classify };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { classifyCredential: classify };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
