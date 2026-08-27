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
    BEFOLKNING_KJOENN: {
      type: "register", data_type: "int", microdata_datatype: "Numerisk (heltall)",
      description: "Kjønn. Enhetstype: Person.", short_title: "Kjønn",
      temporalitet: "Fast", enhetstype: "Person", keywords: ["kjønn"],
    },
  },
};
const KODELISTE = { labels: { "099901": "Ingen utdanning", "099903": "Barnehage" } };

function mockFetch(kodeliste404 = false): typeof fetch {
  return ((url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith("/variable_metadata.json")) {
      return Promise.resolve(new Response(JSON.stringify(META), { status: 200 }));
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
