import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { tailGate } from "./deno-kabling.ts";

// MAX_CALLS i rate-limit.ts er 60/time — kjør godt over det for å bevise at
// tailGate aldri fyller opp (eller for den saks skyld: aldri RØRER) en bøtte.
const OVER_GRENSEN = 65;

function tailReq(ip: string): Request {
  const h = new Headers();
  // En vilkårlig, ikke-tom Bearer holder unna 401-"missing token"-veien
  // (auth.ts steg 1) slik at kallet faktisk NÅR fram til rate-limit-steget
  // (steg 4) — det er nettopp DET steget denne testen vil observere.
  h.set("authorization", "Bearer test-token-uten-betydning");
  h.set("x-nf-client-connection-ip", ip);
  return new Request("https://example.test/api/svar-tail?job=x&from=0", {
    method: "GET",
    headers: h,
  });
}

Deno.test("tailGate: aldri 429 og rører aldri den ekte butikken, uansett antall kall", async () => {
  // Fanger checkRateLimits fail-open-advarsel ("rate-limit store error
  // (failing open)"). Hvis tailGate i stedet var kablet med den ekte
  // rateLimitDep (som ruller mot Netlify Blobs via esm.sh-getStore), ville
  // HVERT eneste kall her feilet synkront med MissingBlobsEnvironmentError
  // (ingen Blobs-kontekst i testmiljøet), blitt fanget av
  // checkRateLimit-fail-open-logikken, og logget én advarsel per kall.
  // ingenRateLimit rører aldri butikken og logger derfor ALDRI. Og i et
  // miljø der Blobs FAKTISK virker, ville en reversert tailGate i stedet
  // returnert 429 fra kall 61 og utover — fanget av assertEquals-en i
  // løkken under. Testen diskriminerer altså uansett hvilken vei
  // testmiljøet svikter i.
  const advarsler: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { advarsler.push(args); };
  const opts = { endpoint: "svar-tail", maxBodyBytes: 0, allowedMethods: ["GET"] };
  try {
    for (let i = 0; i < OVER_GRENSEN; i++) {
      const resp = await tailGate(tailReq("203.0.113.9"), opts);
      // Uten gyldig passord blir dette en 401 fra auth-steget (steg 5) —
      // det som betyr noe her er BARE at det aldri er 429 (steg 4).
      assertEquals(resp?.status === 429, false, `kall ${i + 1} ga 429`);
    }
  } finally {
    console.warn = originalWarn;
  }
  assertEquals(advarsler.length, 0);
});
