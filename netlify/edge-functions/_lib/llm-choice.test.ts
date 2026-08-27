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

// ── resolveLlm ────────────────────────────────────────────────────────────
import { type LlmChoice, resolveLlm } from "./llm-choice.ts";

function reqWith(headers: Record<string, string>): Request {
  const h = new Headers();
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return new Request("https://example.test/", { method: "POST", headers: h });
}
const serverKey = (k: string) => (k === "ANTHROPIC_API_KEY" ? "server-key" : undefined);
const MISTRAL = {
  type: "openai-compat",
  base_url: "https://api.mistral.ai/v1",
  model: "mistral-large-latest",
};

Deno.test("THE BYPASS: llm-key without a provider config is 401, never the server key", () => {
  const r = resolveLlm(reqWith({ "x-llm-key": "sk-abcdefgh" }), {}, "kode-svar", serverKey);
  assertEquals(r instanceof Response, true);
  assertEquals((r as Response).status, 401);
});

Deno.test("byok key wins over the server key", () => {
  const c = resolveLlm(reqWith({ "x-anthropic-key": "sk-ant-user" }), {}, "kode-svar", serverKey) as LlmChoice;
  assertEquals(c.apiKey, "sk-ant-user");
  assertEquals(c.provider, undefined);
});

Deno.test("no credentials at all falls back to the server key", () => {
  const c = resolveLlm(reqWith({}), {}, "kode-svar", serverKey) as LlmChoice;
  assertEquals(c.apiKey, "server-key");
});

Deno.test("complete provider config authenticates and carries its own key", () => {
  const c = resolveLlm(
    reqWith({ "x-llm-key": "sk-abcdefgh" }), { provider: MISTRAL }, "kode-svar", () => undefined,
  ) as LlmChoice;
  assertEquals(c.apiKey, "sk-abcdefgh");
  assertEquals(c.provider?.model, "mistral-large-latest");
  assertEquals(c.provider?.type, "openai-compat");
});

Deno.test("a provider config with a blocked base_url is a 400, not a silent fallback", () => {
  const r = resolveLlm(
    reqWith({ "x-llm-key": "sk-abcdefgh" }),
    { provider: { ...MISTRAL, base_url: "http://localhost:11434/v1" } },
    "kode-svar", serverKey,
  );
  assertEquals(r instanceof Response, true);
  assertEquals((r as Response).status, 400);
});

Deno.test("no key anywhere is a 500, not a crash", () => {
  const r = resolveLlm(reqWith({}), {}, "kode-svar", () => undefined);
  assertEquals(r instanceof Response, true);
  assertEquals((r as Response).status, 500);
});

Deno.test("quality from the body reaches the choice", () => {
  const c = resolveLlm(reqWith({ "x-anthropic-key": "sk-ant-user01" }), { quality: "best" },
    "kode-svar", () => undefined) as LlmChoice;
  assertEquals(c.model, "claude-opus-5");
  assertEquals(c.effort, "xhigh");
});

Deno.test("a junk quality value falls back to the per-call default", () => {
  const c = resolveLlm(reqWith({ "x-anthropic-key": "sk-ant-user01" }), { quality: "turbo" },
    "tolk-resultat", () => undefined) as LlmChoice;
  assertEquals(c.model, "claude-sonnet-5");
  assertEquals(c.effort, "medium");
});

Deno.test("picker site never gets effort even through resolveLlm", () => {
  const c = resolveLlm(reqWith({ "x-anthropic-key": "sk-ant-user01" }), { quality: "best" },
    "picker", () => undefined) as LlmChoice;
  assertEquals(c.model, "claude-haiku-4-5");
  assertEquals(c.effort, undefined);
});

// ── to passord → to servernøkler (2026-08-28) ─────────────────────────────
const twoKeyEnv = (k: string): string | undefined =>
  ({
    ANTHROPIC_API_KEY: "server-key",
    ANTHROPIC_API_KEY_PERSONAL: "personal-key",
    M2PY_ACCESS_TOKEN: "delt-pass",
    M2PY_ACCESS_TOKEN_PERSONAL: "privat-pass",
  } as Record<string, string | undefined>)[k];

Deno.test("personal password selects the personal server key", () => {
  const c = resolveLlm(reqWith({ authorization: "Bearer privat-pass" }), {}, "kode-svar", twoKeyEnv) as LlmChoice;
  assertEquals(c.apiKey, "personal-key");
});

Deno.test("shared password still selects the shared server key", () => {
  const c = resolveLlm(reqWith({ authorization: "Bearer delt-pass" }), {}, "kode-svar", twoKeyEnv) as LlmChoice;
  assertEquals(c.apiKey, "server-key");
});

Deno.test("personal password with no personal key is 500 — never the shared key", () => {
  const env = (k: string): string | undefined =>
    k === "ANTHROPIC_API_KEY" ? "server-key"
    : k === "M2PY_ACCESS_TOKEN_PERSONAL" ? "privat-pass"
    : undefined;
  const r = resolveLlm(reqWith({ authorization: "Bearer privat-pass" }), {}, "kode-svar", env);
  assertEquals((r as Response).status, 500);
});

Deno.test("byok key wins over the personal password", () => {
  const c = resolveLlm(
    reqWith({ "x-anthropic-key": "sk-ant-user", authorization: "Bearer privat-pass" }),
    {}, "kode-svar", twoKeyEnv,
  ) as LlmChoice;
  assertEquals(c.apiKey, "sk-ant-user");
});

// ── svar-kallstedet (samlet pipeline 2026-08-28) ──────────────────────────
Deno.test("svar: default sonnet-5 high; SVAR_MODEL vinner over ANTHROPIC_MODEL", () => {
  assertEquals(chooseModel("svar", null, () => undefined),
    { model: "claude-sonnet-5", effort: "high" });
  const env = (k: string) =>
    k === "SVAR_MODEL" ? "pinned-svar" : k === "ANTHROPIC_MODEL" ? "pinned-generelt" : undefined;
  assertEquals(chooseModel("svar", null, env).model, "pinned-svar");
});

Deno.test("svar: kvalitet flytter modellen som for andre kallsteder", () => {
  assertEquals(chooseModel("svar", "best", () => undefined),
    { model: "claude-opus-5", effort: "xhigh" });
});
