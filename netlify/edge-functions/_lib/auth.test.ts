import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type AdminGateDeps,
  clientIp,
  extractByokKey,
  extractLlmKey,
  type GateDeps,
  runAdminGate,
  runGate,
  timingSafeEqual,
  upstreamErrorResponse,
} from "./auth.ts";

function req(opts: {
  method?: string;
  token?: string;
  contentLength?: number;
  ip?: string;
  xff?: string;
  byok?: string;
  llm?: string;
} = {}): Request {
  const headers = new Headers();
  if (opts.token !== undefined) headers.set("authorization", `Bearer ${opts.token}`);
  if (opts.contentLength !== undefined) {
    headers.set("content-length", String(opts.contentLength));
  }
  if (opts.ip) headers.set("x-nf-client-connection-ip", opts.ip);
  if (opts.xff) headers.set("x-forwarded-for", opts.xff);
  if (opts.byok !== undefined) headers.set("x-anthropic-key", opts.byok);
  if (opts.llm !== undefined) headers.set("x-llm-key", opts.llm);
  return new Request("https://example.test/", {
    method: opts.method ?? "POST",
    headers,
  });
}

function makeDeps(over: Partial<GateDeps> = {}): GateDeps {
  return {
    sharedToken: undefined,
    checkRateLimit: () => Promise.resolve({ allowed: true, retryAfterSeconds: 0 }),
    ...over,
  };
}

function adminDeps(over: Partial<AdminGateDeps> = {}): AdminGateDeps {
  return {
    sharedToken: undefined,
    checkRateLimit: () => Promise.resolve({ allowed: true, retryAfterSeconds: 0 }),
    ...over,
  };
}

Deno.test("timingSafeEqual: equal strings match, different do not", () => {
  assertEquals(timingSafeEqual("secret-token", "secret-token"), true);
  assertEquals(timingSafeEqual("secret-token", "secret-tokeX"), false);
  assertEquals(timingSafeEqual("short", "longer-value"), false);
  assertEquals(timingSafeEqual("", ""), true);
});

Deno.test("clientIp: trusts x-nf-client-connection-ip, ignores x-forwarded-for", () => {
  assertEquals(clientIp(req({ ip: "1.2.3.4" })), "1.2.3.4");
  // spoofable header must NOT be used
  assertEquals(clientIp(req({ xff: "9.9.9.9" })), "");
});

Deno.test("runGate: missing token -> 401", async () => {
  const resp = await runGate(req({ token: undefined }), { endpoint: "t", maxBodyBytes: 100 }, makeDeps());
  assertEquals(resp?.status, 401);
});

Deno.test("runGate: non-POST -> 405", async () => {
  const resp = await runGate(req({ method: "GET", token: "x" }), { endpoint: "t", maxBodyBytes: 100 }, makeDeps());
  assertEquals(resp?.status, 405);
});

Deno.test("runGate: oversized content-length -> 413", async () => {
  const resp = await runGate(req({ token: "x", contentLength: 999 }), { endpoint: "t", maxBodyBytes: 100 }, makeDeps());
  assertEquals(resp?.status, 413);
});

Deno.test("runGate: rate-limited -> 429 with Retry-After", async () => {
  const deps = makeDeps({
    checkRateLimit: () => Promise.resolve({ allowed: false, retryAfterSeconds: 42 }),
  });
  const resp = await runGate(req({ token: "x" }), { endpoint: "t", maxBodyBytes: 100 }, deps);
  assertEquals(resp?.status, 429);
  assertEquals(resp?.headers.get("Retry-After"), "42");
});

Deno.test("runGate: valid shared token proceeds", async () => {
  const deps = makeDeps({ sharedToken: "shared-secret" });
  const resp = await runGate(req({ token: "shared-secret" }), { endpoint: "t", maxBodyBytes: 100 }, deps);
  assertEquals(resp, null);
});

