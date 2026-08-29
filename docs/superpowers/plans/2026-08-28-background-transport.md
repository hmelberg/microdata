# Background-transport for /api/svar — implementasjonsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flytt det agentiske svar-løpet inn i en Netlify background-funksjon med
Blobs-relé og edge-tailer, slik at ingen forespørsel kan kuttes av 60-sekunders-
plattformtaket — og fjern stillheten brukeren opplever før første tekst.

**Architecture:** `/api/svar` (edge) autentiserer som i dag, lager en `jobId`,
fyrer av en background-funksjon (15 min) og blir så *tailer* mot Blobs-storen
`svarjobb`. Bakgrunnsjobben kjører `runAgenticStream` og pumper **rå SSE-bytes**
til nummererte chunks. Taileren poller, videresender bytene til klienten, og
overleverer på 45 s med `{type:"tail", job, cursor}` — klienten kobler seg
umiddelbart på `/api/svar-tail` fra samme markør. Event-kontrakten mot
`ai-chat.js` står uendret.

**Tech Stack:** Deno (edge functions) + Node 20 (background/scheduled
functions) + Netlify Blobs + vanilla ES5-stil JS i klienten. Tester: `deno test`.

**Spec:** `docs/superpowers/specs/2026-08-28-background-transport-design.md`

## Global Constraints

- **Blobs-storen `svarjobb` opprettes ALLTID med `consistency: "strong"`.**
  Med default (eventual) ser leseren aldri skriverens head, og taileren står
  stille for alltid. Dette er repoets dokumenterte felle — den drepte
  rate-limit-telleren i fire repoer.
- **Skriverekkefølgen er invariant: chunk FØRST, head ETTERPÅ.** Leseren rykker
  bare fram når head flytter seg, og kan da aldri be om en chunk som ikke finnes.
- **Modell-ID-er bærer ikke datosuffiks** (`claude-haiku-4-5`, ikke
  `claude-haiku-4-5-20251001`).
- **`output_config.effort` er NØSTET i request-body**, aldri toppnivå. Og den
  FEILER på Haiku 4.5 — Haiku-kall sender aldri effort.
- **Ingen bakoverkompatibilitet.** Appen har ingen tredjepartsbrukere: erstatt og
  slett framfor å fryse eller migrere.
- **`netlify env:import .env` setter ALT i fila og blanker live-verdier som
  mangler.** Nye hemmeligheter må inn i `.env` samtidig som de settes.
- Testkommando gjennom hele planen:
  `cd netlify/edge-functions && deno check *.ts _lib/*.ts && deno test --allow-all _lib/`
- **Avvik fra speccen, bevisst:** endepunktene heter `/api/svar-jobb` og
  `/api/svar-tail` (bindestrek), ikke `/api/svar/jobb`. Skråstrek-varianten er et
  prefiks av `/api/svar` og inviterer til rutingtvetydighet mellom edge- og
  Node-laget. Ingen annen konsekvens.

---

### Task 1: Gjør `_lib` kjøretidsnøytralt

Bakgrunnsfunksjonen kjører på Node og bundles med esbuild, som **ikke kan løse
`https://esm.sh/...`-importer**. Importgrafen den trenger er i dag:
`svar-jobb → llm-choice → auth → rate-limit → esm.sh` 💥. All kjøretidsbundet
kabling må derfor samles ett sted som Node-siden aldri importerer.

**Files:**
- Create: `netlify/edge-functions/_lib/deno-kabling.ts`
- Create: `netlify/edge-functions/_lib/kjoretid.test.ts`
- Modify: `netlify/edge-functions/_lib/rate-limit.ts` (fjern esm.sh-import, gjør store-fabrikken påkrevd)
- Modify: `netlify/edge-functions/_lib/auth.ts:16` (fjern rate-limit-import), `:239-246`, `:287-294` (flytt `gate`/`adminGate` ut)
- Modify: `netlify/edge-functions/_lib/feiljournal.ts:11,60-62` (fjern esm.sh-import og `feiljournalStore`)
- Modify: `netlify/edge-functions/_lib/llm-choice.ts:114` (gjør `env` påkrevd)
- Modify: `netlify/edge-functions/_lib/anthropic.ts:51` (slett død `workspaceHeader`)
- Modify: `netlify/edge-functions/svar.ts`, `dm-vurder.ts`, `tolk-resultat.ts`, `hent.ts` (importer `gate`/`adminGate` fra ny fil)

**Interfaces:**
- Consumes: ingenting (første oppgave).
- Produces:
  - `deno-kabling.ts`: `denoEnv(k: string): string | undefined`,
    `gate(request, opts, context?): Promise<Response|null>`,
    `adminGate(request, opts, context?): Promise<Response|null>`,
    `feiljournalStore(): JournalStore`, `rateLimitStore(name: string): RateStore`
    (`jobbStore()` legges til i Task 6 — se rulingen der)
  - `auth.ts` beholder `runGate`, `runAdminGate`, `timingSafeEqual`,
    `extractByokKey`, `extractLlmKey`, `clientIp`, `upstreamErrorResponse`,
    `type IpContext`, `type GateOptions`, `type GateDeps` — alle rene.
  - `llm-choice.ts`: `resolveLlm(request, body, site, env)` — `env` er nå påkrevd.

- [ ] **Step 1: Skriv drift-vakten som feiler**

Denne testen er hele poenget med oppgaven: den fanger at noen senere legger en
URL-import eller et `Deno.`-kall inn i en fil Node-siden importerer.

```ts
// netlify/edge-functions/_lib/kjoretid.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Modulene bakgrunnsfunksjonen (Node) importerer, direkte eller transitivt.
// Ingen av dem får inneholde URL-importer eller Deno-globaler.
const NODE_TRYGGE = [
  "anthropic.ts", "auth.ts", "llm-choice.ts", "rate-limit.ts",
  "feiljournal.ts", "run-disiplin.ts", "svar-instruks.ts", "prefiks.ts",
];

Deno.test("Node-trygge moduler har ingen URL-importer", async () => {
  const treff: string[] = [];
  for (const f of NODE_TRYGGE) {
    const src = await Deno.readTextFile(new URL(f, import.meta.url));
    if (/from\s+"https:\/\//.test(src)) treff.push(f);
  }
  assertEquals(treff, []);
});

Deno.test("Node-trygge moduler rører ikke Deno-globalen", async () => {
  const treff: string[] = [];
  for (const f of NODE_TRYGGE) {
    const src = await Deno.readTextFile(new URL(f, import.meta.url));
    // Kommentarer og strenger som nevner «Deno» er greit; kall er ikke.
    if (/\bDeno\.(env|readTextFile|writeTextFile)\b/.test(src)) treff.push(f);
  }
  assertEquals(treff, []);
});
```

- [ ] **Step 2: Kjør testen og se den feile**

Run: `cd netlify/edge-functions && deno test --allow-all _lib/kjoretid.test.ts`
Expected: FAIL — begge testene lister treff (`rate-limit.ts`, `feiljournal.ts`
på URL-importer; `auth.ts`, `llm-choice.ts`, `anthropic.ts` på `Deno.env`).

- [ ] **Step 3: Opprett `deno-kabling.ts` med all kjøretidsbundet kabling**

```ts
// _lib/deno-kabling.ts — ALT som binder edge-laget til Deno og til Netlify
// Blobs' esm.sh-distribusjon bor HER, og bare her. Grunnen er ikke smak:
// bakgrunnsfunksjonen kjører på Node og bundles med esbuild, som ikke kan løse
// URL-importer. Havner en `https://`-import i en modul Node-siden importerer,
// dør hele funksjonen ved bygg. `_lib/kjoretid.test.ts` vokter dette.
// @ts-ignore - @netlify/blobs via esm.sh for Deno/Edge-kompatibilitet
import { getStore } from "https://esm.sh/@netlify/blobs@7";
import {
  type GateOptions, type IpContext, runAdminGate, runGate,
} from "./auth.ts";
import { checkRateLimit } from "./rate-limit.ts";
import { type JournalStore } from "./feiljournal.ts";

export const denoEnv = (k: string): string | undefined => Deno.env.get(k);

type StoreFabrikk = (opts: { name: string; consistency?: string }) => unknown;

