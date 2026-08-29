import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  chunkNokkel, headNokkel, lagSkriver, type BlobbStore,
} from "./jobb-blobb.ts";
import { MAKS_JOBB_MS, tailStream } from "./jobb-tail.ts";

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

/** Klokke som rykker fram et fast antall ms for hvert sleep-kall, fra et
 * valgfritt startpunkt (default 0). Feltene er NØYAKTIG `now` og `sleep`
 * slik at `...k` kan spres rett inn i TailOpts — et ekstra felt her gir
 * overflødig-felt-feil i `deno check`. */
function klokke(stegMs: number, startNa = 0) {
  let na = startNa;
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

// Task 7 review-funn (invertert fra "ferdig jobb ryddes bort etter drenering"):
// en klient som re-GETer fra samme markør etter et nettglipp må finne jobben
// fortsatt der. Den forlatte server-taileren fra FØR bruddet har ingen
// cancel()-handler og poller videre — slettet taileren her, kunne den drenere
// ferdig og rydde bort HELE svaret i det smale vinduet før retryen når fram,
// og retryen ville funnet ingen head i det hele tatt. Retry-idempotens veier
// tyngre enn rask opprydding; den timesvise feieren (rydd-jobber) er nå eneste
// rydder av FERDIGE jobber. Dødjobb-veien beholder sin egen sletting (se
// testene under) — den jobben er faktisk død, og der er det ingen retry å
// beskytte.
Deno.test("ferdig jobb ryddes IKKE bort etter drenering — retry må finne den igjen", async () => {
  const { store, data } = fakeStore();
  const k = klokke(120);
  const s = lagSkriver(store, "j1", k.now);
  await s.skriv('data: {"type":"done"}\n\n');
  await s.avslutt("ferdig");
  await lesAlt(tailStream({ store, jobId: "j1", fra: 0, ...k }));
  assertEquals(data.has("j1/head"), true);
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

// Fix 2 (sluttfiks-planen 2026-08-28): en skriver som har kalt start() men
// ALDRI skriv() (byggLop/buildCachedPrefix ennå ikke ferdig) skal presentere
// en lesbar «kjorer»-head — taileren venter/overleverer, den sier IKKE
// «Svarjobben startet aldri» selv om ventPaaHeadMs er lenge passert.
Deno.test("start() uten noen skriv() gjør at taileren venter, ikke rapporterer 'startet aldri'", async () => {
  const { store } = fakeStore();
  const s = lagSkriver(store, "j1", () => 0);
  await s.start();
  // Klokken ruller forbi BÅDE ventPaaHeadMs (10 s) og fristMs (45 s) — uten
  // start() ville lesHead vært null gjennom hele løpet og løkken ville
  // sluppet ut med "startet aldri" straks ventPaaHeadMs var passert.
  const k = klokke(20_000);
  const ut = await lesAlt(tailStream({
    store, jobId: "j1", fra: 0, now: k.now, sleep: k.sleep,
    fristMs: 45_000, ventPaaHeadMs: 10_000,
  }));
  assertEquals(ut.includes("startet aldri"), false);
  assertStringIncludes(ut, '"type":"tail"');
  assertStringIncludes(ut, '"cursor":0');
});

// ── Dødjobb-vakten (Task 6, ruling 5) ──────────────────────────────────────

Deno.test("jobb «kjorer» over 16 minutter dør med feil, ikke overlevering", async () => {
  const { store, data } = fakeStore();
  // head skrives DIREKTE (ikke via lagSkriver) — vi trenger full kontroll
  // over `start`, som lagSkriver alltid setter til konstruksjonstidspunktet.
  await store.set(chunkNokkel("j1", 1), 'data: {"type":"delta","text":"gammelt"}\n\n');
  await store.setJSON(headNokkel("j1"), { seq: 1, state: "kjorer", start: 0 });
  // Tailerens klokke starter godt forbi MAKS_JOBB_MS etter jobbens start —
  // vakten skal slå til på ALLEREDE FØRSTE løkke-runde, før fristMs (45 s,
  // som "now() - start(taileren)" fortsatt er 0 for) i det hele tatt ville
  // vurdert overlevering. Dette beviser vakten avgjør UAVHENGIG av
  // overleveringsfristen, ikke som en bivirkning av den.
  const k = klokke(1_000, MAKS_JOBB_MS + 60_000);
  const ut = await lesAlt(tailStream({
    store, jobId: "j1", fra: 0, now: k.now, sleep: k.sleep, fristMs: 45_000,
  }));
  // Drenering skjedde FØRST — det gamle innholdet må ikke svelges av feilen.
  assertStringIncludes(ut, 'data: {"type":"delta","text":"gammelt"}\n\n');
  assertStringIncludes(ut, '"type":"error"');
  assertStringIncludes(ut, "16 minutter");
  // Diskriminerer mot: (a) vakten fjernet — ville gitt "tail" her, siden
  // fristMs (45s < 16 min) alltid nås før MAKS_JOBB_MS i noen senere runde;
  // (b) sammenligningen snudd (< i stedet for >) — for denne svært gamle
  // jobben er `now() - head.start` stort, så en snudd sjekk ville aldri
  // slått til, og løkken ville falt gjennom til nøyaktig samme "tail".
  assertEquals(ut.includes('"type":"tail"'), false);
  // Ryddet, som slettJobb gjør ved normal avslutning — en udød jobb ville
  // IKKE blitt ryddet her (se "overlevering rydder IKKE" over).
  assertEquals(data.has("j1/head"), false);
});

Deno.test("fersk «kjorer»-jobb forbi 45s-fristen overleverer likevel normalt", async () => {
  const { store, data } = fakeStore();
  let na = 0;
  // lagSkriver setter start = now() ved konstruksjon = 0 her, altså en jobb
  // som (fra tailerens ståsted) nettopp begynte.
  const s = lagSkriver(store, "j1", () => (na += 200));
  await s.skriv('data: {"type":"delta","text":"en"}\n\n');
  // 20s per sleep: etter tre runder er tailerens "now() - start" 60s, forbi
  // fristMs (45s) — men SVÆRT langt unna MAKS_JOBB_MS (16 min). Vakten må
  // altså IKKE slå til her, selv om jobben fortsatt står "kjorer".
  const k = klokke(20_000);
  const ut = await lesAlt(tailStream({
    store, jobId: "j1", fra: 0, now: k.now, sleep: k.sleep, fristMs: 45_000,
  }));
  assertStringIncludes(ut, 'data: {"type":"delta","text":"en"}\n\n');
  assertStringIncludes(ut, '"type":"tail"');
  // Diskriminerer mot: (a) sammenligningen snudd (< i stedet for >) — da
  // ville `now() - head.start` (0 ved første runde) vært "< MAKS_JOBB_MS",
  // altså SANN, og vakten ville feilaktig slått til på aller første runde,
  // FØR fristMs-sjekken engang kjørte; (b) vakten som slår til uansett tid
  // (kun sjekker state==="kjorer") — samme utfall, feil i stedet for tail.
  // Begge mutantene ville gitt "error" her i stedet for "tail".
  assertEquals(ut.includes('"type":"error"'), false);
  // Jobben ryddes IKKE ved overlevering — lever videre til neste tailer.
  assertEquals(data.has("j1/head"), true);
});

// ── cancel() (Fix 3, sluttfiks-planen 2026-08-28) ──────────────────────────

Deno.test("cancel() stanser en forlatt tailer i stedet for å polle videre mot fristen", async () => {
  const { store } = fakeStore();
  // head skrives DIREKTE (som i dødjobb-testene over), IKKE via lagSkriver:
  // lagSkriver flusher først når FLUSH_MS har gått eller et kontroll-event
  // tvinger det, og denne testens klokke (now: () => 0) står bevisst stille
  // — en lagSkriver-buffer ville aldri flushet, og taileren ville ventet på
  // en head som aldri kom.
  await store.set(chunkNokkel("j1", 1), 'data: {"type":"delta","text":"en"}\n\n');
  await store.setJSON(headNokkel("j1"), { seq: 1, state: "kjorer", start: 0 });
  // "kjorer", ufullført — akkurat tilstanden en forlatt tailer ville sittet
  // og pollet mot helt til fristMs (45 s) uten cancel()-fiksen.
  let sleepKall = 0;
  // Objekt, ikke en bar `let` — en `let`-variabel som BARE tildeles inne i en
  // Promise-executor-closure fikk `deno check` (TS' kontrollflyt-analyse) til
  // å feilaktig konkludere `never` ved bruk lenger ned. Feltet unngår kvirken.
  const holder: { slipp: (() => void) | null } = { slipp: null };
  // `sleep` henger til vi selv slipper den — det gir oss et deterministisk
  // punkt å kalle cancel() på MENS løkken venter, i stedet for å gjette
  // riktig tidspunkt med ekte timere.
  const sleep = (_ms: number): Promise<void> => {
    sleepKall++;
    return new Promise<void>((resolve) => { holder.slipp = () => resolve(); });
  };
  const stream = tailStream({
    store, jobId: "j1", fra: 0, now: () => 0, sleep, fristMs: 45_000, ventPaaHeadMs: 10_000,
  });
  const reader = stream.getReader();
  const forste = await reader.read();   // henter den ene chunken
  assertEquals(new TextDecoder().decode(forste.value), 'data: {"type":"delta","text":"en"}\n\n');
  // Løkken har nå funnet "kjorer" uten noe nytt å hente, og henger i sitt
  // (kontrollerte) sleep()-kall — én runde er alt som skal til.
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(sleepKall, 1);
  await reader.cancel();
  const kallVedCancel = sleepKall;
  holder.slipp?.();   // slipp løkken videre — med fiksen treffer den avbrutt-sjekken FØR neste lesHead/sleep
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(sleepKall, kallVedCancel,
    "løkken kalte sleep() på nytt etter cancel() — den forlatte tailerens polling stanset ikke");
});