Deno.test("runGate: wrong token -> immediate 401 (ingen Anvil-fallback)", async () => {
  const deps = makeDeps({ sharedToken: "shared-secret" });
  const resp = await runGate(req({ token: "nope" }), { endpoint: "t", maxBodyBytes: 100 }, deps);
  assertEquals(resp?.status, 401);
});

Deno.test("runGate: no passwords configured -> every token is 401", async () => {
  const resp = await runGate(req({ token: "anything" }), { endpoint: "t", maxBodyBytes: 100 }, makeDeps());
  assertEquals(resp?.status, 401);
});

// Admin gate tests

Deno.test("runAdminGate: shared token passes, wrong token 401", async () => {
  const opts = { endpoint: "data-svar", maxBodyBytes: 1000 };
  const deps = adminDeps({ sharedToken: "hemmelig" });
  assertEquals(await runAdminGate(req({ token: "hemmelig" }), opts, deps), null);
  const r401 = await runAdminGate(req({ token: "feil" }), opts, deps);
  assertEquals(r401?.status, 401);
});

Deno.test("runAdminGate: allowedMethods lets GET through when configured", async () => {
  const opts = { endpoint: "hent", maxBodyBytes: 0, allowedMethods: ["GET"] };
  const getReq = req({ token: "t", method: "GET" });
  assertEquals(await runAdminGate(getReq, opts, adminDeps({ sharedToken: "t" })), null);
  const postOpts = { endpoint: "hent", maxBodyBytes: 0 }; // default POST-only
  assertEquals((await runAdminGate(getReq, postOpts, adminDeps({ sharedToken: "t" })))?.status, 405);
});

// ── BYOK: user-supplied Anthropic key ──

const GOOD_KEY = "sk-ant-api03-abc123_DEF-456";

Deno.test("extractByokKey: accepts well-formed sk-ant key", () => {
  assertEquals(extractByokKey(req({ byok: GOOD_KEY })), GOOD_KEY);
});

Deno.test("extractByokKey: trims surrounding whitespace", () => {
  assertEquals(extractByokKey(req({ byok: `  ${GOOD_KEY}  ` })), GOOD_KEY);
});

Deno.test("extractByokKey: rejects wrong prefix, bad chars, empty, absent", () => {
  assertEquals(extractByokKey(req({ byok: "sk-live-abc" })), null);
  assertEquals(extractByokKey(req({ byok: "sk-ant-abc def" })), null);
  assertEquals(extractByokKey(req({ byok: "sk-ant-abc!" })), null);
  assertEquals(extractByokKey(req({ byok: "" })), null);
  assertEquals(extractByokKey(req({})), null);
});

Deno.test("extractByokKey: rejects keys longer than 250 chars", () => {
  const long = "sk-ant-" + "a".repeat(244); // total 251
  assertEquals(extractByokKey(req({ byok: long })), null);
  const ok = "sk-ant-" + "a".repeat(243); // total 250
  assertEquals(extractByokKey(req({ byok: ok })), ok);
});

Deno.test("upstreamErrorResponse: BYOK + Anthropic 401 -> 401 Ugyldig", async () => {
  const resp = upstreamErrorResponse(new Error("Anthropic API error 401"), GOOD_KEY);
  assertEquals(resp.status, 401);
  assertEquals(await resp.text(), "Ugyldig Anthropic-nøkkel");
});

Deno.test("upstreamErrorResponse: BYOK + other error -> 502", () => {
  assertEquals(upstreamErrorResponse(new Error("Anthropic API error 529"), GOOD_KEY).status, 502);
});

Deno.test("upstreamErrorResponse: no BYOK -> always 502", () => {
  assertEquals(upstreamErrorResponse(new Error("Anthropic API error 401"), null).status, 502);
});

// ── BYOK: runGate and runAdminGate paths ──