export function rateLimitStore(name: string) {
  // Strong consistency er PÅKREVD: med default (eventual) lykkes skrivingene,
  // men lesingene ser dem aldri, så telleren står tom og grensen slår aldri inn.
  return (getStore as unknown as StoreFabrikk)({ name, consistency: "strong" });
}

export function feiljournalStore(): JournalStore {
  // Append-mønster (én nøkkel per hendelse, ingen read-modify-write), så
  // eventual consistency er ufarlig her — i motsetning til de to andre.
  return (getStore as unknown as StoreFabrikk)({ name: "feiljournal" }) as JournalStore;
}

// MERK: `jobbStore()` hører hjemme her, men opprettes først i Task 6 — den
// importerer `BlobbStore` fra `jobb-blobb.ts`, som ikke finnes før Task 2.

const rateLimitDep = (endpoint: string, ip: string) =>
  checkRateLimit(endpoint, ip, rateLimitStore);

/** Env-kablet port brukt av edge-handlerne. */
export function gate(request: Request, opts: GateOptions, context?: IpContext) {
  return runGate(request, opts, {
    sharedToken: denoEnv("M2PY_ACCESS_TOKEN"),
    personalToken: denoEnv("M2PY_ACCESS_TOKEN_PERSONAL"),
    checkRateLimit: rateLimitDep,
  }, context);
}

