// byggHistorikk: hvilke tidligere turer modellen får se.
//
// Chatten hadde ingen hukommelse i det hele tatt fram til 2026-08-29 —
// questionTurn() bygde brukerturen av dagens spørsmål alene, og state.history
// ble bare brukt til å tegne tråden. Journalen viste hva det kostet: Hans
// svarte «2022, 35-55 år, ja filltrer» på et oppklarende spørsmål modellen
// ikke lenger visste at den hadde stilt.
//
// Logikken bor i ai-transport.js fordi den er ren og node-testbar. Én av-for-en
// her ville ingen merket: modellen ville bare virket litt mer glemsk.
const test = require('node:test');
const assert = require('node:assert');
const { byggHistorikk } = require('../../js/ai-transport.js');

const bruker = (t) => ({ role: 'user', text: t });
const svar = (t) => ({ role: 'assistant', meta: { markdown: t } });

test('SISTE post er dagens spørsmål og skal aldri bli med', () => {
  // Kritisk: sendSvarMessage pusher spørsmålet til history FØR runSvar kalles,
  // så den siste posten er det brukeren spør om akkurat nå. Kom den med, ville
  // modellen sett spørsmålet to ganger — én gang som «tidligere» og én gang
  // som sitt faktiske oppdrag.
  const h = byggHistorikk([bruker('først'), svar('svar 1'), bruker('NÅ')]);
  assert.deepStrictEqual(h.map((p) => p.tekst), ['først', 'svar 1']);
});

test('tar de tre siste utvekslingene, ikke flere', () => {
  const hist = [];
  for (let i = 1; i <= 5; i++) { hist.push(bruker('sp' + i), svar('sv' + i)); }
  hist.push(bruker('NÅ'));
  const h = byggHistorikk(hist);
  assert.strictEqual(h.length, 6, 'tre utvekslinger = seks meldinger');
  assert.deepStrictEqual(h.map((p) => p.tekst), ['sp3', 'sv3', 'sp4', 'sv4', 'sp5', 'sv5']);
});

test('rollene navngis for serveren, og rekkefølgen er kronologisk', () => {
  const h = byggHistorikk([bruker('a'), svar('b'), bruker('NÅ')]);
  assert.deepStrictEqual(h.map((p) => p.rolle), ['bruker', 'assistent']);
});

test('lange svar kappes, spørsmål slipper gjennom', () => {
  const langt = 'S'.repeat(5000);
  const h = byggHistorikk([bruker('kort'), svar(langt), bruker('NÅ')]);
  assert.strictEqual(h[1].tekst.length, 2000, 'svar kappes på 2000');
  assert.strictEqual(h[0].tekst, 'kort');
});

test('poster uten tekst hoppes over i stedet for å bli tomme turer', () => {
  // En avbrutt tur gir en assistent-post uten markdown. En tom assistent-tur
  // ville sett ut som at modellen svarte ingenting.
  const h = byggHistorikk([
    bruker('a'), { role: 'assistant', meta: {} }, bruker('b'), svar('c'), bruker('NÅ'),
  ]);
  assert.deepStrictEqual(h.map((p) => p.tekst), ['a', 'b', 'c']);
});

test('tom eller manglende historikk gir tom liste, ikke krasj', () => {
  assert.deepStrictEqual(byggHistorikk([]), []);
  assert.deepStrictEqual(byggHistorikk([bruker('NÅ')]), []);
  assert.deepStrictEqual(byggHistorikk(undefined), []);
});
