// netlify/edge-functions/svar-tail.ts — plukker opp en svarjobb der forrige
// tailer overleverte. Ingen modellkall skjer her; dette er en ren avspilling
// fra Blobs, og derfor billig å gjenoppta så mange ganger det trengs.
import { type IpContext } from "./_lib/auth.ts";
import { gate, jobbStore } from "./_lib/deno-kabling.ts";
import { SSE_HEADERS, tailStream } from "./_lib/jobb-tail.ts";

export default async (request: Request, context: IpContext): Promise<Response> => {
  // Samme port som /api/svar. Rate-limiten teller ikke her: dette er samme
  // spørsmål, bare neste avspillingsvindu.
  const gateResp = await gate(request, {
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
    tailStream({ store: jobbStore(), jobId, fra }),
    { headers: SSE_HEADERS },
  );
};