/** Env-kablet adminport (hent). */
export function adminGate(request: Request, opts: GateOptions, context?: IpContext) {
  return runAdminGate(request, opts, {
    sharedToken: denoEnv("M2PY_ACCESS_TOKEN"),
    personalToken: denoEnv("M2PY_ACCESS_TOKEN_PERSONAL"),
    checkRateLimit: rateLimitDep,
  }, context);
}
```

- [ ] **Step 4: Tøm de fire modulene for kjøretidsbinding**

`_lib/rate-limit.ts` — slett linje 1-2 (`@ts-ignore` + esm.sh-import) og gjør
store-fabrikken til en påkrevd parameter uten default:

```ts
export async function checkRateLimit(
  endpoint: string,
  ip: string,
  getStoreImpl: (name: string) => RateStore,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
```

`_lib/feiljournal.ts` — slett linje 11 (esm.sh-import) og linje 60-62
(`feiljournalStore`). `journalfor(store, h)` og `lagNokkel` er allerede rene og
står urørt.

`_lib/auth.ts` — slett linje 16 (`import { checkRateLimit as
defaultCheckRateLimit } from "./rate-limit.ts"`) og hele `gate`-funksjonen
(~linje 239-246) og `adminGate` (~linje 287-294). `runGate`/`runAdminGate` blir
stående uendret — de tar allerede alt injisert.

`_lib/llm-choice.ts:114` — fjern defaulten så Node-siden må levere sin egen:

```ts
  env: (k: string) => string | undefined,
```

`_lib/anthropic.ts:51` — slett `workspaceHeader()` og de to kallstedene
(`...workspaceHeader()` i header-objektene). Den er død: nøklene ble byttet til
vanlige workspace-nøkler 2026-08-28, og funksjonen har ikke hatt effekt siden.
Ingen bakoverkompat betyr slett, ikke behold.

- [ ] **Step 5: Rett opp de fire handlernes importer**

I `svar.ts`, `dm-vurder.ts`, `tolk-resultat.ts`: bytt `gate` fra `./_lib/auth.ts`
til `./_lib/deno-kabling.ts`. I `hent.ts`: samme for `adminGate`, og bytt
`(k) => Deno.env.get(k)` til `denoEnv`. Alle `resolveLlm(...)`-kall får `denoEnv`
som fjerde argument. `svar.ts:111` bytter `Deno.env.get("M2PY_ACCESS_TOKEN_PERSONAL")`
til `denoEnv("M2PY_ACCESS_TOKEN_PERSONAL")`, og `feiljournalStore` importeres nå
fra `deno-kabling.ts`.

- [ ] **Step 6: Kjør hele suiten**

Run: `cd netlify/edge-functions && deno check *.ts _lib/*.ts && deno test --allow-all _lib/`
Expected: PASS, inkludert de to nye drift-vaktene. Eksisterende tester som
kaller `checkRateLimit` uten fabrikk må få en injisert falsk store — de fleste
gjør det allerede.

- [ ] **Step 7: Commit**

```bash
git add netlify/edge-functions
git commit -m "refactor(edge): _lib blir kjøretidsnøytralt — Node kan ikke løse URL-importer"
```

---

### Task 2: Blobs-protokollen

**Files:**
- Create: `netlify/edge-functions/_lib/jobb-blobb.ts`
- Create: `netlify/edge-functions/_lib/jobb-blobb.test.ts`

**Interfaces:**
- Consumes: ingenting fra Task 1 (ren modul; `deno-kabling.ts` importerer *den*).
- Produces:
  - `interface BlobbStore { get(key, opts?): Promise<unknown>; set(key, value): Promise<unknown>; setJSON(key, value): Promise<unknown>; delete(key): Promise<unknown>; list(opts): Promise<{blobs: {key: string}[]}> }`
  - `interface JobbHead { seq: number; state: "kjorer"|"ferdig"|"feil"; start: number }`
  - `chunkNokkel(jobId: string, seq: number): string`
  - `headNokkel(jobId: string): string`
  - `lagSkriver(store: BlobbStore, jobId: string, now: () => number): JobbSkriver`
  - `interface JobbSkriver { skriv(sse: string): Promise<void>; avslutt(state: "ferdig"|"feil"): Promise<void> }`
  - `lesHead(store, jobId): Promise<JobbHead | null>`
  - `lesChunks(store, jobId, fra: number, til: number): Promise<string[]>`
  - `slettJobb(store, jobId): Promise<void>`

- [ ] **Step 1: Skriv de failende testene**

```ts
// netlify/edge-functions/_lib/jobb-blobb.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  chunkNokkel, headNokkel, lagSkriver, lesChunks, lesHead, slettJobb,
  type BlobbStore,
} from "./jobb-blobb.ts";

/** Falsk store som HUSKER rekkefølgen skrivingene kom i. */
function fakeStore() {
  const data = new Map<string, string>();
  const rekkefolge: string[] = [];
  const store: BlobbStore = {
    get: (k, opts) => {
      const v = data.get(k);
      if (v === undefined) return Promise.resolve(null);
      return Promise.resolve(opts?.type === "json" ? JSON.parse(v) : v);
    },
    set: (k, v) => { data.set(k, v); rekkefolge.push(k); return Promise.resolve(); },
    setJSON: (k, v) => { data.set(k, JSON.stringify(v)); rekkefolge.push(k); return Promise.resolve(); },
    delete: (k) => { data.delete(k); return Promise.resolve(); },
    list: (o) => Promise.resolve({
      blobs: [...data.keys()].filter((k) => k.startsWith(o.prefix)).map((key) => ({ key })),
    }),
  };
  return { store, data, rekkefolge };
}

Deno.test("nøklene er sorterbare og nullpolstret", () => {
  assertEquals(chunkNokkel("abc", 1), "abc/000001");
  assertEquals(chunkNokkel("abc", 42), "abc/000042");
  assertEquals(headNokkel("abc"), "abc/head");
});

Deno.test("chunk skrives FØR head — invarianten leseren hviler på", async () => {
  const { store, rekkefolge } = fakeStore();
  const s = lagSkriver(store, "j1", () => 1000);
  await s.skriv('data: {"type":"done"}\n\n');   // kontroll-event tvinger flush
  assertEquals(rekkefolge, ["j1/000001", "j1/head"]);
});

Deno.test("vanlige deltaer buffres til 150 ms har gått", async () => {
  const { store, rekkefolge } = fakeStore();
  let na = 1000;
  const s = lagSkriver(store, "j1", () => na);
  await s.skriv('data: {"type":"delta","text":"a"}\n\n');
  await s.skriv('data: {"type":"delta","text":"b"}\n\n');
  assertEquals(rekkefolge, []);                      // ingenting flushet ennå
  na = 1200;
  await s.skriv('data: {"type":"delta","text":"c"}\n\n');
  assertEquals(rekkefolge, ["j1/000001", "j1/head"]);
  assertEquals(await store.get("j1/000001"),
    'data: {"type":"delta","text":"a"}\n\ndata: {"type":"delta","text":"b"}\n\ndata: {"type":"delta","text":"c"}\n\n');
});

Deno.test("kontroll-events flushes umiddelbart", async () => {
  for (const t of ["run_code", "continue", "done", "error"]) {
    const { store, rekkefolge } = fakeStore();
    const s = lagSkriver(store, "j1", () => 1000);
    await s.skriv(`data: {"type":"${t}"}\n\n`);
    assertEquals(rekkefolge.length, 2, `${t} skulle flushet straks`);
  }
});

Deno.test("avslutt flusher resten og setter slutt-tilstanden", async () => {
  const { store } = fakeStore();
  const s = lagSkriver(store, "j1", () => 1000);
  await s.skriv('data: {"type":"delta","text":"hei"}\n\n');
  await s.avslutt("ferdig");
  const head = await lesHead(store, "j1");
  assertEquals(head, { seq: 1, state: "ferdig", start: 1000 });
});

Deno.test("avslutt uten buffret innhold lager ingen tom chunk", async () => {
  const { store, rekkefolge } = fakeStore();
  const s = lagSkriver(store, "j1", () => 1000);
  await s.avslutt("feil");
  assertEquals(rekkefolge, ["j1/head"]);
  assertEquals((await lesHead(store, "j1"))?.seq, 0);
});

Deno.test("lesHead gir null for ukjent jobb", async () => {
  const { store } = fakeStore();
  assertEquals(await lesHead(store, "finnes-ikke"), null);
});

Deno.test("lesChunks henter halvåpent intervall (fra, til]", async () => {
  const { store } = fakeStore();
  let na = 0;
  const s = lagSkriver(store, "j1", () => (na += 1000));
  await s.skriv('data: {"type":"delta","text":"en"}\n\n');
  await s.skriv('data: {"type":"delta","text":"to"}\n\n');
  await s.skriv('data: {"type":"delta","text":"tre"}\n\n');
  assertEquals(await lesChunks(store, "j1", 0, 3), [
    'data: {"type":"delta","text":"en"}\n\n',
    'data: {"type":"delta","text":"to"}\n\n',
    'data: {"type":"delta","text":"tre"}\n\n',
  ]);
  // Gjenopptak fra markør 1 hopper over det klienten alt har sett.
  assertEquals(await lesChunks(store, "j1", 1, 3), [
    'data: {"type":"delta","text":"to"}\n\n',
    'data: {"type":"delta","text":"tre"}\n\n',
  ]);
});

Deno.test("slettJobb fjerner både chunks og head", async () => {
  const { store, data } = fakeStore();
  const s = lagSkriver(store, "j1", () => 1000);
  await s.skriv('data: {"type":"done"}\n\n');
  await slettJobb(store, "j1");
  assertEquals([...data.keys()], []);
});
```

- [ ] **Step 2: Kjør og se dem feile**

Run: `cd netlify/edge-functions && deno test --allow-all _lib/jobb-blobb.test.ts`
Expected: FAIL — `Module not found "./jobb-blobb.ts"`.

- [ ] **Step 3: Implementer modulen**

```ts
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
    async skriv(sse: string): Promise<void> {
      buffer += sse;
      if (TVINGER_FLUSH.test(sse) || now() - sistFlush >= FLUSH_MS) {
        await flush("kjorer");
      }
    },
    async avslutt(state: "ferdig" | "feil"): Promise<void> {
      await flush(state);
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
```

- [ ] **Step 4: Kjør testene**

Run: `cd netlify/edge-functions && deno test --allow-all _lib/jobb-blobb.test.ts`
Expected: PASS — 9 tester.

- [ ] **Step 5: Commit**

```bash
git add netlify/edge-functions/_lib/jobb-blobb.ts netlify/edge-functions/_lib/jobb-blobb.test.ts
git commit -m "feat(edge): Blobs-protokoll for svarjobber — chunk før head"
```

---

### Task 3: Tailer-rutinen

**Files:**
- Create: `netlify/edge-functions/_lib/jobb-tail.ts`
- Create: `netlify/edge-functions/_lib/jobb-tail.test.ts`

**Interfaces:**
- Consumes: fra Task 2 — `BlobbStore`, `lesHead`, `lesChunks`, `slettJobb`.
- Produces:
  - `interface TailOpts { store: BlobbStore; jobId: string; fra: number; now?: () => number; sleep?: (ms: number) => Promise<void>; fristMs?: number; ventPaaHeadMs?: number; pollMs?: number }`
  - `tailStream(opts: TailOpts): ReadableStream<Uint8Array>`
  - `SSE_HEADERS: Record<string, string>`

- [ ] **Step 1: Skriv de failende testene**

```ts
// netlify/edge-functions/_lib/jobb-tail.test.ts
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { lagSkriver, type BlobbStore } from "./jobb-blobb.ts";
import { tailStream } from "./jobb-tail.ts";

function fakeStore() {
  const data = new Map<string, string>();
  const store: BlobbStore = {
    get: (k, opts) => {
      const v = data.get(k);
      if (v === undefined) return Promise.resolve(null);
      return Promise.resolve(opts?.type === "json" ? JSON.parse(v) : v);
    },
    set: (k, v) => { data.set(k, v); return Promise.resolve(); },
    setJSON: (k, v) => { data.set(k, JSON.stringify(v)); return Promise.resolve(); },
    delete: (k) => { data.delete(k); return Promise.resolve(); },
    list: (o) => Promise.resolve({
      blobs: [...data.keys()].filter((k) => k.startsWith(o.prefix)).map((key) => ({ key })),
    }),
  };
  return { store, data };
}

async function lesAlt(s: ReadableStream<Uint8Array>): Promise<string> {
  const dec = new TextDecoder();
  let ut = "";
  for await (const chunk of s) ut += dec.decode(chunk, { stream: true });
  return ut;
}

/** Klokke som rykker fram et fast antall ms for hvert sleep-kall. Feltene er
 * NØYAKTIG `now` og `sleep` slik at `...k` kan spres rett inn i TailOpts —
 * et ekstra felt her gir overflødig-felt-feil i `deno check`. */
function klokke(stegMs: number) {
  let na = 0;
  return {
    now: () => na,
    sleep: (_ms: number) => { na += stegMs; return Promise.resolve(); },
  };
}

Deno.test("dreneret ferdig jobb strømmes ut og lukkes", async () => {
  const { store } = fakeStore();
  const k = klokke(120);
  const s = lagSkriver(store, "j1", k.now);
  await s.skriv('data: {"type":"delta","text":"hei"}\n\n');
  await s.avslutt("ferdig");
  const ut = await lesAlt(tailStream({ store, jobId: "j1", fra: 0, ...k }));
  assertEquals(ut, 'data: {"type":"delta","text":"hei"}\n\n');
});

Deno.test("gjenopptak fra markør hopper over det klienten alt har sett", async () => {
  const { store } = fakeStore();
  const k = klokke(120);
  let na = 0;
  const s = lagSkriver(store, "j1", () => (na += 200));
  await s.skriv('data: {"type":"delta","text":"en"}\n\n');
  await s.skriv('data: {"type":"delta","text":"to"}\n\n');
  await s.avslutt("ferdig");
  const ut = await lesAlt(tailStream({ store, jobId: "j1", fra: 1, ...k }));
  assertEquals(ut, 'data: {"type":"delta","text":"to"}\n\n');
});

Deno.test("overlevering på frist emitterer tail med riktig markør", async () => {
  const { store } = fakeStore();
  let na = 0;
  const s = lagSkriver(store, "j1", () => (na += 200));
  await s.skriv('data: {"type":"delta","text":"en"}\n\n');
  // Jobben står fortsatt som «kjorer» — taileren må gi opp på fristen.
  const k = klokke(20_000);
  const ut = await lesAlt(tailStream({
    store, jobId: "j1", fra: 0, now: k.now, sleep: k.sleep, fristMs: 45_000,
  }));
  assertStringIncludes(ut, 'data: {"type":"delta","text":"en"}\n\n');
  assertStringIncludes(ut, '"type":"tail"');
  assertStringIncludes(ut, '"cursor":1');
  assertStringIncludes(ut, '"job":"j1"');
});

Deno.test("manglende head gir forklart feil etter ventetiden", async () => {
  const { store } = fakeStore();
  const k = klokke(3000);
  const ut = await lesAlt(tailStream({
    store, jobId: "finnes-ikke", fra: 0, now: k.now, sleep: k.sleep,
    ventPaaHeadMs: 10_000,
  }));
  assertStringIncludes(ut, '"type":"error"');
  assertStringIncludes(ut, "startet aldri");
});

Deno.test("ferdig jobb ryddes bort etter drenering", async () => {
  const { store, data } = fakeStore();
  const k = klokke(120);
  const s = lagSkriver(store, "j1", k.now);
  await s.skriv('data: {"type":"done"}\n\n');
  await s.avslutt("ferdig");
  await lesAlt(tailStream({ store, jobId: "j1", fra: 0, ...k }));
  assertEquals([...data.keys()], []);
});

Deno.test("overlevering rydder IKKE — jobben lever videre", async () => {
  const { store, data } = fakeStore();
  let na = 0;
  const s = lagSkriver(store, "j1", () => (na += 200));
  await s.skriv('data: {"type":"delta","text":"en"}\n\n');
  const k = klokke(20_000);
  await lesAlt(tailStream({
    store, jobId: "j1", fra: 0, now: k.now, sleep: k.sleep, fristMs: 45_000,
  }));
  assertEquals(data.has("j1/head"), true);
});
```

- [ ] **Step 2: Kjør og se dem feile**

Run: `cd netlify/edge-functions && deno test --allow-all _lib/jobb-tail.test.ts`
Expected: FAIL — `Module not found "./jobb-tail.ts"`.

- [ ] **Step 3: Implementer taileren**

```ts
// _lib/jobb-tail.ts — leser en svarjobb fra Blobs og strømmer den ut som SSE.
// Delt av /api/svar (fra markør 0) og /api/svar-tail (fra en overlevert markør).
//
// Taileren har selv 60-sekundersveggen over seg — den er en helt vanlig
// edge-invokasjon. Forskjellen fra før er at overleveringen nå er
// DETERMINISTISK: den henger på tailerens egen klokke, ikke på uforutsigbar
// modell-latens. Derfor kan den ikke lenger overraske oss midt i et svar.
import {
  type BlobbStore, lesChunks, lesHead, slettJobb,
} from "./jobb-blobb.ts";

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
};

export interface TailOpts {
  store: BlobbStore;
  jobId: string;
  fra: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Overlever på 45 s — komfortabelt under plattformens ~60 s. */
  fristMs?: number;
  /** Hvor lenge vi venter på at bakgrunnsjobben skal skrive sin første head. */
  ventPaaHeadMs?: number;
  pollMs?: number;
}

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;

export function tailStream(opts: TailOpts): ReadableStream<Uint8Array> {
  const {
    store, jobId, fra,
    now = () => Date.now(),
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    fristMs = 45_000,
    ventPaaHeadMs = 10_000,
    pollMs = 120,
  } = opts;

  const enc = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const send = (s: string) => controller.enqueue(enc.encode(s));
      const start = now();
      let cursor = fra;
      try {
        while (true) {
          const head = await lesHead(store, jobId);
          if (!head) {
            if (now() - start >= ventPaaHeadMs) {
              send(sse({
                type: "error",
                message: "Svarjobben startet aldri. Prøv spørsmålet på nytt.",
              }));
              return;
            }
            await sleep(pollMs);
            continue;
          }
          if (head.seq > cursor) {
            for (const c of await lesChunks(store, jobId, cursor, head.seq)) {
              if (c) send(c);
            }
            cursor = head.seq;
          }
          // Ferdig OG drenert: rydd og lukk.
          if (head.state !== "kjorer" && cursor >= head.seq) {
            await slettJobb(store, jobId);
            return;
          }
          // Fristen nådd: overlever markøren. Jobben ryddes IKKE — den lever
          // videre i bakgrunnen, og neste tailer plukker den opp.
          if (now() - start >= fristMs) {
            send(sse({ type: "tail", job: jobId, cursor }));
            return;
          }
          await sleep(pollMs);
        }
      } catch (e) {
        send(sse({ type: "error", message: String(e) }));
      } finally {
        controller.close();
      }
    },
  });
}
```

- [ ] **Step 4: Kjør testene**

Run: `cd netlify/edge-functions && deno test --allow-all _lib/jobb-tail.test.ts`
Expected: PASS — 6 tester.

- [ ] **Step 5: Commit**

```bash
git add netlify/edge-functions/_lib/jobb-tail.ts netlify/edge-functions/_lib/jobb-tail.test.ts
git commit -m "feat(edge): tailer med deterministisk markør-overlevering"
```

---

### Task 4: Trekk løpsbyggingen ut av svar.ts

Bakgrunnsfunksjonen og edge-handleren må bygge nøyaktig samme løp. I dag ligger
byggingen midt i `svar.ts`. Den flyttes ut UENDRET (ren flytting, ingen
atferdsendring) slik at Node-siden kan bruke den.

**Files:**
- Create: `netlify/edge-functions/_lib/svar-lop.ts`
- Modify: `netlify/edge-functions/svar.ts:154-215` (klipp ut blokken)
- Create: `netlify/edge-functions/_lib/svar-lop.test.ts`

**Interfaces:**
- Consumes: fra Task 1 — `resolveLlm`-resultatet (`LlmChoice`) og `denoEnv`.
- Produces:
  - `interface LopInput { origin: string; question: string; mode: GenMode; script?: string; instructions?: unknown; choice: LlmChoice; erPersonlig: boolean; resumeState?: AgenticResumeState; runResultTilLopet?: string; runOkCalls: number; kvalitet: SvarKvalitet; journalHendelse: (type: string, detalj?: string) => void; turnDeadlineMs: number }`
  - `byggLop(inp: LopInput): Promise<ReadableStream<Uint8Array> | Response>`

- [ ] **Step 1: Skriv testen som låser kontrakten**

```ts
// netlify/edge-functions/_lib/svar-lop.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { byggLop } from "./svar-lop.ts";

