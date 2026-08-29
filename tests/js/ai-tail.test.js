// tests/js/ai-tail.test.js — den rene overleverings-beslutningen
// (AiTransport.nesteTailSteg), node-testet fordi consumeMedTail selv ikke kan
// være det: den er med vilje bundet til DOM-closuren i ai-chat.js (markdown/
// bubble), se kommentaren over consumeMedTail. Denne lille funksjonen er
// likevel den ENESTE logikken i overleveringskjeden som kan miste HELE svaret
// (dobbel-tapt markør eller en løkke som aldri gir seg), så den skal ha
// dekning selv om den koden den styrer, ikke kan testes direkte.
const test = require('node:test');
const assert = require('node:assert');
const { nesteTailSteg } = require('../../js/ai-transport.js');

test('nesteTailSteg: normal overlevering (lavt forbruk, ingen feil) → hent', () => {
  assert.equal(nesteTailSteg({ overleveringer: 0, feilet: false }), 'hent');
  assert.equal(nesteTailSteg({ overleveringer: 17, feilet: false }), 'hent');
});

test('nesteTailSteg: første feil på en overlevering → prøv igjen', () => {
  assert.equal(nesteTailSteg({ overleveringer: 5, forsokt: false, feilet: true }), 'prov-igjen');
});

test('nesteTailSteg: andre feil på SAMME overlevering → gi opp med feilen', () => {
  assert.equal(nesteTailSteg({ overleveringer: 5, forsokt: true, feilet: true }), 'gi-opp-feil');
});

test('nesteTailSteg: 40. overlevering går gjennom, 41. gir opp', () => {
  // 39 alt brukt → dette forsøket er det 40.
  assert.equal(nesteTailSteg({ overleveringer: 39, feilet: false }), 'hent');
  // 40 alt brukt → dette forsøket ville vært det 41.
  assert.equal(nesteTailSteg({ overleveringer: 40, feilet: false }), 'gi-opp-overleveringer');
});

test('nesteTailSteg: manglende overleveringer/forsokt behandles som 0/false (default state)', () => {
  assert.equal(nesteTailSteg({}), 'hent');
  assert.equal(nesteTailSteg(), 'hent');
  assert.equal(nesteTailSteg({ feilet: true }), 'prov-igjen');   // forsokt utelatt → false
});

test('nesteTailSteg: en vellykket retry (etter prov-igjen) bruker OGSÅ et budsjett-hakk', () => {
  // Speiler den faktiske løkka i consumeMedTail: et mislykket forsøk teller,
  // og selve retry-forsøket teller IGJEN når det kommer tilbake til
  // budsjett-sjekken. Uten dette kunne en flaky forbindelse som feiler
  // annethvert forsøk holdt løkka i live langt forbi de tiltenkte ~30 min.
  let overleveringer = 39;
  // Forsøk nr. 40 (indeks 39): sjekk budsjett først.
  assert.equal(nesteTailSteg({ overleveringer, feilet: false }), 'hent');
  overleveringer++;   // caller øker ETTER 'hent', slik consumeMedTail gjør
  assert.equal(overleveringer, 40);
  // Det feiler — første gang for DENNE overleveringen.
  assert.equal(nesteTailSteg({ overleveringer, forsokt: false, feilet: true }), 'prov-igjen');
  // Tilbake til budsjett-sjekken for selve retry-forsøket: 40 alt brukt →
  // budsjettet er tomt, selv om denne spesifikke markøren aldri har fått
  // sin lovede ene omkamp.
  assert.equal(nesteTailSteg({ overleveringer, feilet: false }), 'gi-opp-overleveringer');
});

test('nesteTailSteg: egendefinert maks overstyrer 40', () => {
  assert.equal(nesteTailSteg({ overleveringer: 1, maks: 2, feilet: false }), 'hent');
  assert.equal(nesteTailSteg({ overleveringer: 2, maks: 2, feilet: false }), 'gi-opp-overleveringer');
});
