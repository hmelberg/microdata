// _lib/jobb-blobb.ts — protokollen mellom bakgrunnsjobben (skriver) og
// edge-taileren (leser). Chunkene holder RÅ SSE-tekst, ikke parsede objekter:
// da blir taileren en ren bytepumpe, event-kontrakten mot ai-chat.js overlever
// uendret, og anthropic.ts trenger ingen ny krok.
//
// INVARIANT: chunk skrives FØR head oppdateres. Leseren rykker bare fram når
// head flytter seg, og kan derfor aldri be om en chunk som ikke finnes ennå.
// Snus rekkefølgen, får leseren sporadiske tomme chunks midt i et svar.

export interface BlobbStore {
  get(key: string, opts?: { type?: "text" | "json" }): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
  setJSON(key: string, value: unknown): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  list(opts: { prefix: string }): Promise<{ blobs: { key: string }[] }>;
}

export interface JobbHead {
  seq: number;
  state: "kjorer" | "ferdig" | "feil";
  start: number;
}

export interface JobbSkriver {
  /** Skriver head UBETINGET, uansett bufferstatus — se lagSkriver for hvorfor. */
  start(): Promise<void>;
  skriv(sse: string): Promise<void>;
  avslutt(state: "ferdig" | "feil"): Promise<void>;
}

const FLUSH_MS = 150;

// Kontroll-events må aldri ligge og vente i bufferen: klienten kan ikke kjøre
// scriptet, fortsette løpet eller vise feilen før den har sett dem.
const TVINGER_FLUSH = /"type"\s*:\s*"(run_code|continue|done|error)"/;

export const chunkNokkel = (jobId: string, seq: number): string =>
  `${jobId}/${String(seq).padStart(6, "0")}`;

export const headNokkel = (jobId: string): string => `${jobId}/head`;

export function lagSkriver(
  store: BlobbStore,
  jobId: string,
  now: () => number,
): JobbSkriver {
  const start = now();
  let buffer = "";
  let seq = 0;
  let sistFlush = start;

  // Alle skrivinger serialiseres gjennom denne kjeden. Uten den deler skriv()
  // og flush() muterbar tilstand (buffer, seq) på tvers av await, og to
  // overlappende kall kan både miste buffret innhold og la head peke på en
  // chunk som ikke er skrevet ennå — nøyaktig feilen chunk-før-head finnes
  // for å hindre. Kjeden gjør modulen trygg uavhengig av kallerens disiplin,
  // i stedet for å hvile på en uskreven forutsetning hos kalleren.
  let kjede: Promise<void> = Promise.resolve();
  const iKo = (f: () => Promise<void>): Promise<void> => {
    const neste = kjede.then(f, f);   // en feilet skriving stopper ikke de neste
    kjede = neste.catch(() => {});    // kalleren ser sin egen feil; kjeden går videre
    return neste;
  };

  const flush = async (state: JobbHead["state"]): Promise<void> => {
    if (buffer.length > 0) {
      seq++;
      await store.set(chunkNokkel(jobId, seq), buffer);   // FØRST
      buffer = "";
    }
    await store.setJSON(headNokkel(jobId), { seq, state, start });  // SÅ
    sistFlush = now();
  };

  return {
    // Skriver head FØR byggLop/prefiks-oppbyggingen engang starter — se
    // svar-jobb.mts. Uten dette venter taileren (ventPaaHeadMs, default 10 s)
    // på den FØRSTE flush()-en fra skriv(), som ikke skjer før modellen har
    // produsert noe å sende: en kald bakgrunns-invokasjon + runGate/resolveLlm
    // + buildCachedPrefix (tre fetch + 652 KB JSON.parse) kan alene bruke opp
    // det budsjettet, og brukeren får «Svarjobben startet aldri» mens jobben
    // faktisk kjører videre i bakgrunnen i opptil 13 minutter til (Fix 2,
    // sluttfiks-planen 2026-08-28). Går gjennom iKo som alt annet, slik at en
    // skriv() som rekker å starte FØR denne (bør aldri skje, men iKo gjør det
    // ufarlig uansett) ikke kan skrive en head med lavere seq etterpå.
    start(): Promise<void> {
      return iKo(async () => {
        await store.setJSON(headNokkel(jobId), { seq: 0, state: "kjorer", start });
      });
    },
    skriv(sse: string): Promise<void> {
      return iKo(async () => {
        buffer += sse;
        if (TVINGER_FLUSH.test(sse) || now() - sistFlush >= FLUSH_MS) {
          await flush("kjorer");
        }
      });
    },
    avslutt(state: "ferdig" | "feil"): Promise<void> {
      return iKo(() => flush(state));
    },
  };
}

export async function lesHead(
  store: BlobbStore,
  jobId: string,
): Promise<JobbHead | null> {
  const h = await store.get(headNokkel(jobId), { type: "json" });
  return (h && typeof h === "object") ? h as JobbHead : null;
}

/** Halvåpent intervall (fra, til] — `fra` er markøren klienten alt har sett. */
export async function lesChunks(
  store: BlobbStore,
  jobId: string,
  fra: number,
  til: number,
): Promise<string[]> {
  const nokler: string[] = [];
  for (let s = fra + 1; s <= til; s++) nokler.push(chunkNokkel(jobId, s));
  const verdier = await Promise.all(
    nokler.map((k) => store.get(k, { type: "text" })),
  );
  return verdier.map((v) => typeof v === "string" ? v : "");
}

/** Best-effort opprydding. Feiler ALDRI oppover — en udreptt jobb er ufarlig
 * (den timeglass-ryddes av rydd-jobber), en kastet feil ville drept svaret. */
export async function slettJobb(store: BlobbStore, jobId: string): Promise<void> {
  try {
    const { blobs } = await store.list({ prefix: `${jobId}/` });
    await Promise.all(blobs.map((b) => store.delete(b.key)));
  } catch (_e) { /* ignorert med vilje */ }
}