Deno.test("prefiks-feil gir 502 som Response, ikke en kastet feil", async () => {
  const ut = await byggLop({
    origin: "http://finnes.ikke.invalid",
    question: "hei", mode: "microdata",
    choice: { apiKey: "sk-ant-test", model: "claude-sonnet-5" },
    erPersonlig: false, runOkCalls: 0, kvalitet: "balanced",
    journalHendelse: () => {}, turnDeadlineMs: 50_000,
  });
  assertEquals(ut instanceof Response, true);
  assertEquals((ut as Response).status, 502);
});
```

- [ ] **Step 2: Kjør og se den feile**

Run: `cd netlify/edge-functions && deno test --allow-all _lib/svar-lop.test.ts`
Expected: FAIL — `Module not found "./svar-lop.ts"`.

- [ ] **Step 3: Flytt blokken**

Opprett `_lib/svar-lop.ts` og flytt dit, UENDRET, alt fra `let system: string;`
til og med `if/else`-kjeden som velger `runProviderAgenticStream` eller
`runAgenticStream` (`svar.ts:154-215`). Endringer som er lov:

1. Funksjonen returnerer strømmen i stedet for en `Response`.
2. `runAgenticStream`-grenen får `deps: { verboseUpstream: erPersonlig, turnDeadlineMs }`
   i stedet for bare `verboseUpstream` — Node-siden skal kunne heve fristen.
3. `journal`/`journalHendelse` tas inn som parameter i stedet for å bygges lokalt.

Alt annet — `commonOpts`, `providerDeps`, `executeTool`, `cacheTtl: "1h"`,
`onEmit`-avlyttingen — kopieres ord for ord. Dette er en ren flytting; enhver
«forbedring» underveis er en atferdsendring i forkledning.

- [ ] **Step 4: Kall den nye funksjonen fra svar.ts**

Legg til importen `svar.ts` nå trenger:

```ts
import { SSE_HEADERS } from "./_lib/jobb-tail.ts";
import { byggLop } from "./_lib/svar-lop.ts";
```

`svar.ts` beholder alt før blokken (gate, body-parsing, resume-validering,
`resolveLlm`, `erPersonlig`, run-disiplin, journal) og avslutter med:

```ts
  const lop = await byggLop({
    origin, question, mode, script: body.script, instructions: body.instructions,
    choice, erPersonlig, resumeState, runResultTilLopet, runOkCalls,
    kvalitet, journalHendelse, turnDeadlineMs: 50_000,
  });
  if (lop instanceof Response) return lop;
  return new Response(lop, { headers: SSE_HEADERS });
