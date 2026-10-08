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

  function norm(v) {
    return String(v == null ? '' : v).trim().replace(/\/+$/, '');
  }

  // Leverandørbytte i innstillingene: et felt som er tomt eller fortsatt
  // bærer FORRIGE presets standardverdi byttes til den nye presetens verdi.
  // Ellers ville f.eks. OpenAI → Mistral beholdt api.openai.com, og den nye
  // Mistral-nøkkelen blitt sendt dit. Det brukeren selv har skrevet beholdes.
  function swapPresetField(current, prevDefault, newDefault) {
    var cur = norm(current);
    var prev = norm(prevDefault);
    if (!cur || (prev && cur === prev)) return newDefault || '';
    return String(current);
  }

  // Sant når en (beholdt) egen URL peker til en annen vert enn presetet
  // brukeren valgte — da sendes nøkkelen et annet sted enn navnet tilsier,
  // og innstillingene viser en advarsel.
  function baseUrlMismatch(url, presetUrl) {
    var u = norm(url), p = norm(presetUrl);
    if (!u || !p) return false;
    try {
      return new URL(u).host.toLowerCase() !== new URL(p).host.toLowerCase();
    } catch (e) {
      return true;
    }
  }

  global.AiCredential = { classify: classify, swapPresetField: swapPresetField, baseUrlMismatch: baseUrlMismatch };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { classifyCredential: classify, swapPresetField: swapPresetField, baseUrlMismatch: baseUrlMismatch };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
