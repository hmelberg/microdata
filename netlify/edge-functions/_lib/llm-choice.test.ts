import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { chooseModel, coerceQuality } from "./llm-choice.ts";

const noEnv = (_k: string) => undefined;

Deno.test("per-call defaults when the user expressed no preference", () => {
  assertEquals(chooseModel("kode-svar", null, noEnv), { model: "claude-sonnet-5", effort: "high" });
  assertEquals(chooseModel("kode-svar-v2", null, noEnv), { model: "claude-sonnet-5", effort: "high" });
  assertEquals(chooseModel("dm-vurder", null, noEnv), { model: "claude-sonnet-5", effort: "high" });
  assertEquals(chooseModel("data-svar", null, noEnv), { model: "claude-sonnet-5", effort: "high" });
  assertEquals(chooseModel("tolk-resultat", null, noEnv), { model: "claude-sonnet-5", effort: "medium" });
});

Deno.test("picker pass never emits effort — it errors on Haiku 4.5", () => {
  for (const q of [null, "fast", "balanced", "best"] as const) {
    const c = chooseModel("picker", q, noEnv);
    assertEquals(c.model, "claude-haiku-4-5");
    assertEquals(c.effort, undefined);
  }
});

Deno.test("fast tier never emits effort — it errors on Haiku 4.5", () => {
  assertEquals(chooseModel("kode-svar", "fast", noEnv), { model: "claude-haiku-4-5" });
  assertEquals(chooseModel("tolk-resultat", "fast", noEnv), { model: "claude-haiku-4-5" });
});

Deno.test("quality tiers move the model", () => {
  assertEquals(chooseModel("kode-svar", "balanced", noEnv), { model: "claude-sonnet-5", effort: "high" });
  assertEquals(chooseModel("kode-svar", "best", noEnv), { model: "claude-opus-5", effort: "xhigh" });
});

Deno.test("env override beats the user's quality selection", () => {
  const env = (k: string) => (k === "ANTHROPIC_MODEL" ? "claude-opus-4-8" : undefined);
  assertEquals(chooseModel("kode-svar", "fast", env).model, "claude-opus-4-8");
});

Deno.test("DATA_SVAR_MODEL wins over ANTHROPIC_MODEL for data-svar only", () => {
  const env = (k: string) =>
    k === "DATA_SVAR_MODEL" ? "m-data" : k === "ANTHROPIC_MODEL" ? "m-generic" : undefined;
  assertEquals(chooseModel("data-svar", null, env).model, "m-data");
  assertEquals(chooseModel("kode-svar", null, env).model, "m-generic");
});

Deno.test("PICKER_MODEL overrides the picker default, still without effort", () => {
  const env = (k: string) => (k === "PICKER_MODEL" ? "m-pick" : undefined);
  assertEquals(chooseModel("picker", null, env), { model: "m-pick" });
});

Deno.test("an env override keeps the effort the tier would have given", () => {
  const env = (k: string) => (k === "ANTHROPIC_MODEL" ? "claude-opus-4-8" : undefined);
  assertEquals(chooseModel("kode-svar", "best", env), { model: "claude-opus-4-8", effort: "xhigh" });
  assertEquals(chooseModel("tolk-resultat", null, env), { model: "claude-opus-4-8", effort: "medium" });
});

Deno.test("no model ID carries a date suffix", () => {
  const sites = ["kode-svar", "kode-svar-v2", "picker", "dm-vurder", "tolk-resultat", "data-svar"] as const;
  for (const s of sites) {
    for (const q of [null, "fast", "balanced", "best"] as const) {
      assertEquals(/-\d{8}$/.test(chooseModel(s, q, noEnv).model), false, `${s}/${q}`);
    }
  }
});

Deno.test("coerceQuality accepts only the three literals", () => {
  assertEquals(coerceQuality("fast"), "fast");
  assertEquals(coerceQuality("balanced"), "balanced");
  assertEquals(coerceQuality("best"), "best");
  assertEquals(coerceQuality("BEST"), null);
  assertEquals(coerceQuality(""), null);
  assertEquals(coerceQuality(undefined), null);
  assertEquals(coerceQuality(null), null);
  assertEquals(coerceQuality({ q: "fast" }), null);
});