Deno.test("runGate: valid BYOK header, no bearer -> passes", async () => {
  const resp = await runGate(req({ byok: GOOD_KEY }), { endpoint: "t", maxBodyBytes: 100, allowByok: true }, makeDeps());
  assertEquals(resp, null);
});

Deno.test("runGate: malformed BYOK header, no bearer -> 401", async () => {
  const resp = await runGate(req({ byok: "not-a-key" }), { endpoint: "t", maxBodyBytes: 100, allowByok: true }, makeDeps());
  assertEquals(resp?.status, 401);
});

Deno.test("runGate: BYOK still method-checked -> 405", async () => {
  const resp = await runGate(req({ byok: GOOD_KEY, method: "GET" }), { endpoint: "t", maxBodyBytes: 100, allowByok: true }, makeDeps());
  assertEquals(resp?.status, 405);
});

Deno.test("runGate: BYOK still body-capped -> 413", async () => {
  const resp = await runGate(req({ byok: GOOD_KEY, contentLength: 999 }), { endpoint: "t", maxBodyBytes: 100, allowByok: true }, makeDeps());
  assertEquals(resp?.status, 413);
});

Deno.test("runGate: BYOK still rate-limited -> 429", async () => {
  const deps = makeDeps({
    checkRateLimit: () => Promise.resolve({ allowed: false, retryAfterSeconds: 7 }),
  });
  const resp = await runGate(req({ byok: GOOD_KEY }), { endpoint: "t", maxBodyBytes: 100, allowByok: true }, deps);
  assertEquals(resp?.status, 429);
});

Deno.test("runAdminGate: valid BYOK header, no bearer -> passes without admin", async () => {
  const resp = await runAdminGate(req({ byok: GOOD_KEY }), { endpoint: "t", maxBodyBytes: 100, allowByok: true }, adminDeps());
  assertEquals(resp, null);
});

Deno.test("runAdminGate: no BYOK, wrong token -> 401", async () => {
  const deps = adminDeps({ sharedToken: "riktig" });
  const resp = await runAdminGate(req({ token: "user-token" }), { endpoint: "t", maxBodyBytes: 100, allowByok: true }, deps);
  assertEquals(resp?.status, 401);
});

// ── BYOK is opt-in per endpoint (finding 1: hent must never allow it) ──

Deno.test("runGate: valid BYOK header, NO allowByok -> 401 (BYOK not accepted)", async () => {
  const resp = await runGate(req({ byok: GOOD_KEY }), { endpoint: "t", maxBodyBytes: 100 }, makeDeps());
  assertEquals(resp?.status, 401);
});

Deno.test("runAdminGate: valid BYOK header, NO allowByok -> 401 (BYOK ignored)", async () => {
  const resp = await runAdminGate(req({ byok: GOOD_KEY }), { endpoint: "t", maxBodyBytes: 100 }, adminDeps());
  assertEquals(resp?.status, 401);
});

Deno.test("runGate: allowByok, valid BYOK header AND invalid Bearer token both present -> passes (BYOK wins)", async () => {
  const headers = new Headers();
  headers.set("authorization", "Bearer definitely-not-valid");
  headers.set("x-anthropic-key", GOOD_KEY);
  const request = new Request("https://example.test/", { method: "POST", headers });
  const resp = await runGate(request, { endpoint: "t", maxBodyBytes: 100, allowByok: true }, makeDeps());
  assertEquals(resp, null);
});

// ── extractLlmKey (multi-provider-runden 2026-08-27) ──────────────────────
// Format-agnostisk men avgrenset: leverandørene har ulike nøkkelformater, så
// vi kan ikke kreve et prefiks — men lengde og printbar ASCII holder søppel
// (og header-smugling via kontrolltegn) ute.

Deno.test("extractLlmKey accepts a plausible provider key", () => {
  assertEquals(extractLlmKey(req({ llm: "sk-abcdefgh" })), "sk-abcdefgh");
  assertEquals(extractLlmKey(req({ llm: "  sk-trimmed-me  " })), "sk-trimmed-me");
});

