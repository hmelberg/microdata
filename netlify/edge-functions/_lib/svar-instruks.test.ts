import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildSvarSystem, demoteHeadings, questionTurn, progressLabel,
  RUN_CODE_TOOL, svarBudsjett, VARIABEL_INFO_TOOL,
} from "./svar-instruks.ts";

const DEPS = { prefix: "PREFIKS-INNHOLD" };

Deno.test("buildSvarSystem: syntetisk-premisset er eksplisitt", async () => {
  const s = await buildSvarSystem("https://x.test", "microdata", DEPS);
  assertStringIncludes(s, "syntetiske");
  assertStringIncludes(s, "aldri presenteres som faktisk statistikk");
});

Deno.test("buildSvarSystem: svarformatet bærer v2-arven «Vurderinger og forslag»", async () => {
  const s = await buildSvarSystem("https://x.test", "microdata", DEPS);
  assertStringIncludes(s, "Vurderinger og forslag");
});

Deno.test("buildSvarSystem: run_code-instruksen nevner OK./FEIL-kontrakten", async () => {
  const s = await buildSvarSystem("https://x.test", "microdata", DEPS);
  assertStringIncludes(s, "OK.");
  assertStringIncludes(s, "FEIL:");
});

Deno.test("buildSvarSystem: prefiksen kommer først, injisert via deps", async () => {
  const s = await buildSvarSystem("https://x.test", "microdata", DEPS);
  assert(s.startsWith("PREFIKS-INNHOLD"));
});

Deno.test("buildSvarSystem: egne instruksjoner tas med, med demoterte overskrifter", async () => {
  const med = await buildSvarSystem("https://x.test", "microdata", {
    ...DEPS, userInstructions: "# Min regel\nSvar alltid på nynorsk.",
  });
  assertStringIncludes(med, "Brukerens egne instruksjoner");
  assertStringIncludes(med, "### Min regel");
  assertStringIncludes(med, "nynorsk");
  const uten = await buildSvarSystem("https://x.test", "microdata", DEPS);
  assertEquals(uten.includes("Brukerens egne instruksjoner"), false);
});

Deno.test("demoteHeadings: to nivåer ned, tak 6", () => {
  assertEquals(demoteHeadings("# a\n##### b"), "### a\n###### b");
});

Deno.test("svarBudsjett: kvalitet styrer verktøykall og kjøringer", () => {
  assertEquals(svarBudsjett("fast"), { clientCalls: 8, runCalls: 3 });
  assertEquals(svarBudsjett("balanced"), { clientCalls: 12, runCalls: 4 });
  assertEquals(svarBudsjett("best"), { clientCalls: 20, runCalls: 6 });
});

Deno.test("verktøydefinisjonene har riktige navn og påkrevde felt", () => {
  assertEquals(RUN_CODE_TOOL.name, "run_code");
  assertEquals(RUN_CODE_TOOL.input_schema.required, ["script"]);
  assertEquals(VARIABEL_INFO_TOOL.name, "variabel_info");
  assertEquals(VARIABEL_INFO_TOOL.input_schema.required, ["navn"]);
});

Deno.test("questionTurn: script-kontekst rides med når den finnes", () => {
  const med = questionTurn("Hva er X?", "import all from A");
  assertStringIncludes(med, "import all from A");
  assertStringIncludes(med, "Hva er X?");
  const uten = questionTurn("Hva er X?");
  assertEquals(uten.includes("```"), false);
});

Deno.test("progressLabel: run_code og variabel_info får egne etiketter", () => {
  assertStringIncludes(progressLabel("run_code", {}), "Kjører scriptet");
  assertStringIncludes(progressLabel("variabel_info", { navn: "NUDB_BU" }), "NUDB_BU");
});
