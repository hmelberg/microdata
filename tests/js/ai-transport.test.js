// tests/js/ai-transport.test.js — retry + feilbeskrivelse for /api/*-kallene.
// Bakgrunn: Hans fikk «✗ NetworkError when attempting to fetch resource» uten
// endepunkt eller fase — udiagnostiserbart. postWithRetry tåler nettblipp og
// 429/5xx; describeError navngir endepunkt og fase, men rører ALDRI bevisste
// (allerede oversatte) feilmeldinger.
const test = require('node:test');
const assert = require('node:assert');
const { postWithRetry, describeError } = require('../../js/ai-transport.js');

function netErr() {
  const e = new TypeError('NetworkError when attempting to fetch resource.');
  return e;
}
function resp(status, retryAfter) {
  return { status, ok: status >= 200 && status < 300,
    headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? retryAfter ?? null : null) } };
}

test('postWithRetry: nettverksfeil → prøver igjen og lykkes', async () => {
  let calls = 0; const slept = [];
  const r = await postWithRetry('/api/x', {}, {
    fetchImpl: async () => { calls++; if (calls === 1) throw netErr(); return resp(200); },
    sleep: async (ms) => slept.push(ms),
  });
  assert.equal(r.status, 200);
  assert.equal(calls, 2);
  assert.equal(slept.length, 1);
});

test('postWithRetry: 502 → prøver igjen; 401 → returneres uten retry', async () => {
  let calls = 0;
  const r = await postWithRetry('/api/x', {}, {
    fetchImpl: async () => { calls++; return calls === 1 ? resp(502) : resp(200); },
    sleep: async () => {},
  });
  assert.equal(r.status, 200);
  assert.equal(calls, 2);

  let calls2 = 0;
  const r2 = await postWithRetry('/api/x', {}, {
    fetchImpl: async () => { calls2++; return resp(401); },
    sleep: async () => {},
  });
  assert.equal(r2.status, 401);
  assert.equal(calls2, 1);
});

test('postWithRetry: 429 med Retry-After respekteres (sekunder, cappet)', async () => {
  let calls = 0; const slept = [];
  await postWithRetry('/api/x', {}, {
    fetchImpl: async () => { calls++; return calls === 1 ? resp(429, '2') : resp(200); },
    sleep: async (ms) => slept.push(ms),
  });
  assert.equal(slept[0], 2000);
});

test('postWithRetry: gir opp etter uttømte forsøk og kaster siste feil', async () => {
  let calls = 0;
  await assert.rejects(
    postWithRetry('/api/x', {}, {
      fetchImpl: async () => { calls++; throw netErr(); },
      sleep: async () => {},
      retries: 2,
    }),
    /NetworkError/,
  );
  assert.equal(calls, 3);
});

test('postWithRetry: AbortError kastes umiddelbart uten retry', async () => {
  let calls = 0;
  const abort = new Error('The operation was aborted.');
  abort.name = 'AbortError';
  await assert.rejects(
    postWithRetry('/api/x', {}, {
      fetchImpl: async () => { calls++; throw abort; },
      sleep: async () => { throw new Error('skal ikke sove'); },
    }),
    (e) => e.name === 'AbortError',
  );
  assert.equal(calls, 1);
});

test('describeError: nettverksfeil før svar navngir endepunktet', () => {
  const msg = describeError(netErr(), { endpoint: 'kode-svar', phase: 'request' });
  assert.match(msg, /\/api\/kode-svar/);
  assert.match(msg, /nettverksfeil/i);
  assert.match(msg, /NetworkError/);   // originalen bevart for feilsøking
});

test('describeError: brudd underveis i strømmen sier det, med runde-nummer', () => {
  const msg = describeError(netErr(), { endpoint: 'data-svar', phase: 'stream', hop: 3 });
  assert.match(msg, /\/api\/data-svar/);
  assert.match(msg, /underveis/);
  assert.match(msg, /runde 3/);
});

test('describeError: HTTP-feil får endepunkt-merkelapp', () => {
  const msg = describeError(new Error('HTTP 500 Internal'), { endpoint: 'kode-svar', phase: 'request' });
  assert.match(msg, /HTTP 500 Internal/);
  assert.match(msg, /\/api\/kode-svar/);
});

test('describeError: bevisste (oversatte) meldinger passerer urørt', () => {
  const msg = describeError(new Error('Ugyldig API-nøkkel. Sjekk nøkkelen i AI-innstillingene.'),
    { endpoint: 'kode-svar', phase: 'request' });
  assert.equal(msg, 'Ugyldig API-nøkkel. Sjekk nøkkelen i AI-innstillingene.');
});
