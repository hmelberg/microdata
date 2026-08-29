// netlify/edge-functions/svar-tail.ts — plukker opp en svarjobb der forrige
// tailer overleverte. Ingen modellkall skjer her; dette er en ren avspilling
// fra Blobs, og derfor billig å gjenoppta så mange ganger det trengs.
import { type IpContext } from "./_lib/auth.ts";
import { jobbStore, tailGate } from "./_lib/deno-kabling.ts";
import { SSE_HEADERS, tailStream } from "./_lib/jobb-tail.ts";

export default async (request: Request, context: IpContext): Promise<Response> => {
  // Samme port som /api/svar, MEN uten rate-limiten: tailGate (deno-kabling.ts)
  // er kablet med en no-op checkRateLimit, så dette kallet ALDRI teller — en
  // tail er samme spørsmål som allerede talte mot 60/t-grensen på /api/svar,
  // bare neste avspillingsvindu (Task 6 review-funn 1: med den vanlige
  // `gate()` fikk svar-tail sin EGEN bøtte under en annen endpoint-nøkkel, og
  // en 13-minutters jobb med ~17 håndoverleveringer traff 429 midt i strømmen
  // på den fjerde lange jobben innen én time).
  //
  // allowByok/allowLlmKey er PÅKREVD her selv om endepunktet verken ringer
  // opp en modell eller bruker en servernøkkel — se unntaket skrevet ned ved
  // GateOptions.allowByok/allowLlmKey i auth.ts. En BYOK-bruker har ingen
  // bearer-token å presentere, og uten et av disse flaggene kunne hen aldri
  // koblet seg på sin egen strøm igjen. Den faktiske kapabiliteten som
  // beskytter dette endepunktet er jobb-UUID-en i URL-en, ikke nøkkelen.
  const gateResp = await tailGate(request, {
    endpoint: "svar-tail", maxBodyBytes: 0, allowByok: true, allowLlmKey: true,
    allowedMethods: ["GET"],
  }, context);
  if (gateResp) return gateResp;

  const url = new URL(request.url);
  const jobId = url.searchParams.get("job") ?? "";
  const fra = Number(url.searchParams.get("from") ?? "0");
  if (!/^[0-9a-f-]{36}$/.test(jobId) || !Number.isInteger(fra) || fra < 0) {
    return new Response("Ugyldig jobb-referanse", { status: 400 });
  }
  return new Response(
    tailStream({
      store: jobbStore(), jobId, fra,
      // 1 s, ikke default (10 s): en overlevering blir KUN sendt for en jobb
      // hvis head allerede finnes (se jobb-tail.ts), så en GJENOPPTATT tail
      // venter aldri legitimt på at den første skrives. Uten dette kjøper en
      // uautentisert kaller med en tilforlatelig nøkkel opptil 10 sekunders
      // edge-invokasjon og rundt 83 Blobs-lesinger (10000ms / pollMs 120ms)
      // for et jobId som aldri fantes.
      ventPaaHeadMs: 1000,
    }),
    { headers: SSE_HEADERS },
  );
};