```

- [ ] **Step 5: Kjør hele suiten**

Run: `cd netlify/edge-functions && deno check *.ts _lib/*.ts && deno test --allow-all _lib/`
Expected: PASS. Atferden er uendret — dette er stillaset for Task 5.

- [ ] **Step 6: Commit**

```bash
git add netlify/edge-functions
git commit -m "refactor(edge): løpsbyggingen ut av svar.ts — ren flytting til _lib/svar-lop.ts"
```

---

### Task 5: Bakgrunnsfunksjonen

**Files:**
- Create: `netlify/functions/svar-jobb.mts`
- Create: `netlify/functions/_shared/node-kabling.mts`
- Modify: `netlify.toml` (ingen ny `[[edge_functions]]` — Node-funksjoner ruter selv via `config.path`)

**Interfaces:**
- Consumes: Task 2 (`lagSkriver`), Task 4 (`byggLop`), Task 1 (`runGate`, `resolveLlm` med injisert env).
- Produces: HTTP `POST /api/svar-jobb` → 202. Skriver jobben til Blobs-storen `svarjobb`.

- [ ] **Step 1: Node-kablingen**

```ts
// netlify/functions/_shared/node-kabling.mts — Node-sidens motstykke til
// _lib/deno-kabling.ts. Samme roller, npm-pakke i stedet for esm.sh.
import { getStore } from "@netlify/blobs";
import type { BlobbStore } from "../../edge-functions/_lib/jobb-blobb.ts";
import type { JournalStore } from "../../edge-functions/_lib/feiljournal.ts";

export const nodeEnv = (k: string): string | undefined => Netlify.env.get(k);

export function jobbStore(): BlobbStore {
  return getStore({ name: "svarjobb", consistency: "strong" }) as unknown as BlobbStore;
}

export function feiljournalStore(): JournalStore {
  // Append-mønster (én nøkkel per hendelse), så eventual consistency er
  // ufarlig her — i motsetning til jobb-storen over.
  return getStore({ name: "feiljournal" }) as unknown as JournalStore;
}

// Rate-limiting skjer på /api/svar, ALDRI her: ett spørsmål skal telles én
// gang. Porten kjøres likevel i sin helhet — funksjonen er offentlig nåbar.
export const ingenRateLimit = () =>
  Promise.resolve({ allowed: true, retryAfterSeconds: 0 });
```

- [ ] **Step 2: Bakgrunnsfunksjonen**

```ts
// netlify/functions/svar-jobb.mts — det agentiske løpet, flyttet ut av
// 60-sekundersveggen og inn i et 15-minutters budsjett.
//
// SIKKERHET: denne funksjonen er OFFENTLIG NÅBAR på /api/svar-jobb. Uten
// porten under ville hvem som helst kunne brenne serverens API-nøkkel med et
// enkelt POST. Både auth-porten OG jobb-hemmeligheten er derfor påkrevd —
// hemmeligheten fordi rate-limiten bor på /api/svar, og et direkte kall hit
// ellers ville gått utenom den.
import type { Config } from "@netlify/functions";
import { runGate, timingSafeEqual } from "../edge-functions/_lib/auth.ts";
import { coerceQuality, resolveLlm } from "../edge-functions/_lib/llm-choice.ts";
import { lagSkriver } from "../edge-functions/_lib/jobb-blobb.ts";
import { byggLop } from "../edge-functions/_lib/svar-lop.ts";
import { journalfor } from "../edge-functions/_lib/feiljournal.ts";
import {
  feiljournalStore, ingenRateLimit, jobbStore, nodeEnv,
} from "./_shared/node-kabling.mts";

// 13 min: under background-taket på 15, så en løpsk tur får en FORKLART feil
// i stedet for stille død.
const TUR_FRIST_MS = 780_000;

export default async (request: Request): Promise<Response> => {
  const hemmelighet = nodeEnv("SVAR_JOBB_SECRET") ?? "";
  const presentert = request.headers.get("x-jobb-nokkel") ?? "";
  if (!hemmelighet || !timingSafeEqual(presentert, hemmelighet)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const gateResp = await runGate(request, {
    endpoint: "svar-jobb", maxBodyBytes: 2_000_000,
    allowByok: true, allowLlmKey: true,
  }, {
    sharedToken: nodeEnv("M2PY_ACCESS_TOKEN"),
    personalToken: nodeEnv("M2PY_ACCESS_TOKEN_PERSONAL"),
    checkRateLimit: ingenRateLimit,
  });
  if (gateResp) return gateResp;

  const body = await request.json();
  const jobId = String(body.jobId ?? "");
  if (!/^[0-9a-f-]{36}$/.test(jobId)) {
    return new Response("Ugyldig jobId", { status: 400 });
  }

  const choice = resolveLlm(request, body, "svar", nodeEnv);
  if (choice instanceof Response) return choice;

  // erPersonlig regnes ut HER, fra tokenet — den kommer ALDRI fra bodyen.
  // Den styrer `verboseUpstream` (skrubbede oppstrøms-feildetaljer) og
  // feiljournalen; et klientsatt flagg ville gitt hvem som helst med det
  // delte passordet innsyn ment for eieren alene.
  const authHeader = request.headers.get("authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : "";
  const personligToken = nodeEnv("M2PY_ACCESS_TOKEN_PERSONAL") ?? "";
  const erPersonlig = bearer.length > 0 && personligToken.length > 0 &&
    timingSafeEqual(bearer, personligToken);

  const question = String(body.question ?? "").trim();
  const mode = (body.mode === "python" || body.mode === "r") ? body.mode : "microdata";
  const kvalitet = coerceQuality(body.quality) ?? "balanced";

  // Feiljournalen følger løpet, ikke porten: `run_feil` og `feil` oppstår
  // INNE i løkka, så et no-op her ville stille tømt journalen for nettopp de
  // hendelsene selvforbedringssløyfen lever av. /api/svar skriver `sporsmal`.
  const journal = erPersonlig ? feiljournalStore() : null;
  const journalHendelse = (type: string, detalj?: string): void => {
    if (journal) {
      void journalfor(journal, { type, sporsmal: question, detalj, mode, quality: kvalitet });
    }
  };

  const skriver = lagSkriver(jobbStore(), jobId, () => Date.now());
  const lop = await byggLop({
    origin: new URL(request.url).origin,
    question, mode, script: body.script, instructions: body.instructions,
    choice, erPersonlig,
    resumeState: body.resumeState, runResultTilLopet: body.runResultTilLopet,
    runOkCalls: Number(body.runOkCalls) || 0,
    kvalitet, journalHendelse,
    turnDeadlineMs: TUR_FRIST_MS,
  });
  if (lop instanceof Response) {
    await skriver.skriv(`data: ${JSON.stringify({
      type: "error", message: `Kunne ikke bygge løpet (HTTP ${lop.status})`,
    })}\n\n`);
    await skriver.avslutt("feil");
    return new Response(null, { status: 202 });
  }

  // Ren bytepumpe: strømmen ER allerede «data: {...}\n\n»-frames, så ingenting
  // parses. Grensesnittet mot ai-chat.js er dermed byte-identisk med før.
  const dec = new TextDecoder();
  try {
    for await (const chunk of lop) {
      await skriver.skriv(dec.decode(chunk, { stream: true }));
    }
    await skriver.avslutt("ferdig");
  } catch (e) {
    await skriver.skriv(`data: ${JSON.stringify({
      type: "error", message: String(e),
    })}\n\n`);
    await skriver.avslutt("feil");
  }
  return new Response(null, { status: 202 });
};

export const config: Config = { path: "/api/svar-jobb", background: true };
```

- [ ] **Step 3: Verifiser at Node-grafen faktisk bundler**

Run: `cd /Users/hom/Documents/GitHub/microdata && npx netlify build --dry 2>&1 | tail -20`
Expected: ingen «Could not resolve "https://esm.sh/..."». Feiler den, er Task 1
ufullstendig — finn modulen esbuild klager på og flytt kablingen dens til
`deno-kabling.ts`.

- [ ] **Step 4: Commit**

```bash
git add netlify/functions
git commit -m "feat(functions): bakgrunnsjobb for svar-løpet — 15 min i stedet for 60 s"
```

---

### Task 6: `/api/svar` blir avfyrer + tailer, og `/api/svar-tail` fødes

**Files:**
- Modify: `netlify/edge-functions/svar.ts` (siste blokk)
- Create: `netlify/edge-functions/svar-tail.ts`
- Modify: `netlify.toml` (ny `[[edge_functions]]`-oppføring)

**Interfaces:**
- Consumes: Task 3 (`tailStream`, `SSE_HEADERS`), Task 1 (`gate`, `jobbStore`, `denoEnv`).
- Produces: `GET /api/svar-tail?job=<uuid>&from=<n>` → SSE.

- [ ] **Step 1: Bytt ut svar.ts' siste blokk**

Erstatt `byggLop`-kallet fra Task 4 Step 4 med avfyring + tailing:

```ts
  const jobId = crypto.randomUUID();
  const jobbNokkel = denoEnv("SVAR_JOBB_SECRET") ?? "";
  if (!jobbNokkel) {
    console.error("SVAR_JOBB_SECRET is not set");
    return new Response("Server configuration error", { status: 500 });
  }
  // Videresend brukerens egen legitimasjon UENDRET — jobb-funksjonen kjører
  // hele porten på nytt, og BYOK-nøkkelen må nå fram dit den faktisk brukes.
  const videre: Record<string, string> = {
    "content-type": "application/json",
    "x-jobb-nokkel": jobbNokkel,
  };
  for (const h of ["authorization", "x-anthropic-key", "x-llm-key"]) {
    const v = request.headers.get(h);
    if (v) videre[h] = v;
  }
  const spawn = await fetch(new URL("/api/svar-jobb", origin), {
    method: "POST",
    headers: videre,
    body: JSON.stringify({
      ...body, jobId, runOkCalls, runResultTilLopet,
      resumeState, quality: kvalitet,
      // erPersonlig sendes IKKE — jobb-funksjonen regner den ut fra tokenet
      // selv. Et klientsatt flagg ville vært en innsyns-bypass.
    }),
  });
  if (spawn.status !== 202) {
    console.error(`svar: jobbstart feilet med ${spawn.status}`);
    return new Response("Kunne ikke starte svarjobben", { status: 502 });
  }
  return new Response(
    tailStream({ store: jobbStore(), jobId, fra: 0 }),
    { headers: SSE_HEADERS },
  );
```

- [ ] **Step 2: Legg `jobbStore()` til i `deno-kabling.ts`**

Task 1 lot den bevisst stå igjen: den importerer `BlobbStore` fra
`jobb-blobb.ts`, som ikke fantes da. Nå gjør den det.

```ts
import { type BlobbStore } from "./jobb-blobb.ts";

export function jobbStore(): BlobbStore {
  return (getStore as unknown as StoreFabrikk)({
    name: "svarjobb",
    consistency: "strong",   // se Global Constraints — ikke valgfritt
  }) as BlobbStore;
}
```

- [ ] **Step 3: Nytt tail-endepunkt**

```ts
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
    metode: "GET",
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
```

Merk: `gate` sjekker i dag metode POST. Legg til et `metode`-felt i
`GateOptions` (default `"POST"`) og la `runBaseChecks` bruke det, slik at
GET-endepunktet slipper gjennom. Oppdater `_lib/auth.test.ts` med en test som
viser at `metode: "GET"` avviser POST og omvendt.

- [ ] **Step 4: Registrer endepunktet**

```toml
[[edge_functions]]
  function = "svar-tail"
  path = "/api/svar-tail"
```

- [ ] **Step 5: Kjør hele suiten**

Run: `cd netlify/edge-functions && deno check *.ts _lib/*.ts && deno test --allow-all _lib/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add netlify/edge-functions netlify.toml
git commit -m "feat(edge): /api/svar avfyrer jobb og tailer; /api/svar-tail gjenopptar"
```

---

### Task 7: Klienten følger overleveringen

**Files:**
- Modify: `js/ai-chat.js:555-575` (`consumeSse` beholdes), `:640-700` (hopp-løkka)
- Modify: `js/ai-transport.js` (kommentar om GET-bruk)
- Create: `test/ai-tail.test.js` (node-testbar ren logikk)

**Interfaces:**
- Consumes: Task 6 — `{type:"tail", job, cursor}` og `GET /api/svar-tail`.
- Produces: intern hjelper `consumeMedTail(resp, onEvent, hop)` i `ai-chat.js`.

- [ ] **Step 1: Legg inn tail-følgeren**

**Skop-regelen (avgjort i forhåndsskanningen):** `consumeMedTail` bruker
`markdown`, `bubble`, `signal` og `streamRenderMd`. `markdown` og `bubble` er
LOKALE i svar-funksjonen (`ai-chat.js:592-596`), ikke synlige der `consumeSse`
er definert på linje 555-575. Legg derfor `consumeMedTail` **rett etter
`handleSvarEvent`** (~linje 640), inne i samme funksjonsskop — ikke ved
`consumeSse`. Plasseres den ved `consumeSse`, kaster den ReferenceError på
første overlevering.

```js
      // Overleveringen: taileren gir fra seg på 45 s med {type:'tail'}, og vi
      // plukker opp fra samme markør. Usynlig for handleSvarEvent — hele
      // poenget er at event-strømmen ser sammenhengende ut.
      //
      // markdownVedGrense er gjenopprettingspunktet: ryker nettet MIDT i et
      // segment, spoler vi svarteksten tilbake dit og henter segmentet på nytt.
      // Uten det ville en gjentakelse duplisert tekst brukeren alt har sett.
      async function consumeMedTail(resp, onEvent, hop) {
        var neste = null;
        var markdownVedGrense = null;
        var wrap = function (ev) {
          if (ev.type === 'tail') { neste = ev; return; }
          onEvent(ev);
        };
        await consumeSse(resp, wrap).catch(function (e) {
          rethrowDescribed(e, 'svar', 'stream', hop);
        });
        while (neste) {
          var t = neste;
          neste = null;
          markdownVedGrense = markdown;
          var url = '/api/svar-tail?job=' + encodeURIComponent(t.job) +
                    '&from=' + encodeURIComponent(t.cursor);
          var r;
          try {
            // postWithRetry er en generisk fetch-wrapper tross navnet; GET er
            // trygt her fordi tail-avspilling er idempotent.
            r = await AiTransport.postWithRetry(url, {
              method: 'GET', headers: edgeAuthHeaders(), signal: signal,
            });
            if (!r.ok || !r.body) throw new Error('HTTP ' + r.status + ' ' + (await r.text()));
            await consumeSse(r, wrap);
          } catch (e) {
            if (e && e.name === 'AbortError') throw e;
            // Spol tilbake til segmentgrensen og prøv samme markør én gang til.
            markdown = markdownVedGrense;
            streamRenderMd(bubble, markdown);
            neste = t;
            if (t._forsokt) rethrowDescribed(e, 'svar-tail', 'stream', hop);
            t._forsokt = true;
          }
        }
      }
```

- [ ] **Step 2: Bruk den i hopp-løkka**

I `ai-chat.js:665-670`, bytt `consumeSse(resp, ...)` mot:

```js
          let cont = null, pendingRun = null;
          await consumeMedTail(resp, (ev) => {
            if (ev.type === 'continue') { cont = { state: ev.state, run_ok_calls: ev.run_ok_calls }; return; }
            if (ev.type === 'run_code') { pendingRun = ev.script || ''; return; }
            handleSvarEvent(ev);
          }, hop);
```

- [ ] **Step 3: Manuell verifisering i nettleser**

Run: `netlify dev` og still et spørsmål på nivå «Grundig» som tar over 45 s.
Expected: svaret strømmer sammenhengende gjennom minst én overlevering; ingen
duplisert tekst, ingen «Error in input stream». Sjekk nettverksfanen: ett
`/api/svar`-kall etterfulgt av ett eller flere `/api/svar-tail`-kall.

- [ ] **Step 4: Commit**

```bash
git add js/ai-chat.js js/ai-transport.js
git commit -m "feat(klient): følg tail-overleveringen; nettglipp spoler til segmentgrensen"
```

---

### Task 8: Fjern stillheten — effort av, levende statuslinje

**Files:**
- Modify: `netlify/edge-functions/_lib/llm-choice.ts:36-41` (TIERS), `:44-48` (DEFAULTS)
- Modify: `netlify/edge-functions/_lib/llm-choice.test.ts`
- Modify: `js/ai-chat.js:605-617` (progress-håndtering)

**Interfaces:**
- Consumes: ingenting nytt.
- Produces: `balanced` og `DEFAULTS["svar"]` har ikke lenger `effort`.

- [ ] **Step 1: Skriv testene som feiler**

```ts
// tillegg i _lib/llm-choice.test.ts
Deno.test("balanced sender ikke effort — tenkefasen er ren stillhet for brukeren", () => {
  const c = chooseModel("svar", "balanced", () => undefined);
  assertEquals(c, { model: "claude-sonnet-5" });
});

Deno.test("svar-defaulten sender heller ikke effort", () => {
  // resolveLlm bruker coerceQuality(body.quality), som er null når klienten
  // ikke sender quality — mens svar.ts velger budsjett med ?? \"balanced\".
  // Lot vi DEFAULTS beholde effort, ville default-veien beholdt nøyaktig den
  // stillheten vi fjerner.
  const c = chooseModel("svar", null, () => undefined);
  assertEquals(c, { model: "claude-sonnet-5" });
});

Deno.test("best beholder effort high", () => {
  assertEquals(chooseModel("svar", "best", () => undefined),
    { model: "claude-opus-5", effort: "high" });
});
```

- [ ] **Step 2: Kjør og se dem feile**

Run: `cd netlify/edge-functions && deno test --allow-all _lib/llm-choice.test.ts`
Expected: FAIL — `balanced` og default gir fortsatt `effort: "medium"`.

- [ ] **Step 3: Endre nivåene**

```ts
const TIERS: Record<Quality, ModelChoice> = {
  fast: { model: "claude-haiku-4-5" },
  // Effort er ADAPTIVT: modellen velger selv om den skal tenke. Målt
  // 2026-08-28 mot claude-sonnet-5: med effort satt kan tenkefasen ta 26-31 s
  // der API-et sender NØYAKTIG INGENTING (thinking_delta kommer én gang, med
  // 0 tegn, helt til slutt — tenketeksten er kryptert og finnes ikke å vise).
  // Uten effort strømmer samme modell fra 1,12 s. «Balansert» skal føles
  // balansert, ikke stum, så den kjører uten.
  balanced: { model: "claude-sonnet-5" },
  // «Grundig» beholder tenkingen — der er ventetiden brukerens eget valg, og
  // Haiku-forordet (Task 9) fyller den med noe å lese.
  best: { model: "claude-opus-5", effort: "high" },
};

const DEFAULTS: Record<CallSite, ModelChoice> = {
  "dm-vurder": { model: "claude-sonnet-5", effort: "medium" },
  "tolk-resultat": { model: "claude-sonnet-5", effort: "medium" },
  // Uten effort, av samme grunn som `balanced` over — dette ER default-veien
  // for enhver klient som ikke sender `quality`.
  "svar": { model: "claude-sonnet-5" },
};
```

- [ ] **Step 4: Gjør statuslinja levende**

I `ai-chat.js`, la progress-linja telle lokalt i stedet for å vente på
serverens heartbeat hvert tiende sekund:

```js
        // Serverens heartbeat kommer hvert 10. sekund. En linje som står
        // bom stille i ti sekunder leses som «hengt», ikke «jobber» — så
        // sekundene telles her, av en lokal klokke.
        let pulsTimer = null;
        function startPuls(line, tekst) {
          const t0 = Date.now();
          if (pulsTimer) clearInterval(pulsTimer);
          pulsTimer = setInterval(() => {
            const s = Math.round((Date.now() - t0) / 1000);
            line.textContent = '⏳ ' + tekst + (s >= 3 ? ' … ' + s + ' s' : '');
          }, 1000);
        }
```

Bytt så ut hele `progress`-grenen i `handleSvarEvent` (`ai-chat.js:605-620`):

```js
          if (ev.type === 'progress') {
            const last = progressBox.lastElementChild;
            let line;
            if (ev.replace && last && last.dataset.replace === '1') {
              line = last;
            } else {
              line = document.createElement('div');
              line.className = 'ai-progress-line';
              if (ev.replace) line.dataset.replace = '1';
              progressBox.appendChild(line);
            }
            const pynt = (ev.text && (ev.text.startsWith('▶') || ev.text.startsWith('⚠️')));
            line.textContent = pynt ? ev.text : '⏳ ' + ev.text;
            // Bare de utskiftbare fase-linjene teller sekunder; ▶/⚠️ er
            // engangsmeldinger og skal stå stille.
            if (ev.replace && !pynt) startPuls(line, ev.text);
            scrollToBottom();
```

Og stopp pulsen i de tre grenene der noe annet tar over — øverst i
`delta`-grenen, øverst i `error`-grenen, og rett etter hopp-løkka:

```js
            if (pulsTimer) { clearInterval(pulsTimer); pulsTimer = null; }
```

- [ ] **Step 5: Kjør testene**

Run: `cd netlify/edge-functions && deno test --allow-all _lib/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add netlify/edge-functions/_lib/llm-choice.ts netlify/edge-functions/_lib/llm-choice.test.ts js/ai-chat.js
git commit -m "feat: balansert mister effort (målt 1,12 s vs 26-31 s stum) + levende statuslinje"
```

---

### Task 9: Haiku-forord på «Grundig»

**Files:**
- Create: `netlify/edge-functions/_lib/forord.ts`
- Create: `netlify/edge-functions/_lib/forord.test.ts`
- Modify: `netlify/functions/svar-jobb.mts`
- Modify: `js/ai-chat.js` (`handleSvarEvent`)

**Interfaces:**
- Consumes: Task 2 (`JobbSkriver`), Task 5 (bakgrunnsfunksjonen).
- Produces: `skrivForord(skriver: JobbSkriver, opts: ForordOpts): Promise<void>`,
  og SSE-eventet `{type:"forord", text: string}`.

- [ ] **Step 1: Skriv testen**

```ts
// netlify/edge-functions/_lib/forord.test.ts
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { skrivForord } from "./forord.ts";

function fangSkriver() {
  const skrevet: string[] = [];
  return {
    skriver: {
      skriv: (s: string) => { skrevet.push(s); return Promise.resolve(); },
      avslutt: () => Promise.resolve(),
    },
    skrevet,
  };
}

Deno.test("forordet emitteres som forord-events", async () => {
  const { skriver, skrevet } = fangSkriver();
  await skrivForord(skriver, {
    apiKey: "sk-ant-test", question: "Hva påvirker sosialhjelp?",
    kall: () => Promise.resolve("Jeg starter med å hente inntekt og alder."),
  });
  assertEquals(skrevet.length, 1);
  assertStringIncludes(skrevet[0], '"type":"forord"');
  assertStringIncludes(skrevet[0], "inntekt og alder");
});

Deno.test("forordet feiler ALDRI oppover — det er pynt, ikke svar", async () => {
  const { skriver, skrevet } = fangSkriver();
  await skrivForord(skriver, {
    apiKey: "sk-ant-test", question: "hei",
    kall: () => Promise.reject(new Error("oppstrøms nede")),
  });
  assertEquals(skrevet, []);
});
```

- [ ] **Step 2: Kjør og se den feile**

Run: `cd netlify/edge-functions && deno test --allow-all _lib/forord.test.ts`
Expected: FAIL — `Module not found "./forord.ts"`.

- [ ] **Step 3: Implementer**

```ts
// _lib/forord.ts — ett lynraskt Haiku-kall som gir brukeren noe ekte å lese
// mens Opus tenker. Målt 2026-08-28: tenkefasen sender ingenting på 26-31 s,
// og tenketeksten er kryptert, så det finnes ikke noe å strømme fra selve
// tenkingen. Dette er erstatningen.
//
// Haiku 4.5 tar ALDRI effort — det gir 400.
import { messageAnthropic } from "./anthropic.ts";
import { type JobbSkriver } from "./jobb-blobb.ts";

export interface ForordOpts {
  apiKey: string;
  question: string;
  /** Injiserbar for test; default er et ekte Haiku-kall. */
  kall?: () => Promise<string>;
}