Deno.test("extractLlmKey rejects out-of-range lengths", () => {
  assertEquals(extractLlmKey(req({ llm: "short7x" })), null);
  assertEquals(extractLlmKey(req({ llm: "a".repeat(251) })), null);
  assertEquals(extractLlmKey(req({ llm: "a".repeat(250) })), "a".repeat(250));
});

Deno.test("extractLlmKey rejects non-ASCII and embedded spaces", () => {
  assertEquals(extractLlmKey(req({ llm: "abcdefghå" })), null);
  assertEquals(extractLlmKey(req({ llm: "abcd efgh" })), null);
  // Kontrolltegn (NUL o.l.) testes IKKE her: Headers.set avviser dem som
  // ugyldig header-verdi, så de kan ikke nå extractLlmKey via en ekte
  // forespørsel i det hele tatt. Regexen dekker dem uansett.
});

Deno.test("extractLlmKey returns null when the header is absent", () => {
  assertEquals(extractLlmKey(req({})), null);
});

// ── to passord: personlig + delt (2026-08-28) ─────────────────────────────

Deno.test("runGate: valid personal token proceeds", async () => {
  const deps = makeDeps({ sharedToken: "delt", personalToken: "privat" });
  const r = await runGate(req({ token: "privat" }), { endpoint: "kode-svar", maxBodyBytes: 1000 }, deps);
  assertEquals(r, null);
});

Deno.test("runGate: wrong token is 401 even with both passwords configured", async () => {
  const deps = makeDeps({ sharedToken: "delt", personalToken: "privat" });
  const r = await runGate(req({ token: "feil" }), { endpoint: "kode-svar", maxBodyBytes: 1000 }, deps);
  assertEquals(r?.status, 401);
});

Deno.test("runAdminGate: personal token is admin", async () => {
  const deps = adminDeps({ sharedToken: "delt", personalToken: "privat" });
  const r = await runAdminGate(req({ token: "privat" }), { endpoint: "data-svar", maxBodyBytes: 1000 }, deps);
  assertEquals(r, null);
});

// ── personlig passord: ingen ratelimit (2026-08-28) ───────────────────────

const denyAll = () => Promise.resolve({ allowed: false, retryAfterSeconds: 60 });

Deno.test("runGate: personal token skips the rate limit entirely", async () => {
  let rateCalls = 0;
  const deps = makeDeps({
    personalToken: "privat",
    checkRateLimit: () => { rateCalls++; return denyAll(); },
  });
  const r = await runGate(req({ token: "privat" }), { endpoint: "kode-svar", maxBodyBytes: 1000 }, deps);
  assertEquals(r, null);
  assertEquals(rateCalls, 0);
});

Deno.test("runGate: shared token is still rate-limited", async () => {
  const deps = makeDeps({ sharedToken: "delt", personalToken: "privat", checkRateLimit: denyAll });
  const r = await runGate(req({ token: "delt" }), { endpoint: "kode-svar", maxBodyBytes: 1000 }, deps);
  assertEquals(r?.status, 429);
});

Deno.test("runGate: wrong guesses are still rate-limited even with a personal token configured", async () => {
  const deps = makeDeps({ personalToken: "privat", checkRateLimit: denyAll });
  const r = await runGate(req({ token: "feil" }), { endpoint: "kode-svar", maxBodyBytes: 1000 }, deps);
  assertEquals(r?.status, 429);
});

Deno.test("runAdminGate: personal token skips the rate limit entirely", async () => {
  let rateCalls = 0;
  const deps = adminDeps({
    personalToken: "privat",
    checkRateLimit: () => { rateCalls++; return denyAll(); },
  });
  const r = await runAdminGate(req({ token: "privat" }), { endpoint: "data-svar", maxBodyBytes: 1000 }, deps);
  assertEquals(r, null);
  assertEquals(rateCalls, 0);
});
