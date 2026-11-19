import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { variabelInfo, _resetVariabelCache } from "./variabel-info.ts";

// Speiler formen i ekte variable_metadata.json ({variables: {NAVN: {...}}})
// og codelists/<NAVN>.json ({labels: {kode: tekst}, ...}).
const META = {
  variables: {
    NUDB_BU: {
      type: "register", data_type: "string", microdata_datatype: "Alfanumerisk",
      description: "Utdanningens art (NUS2000). Enhetstype: Person. Gyldighetsperiode: 1970 – 2024.",
      short_title: "Utdanningens art", temporalitet: "Forløp", enhetstype: "Person",
      keywords: ["utdanning"],
    },
    SOM_EP_HOVEDTILSTAND1: {
      type: "register", data_type: "string", microdata_datatype: "Alfanumerisk",
      description: "Hovedtilstand 1. Enhetstype: Episode NPR.", short_title: "Hovedtilstand1",
      temporalitet: "Fast", enhetstype: "Episode NPR", databank: "no.fhi.npr",
      external_metadata: "codelists/NPR_ICD10.json", codelist_size: 4,
      populasjon: "Episoder ved somatiske sykehus",
    },
    SOM_EP_SH_REG: {
      type: "register", data_type: "string", microdata_datatype: "Alfanumerisk",
      description: "Regionalt helseforetak.", short_title: "RHF", temporalitet: "Fast",
      enhetstype: "Episode NPR", labels: { "1": "Helse Øst", "3": "Helse Vest" },
    },
    BEFOLKNING_KJOENN: {
      type: "register", data_type: "int", microdata_datatype: "Numerisk (heltall)",
      description: "Kjønn. Enhetstype: Person.", short_title: "Kjønn",
      temporalitet: "Fast", enhetstype: "Person", keywords: ["kjønn"],
    },
  },
};
const KODELISTE = { labels: { "099901": "Ingen utdanning", "099903": "Barnehage" } };
const ICD10 = {
  kodeverk: "ICD-10",
  labels: {
    I210: "Akutt transmuralt hjerteinfarkt i fremre vegg",
    I219: "Uspesifisert akutt hjerteinfarkt",
    I489: "Uspesifisert atrieflimmer",
    E119: "Diabetes mellitus type 2 uten kompl",
  },
};

function mockFetch(kodeliste404 = false): typeof fetch {
  return ((url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith("/variable_metadata.json")) {
      return Promise.resolve(new Response(JSON.stringify(META), { status: 200 }));
    }
    if (u.includes("/codelists/NPR_ICD10.json")) {
      return Promise.resolve(new Response(JSON.stringify(ICD10), { status: 200 }));
    }
    if (u.includes("/codelists/NUDB_BU.json") && !kodeliste404) {
      return Promise.resolve(new Response(JSON.stringify(KODELISTE), { status: 200 }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;
}

Deno.test("variabelInfo: eksakt navn gir detaljblokk med kodeliste", async () => {
  _resetVariabelCache();
  const svar = await variabelInfo("https://x.test", "NUDB_BU", { fetchImpl: mockFetch() });
  assertStringIncludes(svar, "NUDB_BU");
  assertStringIncludes(svar, "Utdanningens art");
  assertStringIncludes(svar, "KODELISTE");
  assertStringIncludes(svar, "099901");
});

Deno.test("variabelInfo: substring-søk gir énlinjes treffliste", async () => {
  _resetVariabelCache();
  const svar = await variabelInfo("https://x.test", "kjønn", { fetchImpl: mockFetch() });
  assertStringIncludes(svar, "BEFOLKNING_KJOENN");
  assertEquals(svar.includes("KODELISTE"), false);
});

Deno.test("variabelInfo: ukjent navn gir ærlig melding, kaster aldri", async () => {
  _resetVariabelCache();
  const svar = await variabelInfo("https://x.test", "FINNES_IKKE_XYZ", { fetchImpl: mockFetch() });
  assertStringIncludes(svar, "Ingen variabel matcher");
});

Deno.test("variabelInfo: kodeliste-404 gir blokk uten kodeliste, ingen feil", async () => {
  _resetVariabelCache();
  const svar = await variabelInfo("https://x.test", "NUDB_BU", { fetchImpl: mockFetch(true) });
  assertStringIncludes(svar, "NUDB_BU");
  assertEquals(svar.includes("KODELISTE"), false);
});

Deno.test("variabelInfo: delt kodelistefil via external_metadata + populasjon/databank", async () => {
  _resetVariabelCache();
  const svar = await variabelInfo("https://x.test", "SOM_EP_HOVEDTILSTAND1", { fetchImpl: mockFetch() });
  assertStringIncludes(svar, "Databank: no.fhi.npr");
  assertStringIncludes(svar, "Populasjon: Episoder");
  assertStringIncludes(svar, "KODELISTE (4 koder)");
  assertStringIncludes(svar, "I219");
});

Deno.test("variabelInfo: kode_sok filtrerer på kode-prefiks", async () => {
  _resetVariabelCache();
  const svar = await variabelInfo("https://x.test", "SOM_EP_HOVEDTILSTAND1", { fetchImpl: mockFetch() }, "I21");
  assertStringIncludes(svar, "treff på «I21» (2 av 4)");
  assertStringIncludes(svar, "I210");
  assertEquals(svar.includes("E119"), false);
});

Deno.test("variabelInfo: kode_sok filtrerer på etikett-tekst, case-insensitivt", async () => {
  _resetVariabelCache();
  const svar = await variabelInfo("https://x.test", "SOM_EP_HOVEDTILSTAND1", { fetchImpl: mockFetch() }, "Diabetes");
  assertStringIncludes(svar, "E119");
  assertEquals(svar.includes("I219"), false);
});

Deno.test("variabelInfo: kode_sok uten treff gir ærlig melding", async () => {
  _resetVariabelCache();
  const svar = await variabelInfo("https://x.test", "SOM_EP_HOVEDTILSTAND1", { fetchImpl: mockFetch() }, "zzz");
  assertStringIncludes(svar, "ingen koder matcher «zzz»");
});

Deno.test("variabelInfo: inline-etiketter brukes når kodelistefil mangler", async () => {
  _resetVariabelCache();
  const svar = await variabelInfo("https://x.test", "SOM_EP_SH_REG", { fetchImpl: mockFetch() });
  assertStringIncludes(svar, "KODELISTE (2 koder)");
  assertStringIncludes(svar, "Helse Vest");
});
