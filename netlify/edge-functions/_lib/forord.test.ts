import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { skrivForord } from "./forord.ts";

function fangSkriver() {
  const skrevet: string[] = [];
  return {
    skriver: {
      start: () => Promise.resolve(),
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
