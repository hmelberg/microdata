import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { byggLop } from "./svar-lop.ts";

Deno.test("prefiks-feil gir 502 som Response, ikke en kastet feil", async () => {
  const ut = await byggLop({
    origin: "https://eksempel.invalid",
    question: "hei", mode: "microdata",
    choice: { apiKey: "sk-ant-test", model: "claude-sonnet-5" },
    erPersonlig: false, byokKey: null, runOkCalls: 0, kvalitet: "balanced",
    journalHendelse: () => {}, turnDeadlineMs: 50_000,
    buildSystem: () => { throw new Error("prefiks nede"); },
  });
  assertEquals(ut instanceof Response, true);
  assertEquals((ut as Response).status, 502);
});