const INSTRUKS =
  "Skriv én til to setninger om hvordan du vil gripe an spørsmålet under. " +
  "Ikke svar på det, ikke still spørsmål tilbake, ikke bruk overskrifter.";

export async function skrivForord(
  skriver: JobbSkriver,
  opts: ForordOpts,
): Promise<void> {
  try {
    const tekst = opts.kall
      ? await opts.kall()
      : (await messageAnthropic({
        apiKey: opts.apiKey,
        model: "claude-haiku-4-5",
        maxTokens: 150,
        system: INSTRUKS,
        prompt: opts.question,
        // Ingen effort: den gir 400 på Haiku 4.5.
      })).text;
    const ren = String(tekst ?? "").trim();
    if (!ren) return;
    await skriver.skriv(`data: ${JSON.stringify({ type: "forord", text: ren })}\n\n`);
  } catch (_e) {
    // Forordet er pynt. En feil her skal aldri koste brukeren svaret.
  }
}
```

Signaturen er verifisert mot `_lib/anthropic.ts:190`:
`messageAnthropic(opts: AnthropicStreamOptions, deps?: RetryDeps)` tar `prompt`
(ikke `messages`), `system`, `maxTokens`, og returnerer `{ text, usage }`.

- [ ] **Step 4: Kall det fra bakgrunnsjobben**

I `svar-jobb.mts`, rett før bytepumpen:

```ts
  // Bare når turen faktisk kommer til å tenke (altså «Grundig»), og bare på
  // første tur — et resume har allerede vist brukeren tekst.
  //
  // Sekvensielt, ikke parallelt, med vilje: skriveren har ÉN buffer, og to
  // samtidige skrivere ville flettet frames inn i hverandre. Forordet koster
  // ~1,5 s av en tur som uansett tar 30+.
  if (choice.effort && !body.resumeState) {
    await skrivForord(skriver, { apiKey: choice.apiKey, question: String(body.question ?? "") });
  }
```

- [ ] **Step 5: Vis det i klienten**

I `handleSvarEvent`, ny gren før `delta`:

```js
          } else if (ev.type === 'forord') {
            // Dempet, og ryddes bort så snart det ekte svaret begynner.
            let f = thinkingNode.querySelector('.ai-forord');
            if (!f) {
              f = document.createElement('div');
              f.className = 'ai-forord';
              thinkingNode.insertBefore(f, bubble);
            }
            f.textContent = ev.text;
            scrollToBottom();
```

Og i `delta`-grenen, øverst. **NB:** Task 8 la allerede en linje her
(`if (pulsTimer) { clearInterval(pulsTimer); pulsTimer = null; }`) — den skal
BLI STÅENDE. Legg forord-oppryddingen ved siden av, ikke i stedet for:

```js
            if (pulsTimer) { clearInterval(pulsTimer); pulsTimer = null; }
            const f = thinkingNode.querySelector('.ai-forord');
            if (f) f.remove();
```

Legg til i stilarket:

```css
.ai-forord { opacity: .62; font-style: italic; margin: .35rem 0 .6rem; }
```

- [ ] **Step 6: Kjør testene og commit**

Run: `cd netlify/edge-functions && deno test --allow-all _lib/`
Expected: PASS.

```bash
git add netlify/edge-functions/_lib/forord.ts netlify/edge-functions/_lib/forord.test.ts netlify/functions/svar-jobb.mts js/ai-chat.js
git commit -m "feat: Haiku-forord fyller tenkestillheten på Grundig"
```

---

### Task 10: Opprydding, hemmelighet og prod-smoke

**Files:**
- Create: `netlify/functions/rydd-jobber.mts`
- Modify: `.env` (lokal kopi av hemmeligheten)
- Modify: `docs/eval/feiljournal.md` (lukk 60s-entryen)

**Interfaces:**
- Consumes: Task 2 (`lesHead`, `slettJobb`), Task 5 (`jobbStore`).
- Produces: timesplanlagt feiing av foreldreløse jobber.

- [ ] **Step 1: Feieren**

```ts
// netlify/functions/rydd-jobber.mts — nettet under tailerens egen opprydding.
// Lukker brukeren fanen midt i et svar, blir jobben liggende: ingen tailer
// kommer noensinne tilbake for å rydde den.
import type { Config } from "@netlify/functions";
import { lesHead, slettJobb } from "../edge-functions/_lib/jobb-blobb.ts";
import { jobbStore } from "./_shared/node-kabling.mts";

const MAKS_ALDER_MS = 60 * 60 * 1000;

export default async (): Promise<void> => {
  const store = jobbStore();
  const { blobs } = await store.list({ prefix: "" });
  const jobber = new Set(blobs.map((b) => b.key.split("/")[0]));
  const na = Date.now();
  let slettet = 0;
  for (const jobId of jobber) {
    const head = await lesHead(store, jobId);
    // Head mangler (halvskrevet jobb) eller er for gammel → bort med den.
    if (!head || na - head.start > MAKS_ALDER_MS) {
      await slettJobb(store, jobId);
      slettet++;
    }
  }
  console.log(`rydd-jobber: slettet ${slettet} av ${jobber.size} jobber`);
};

export const config: Config = { schedule: "@hourly" };
```

- [ ] **Step 2: Sett hemmeligheten begge steder**

```bash
cd /Users/hom/Documents/GitHub/microdata
netlify status          # BEKREFT at siten er «microstat» før env:set
HEM=$(openssl rand -hex 32)
printf 'SVAR_JOBB_SECRET=%s\n' "$HEM" >> .env
netlify env:set SVAR_JOBB_SECRET "$HEM"
```

To feller her, begge dokumentert i repoets hukommelse:
1. **Sjekk `netlify status` først.** En forvillet `.netlify/state.json` i
   GitHub-mappa har tidligere pekt ukoblede repoer mot `draw-melberg`.
2. **`.env` må oppdateres samtidig**, fordi `netlify env:import .env` senere
   ville blanket verdien som ikke står i fila.

- [ ] **Step 3: Kjør hele suiten en siste gang**

Run: `cd netlify/edge-functions && deno check *.ts _lib/*.ts && deno test --allow-all _lib/`
Expected: PASS, alle tester.

- [ ] **Step 4: Deploy-preview og e2e**

```bash
netlify deploy --build          # preview, IKKE --prod
python3 scripts/eval_svar.py --url <preview-url> --sett docs/eval/svar-evalsett.md
```

Expected: evalsettets spørsmål kommer gjennom på alle tre nivåene. Sjekk
spesielt et «Grundig»-spørsmål som passerer 45 s — det skal vise minst én
overlevering i nettverksfanen uten å avbryte svaret.

- [ ] **Step 5: Lukk feiljournal-entryen**

Legg til i `docs/eval/feiljournal.md` under 60s-entryen:

```
**Endelig lukket <commit>:** background-transporten fjerner taket helt (15 min
per tur). Steg 0-målingen viste dessuten at tenketeksten er kryptert —
thinking_delta kommer én gang, med 0 tegn, ved slutten av tenkefasen — så
stillheten kunne aldri fylles med modellens egen tenking. Løst i stedet med
effort av på balansert (målt 1,12 s til første tekst mot 26-31 s stum),
levende statuslinje, og Haiku-forord på Grundig.
```

- [ ] **Step 6: Commit og push**

```bash
git add netlify/functions/rydd-jobber.mts docs/eval/feiljournal.md
git commit -m "feat(functions): timesfeiing av foreldreløse svarjobber + lukk 60s-entryen"
git push origin main
```
