# Multi-provider BYOK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a microdata user bring credentials for any major cloud LLM provider instead of only Anthropic, and give them one comprehensible control over answer quality.

**Architecture:** Three provider *protocol* types (`anthropic-compat`, `openai-compat`, `openai-responses`) cover the whole cloud market. askstat's `providers/` layer is copied verbatim to keep cherry-picks between the sibling repos working; the genuinely new code is a **single-shot** provider layer (askstat only ever built provider support for its agentic path, and four of microdata's five endpoints are single-shot). One shared `resolveLlm` helper enforces the anonymous-bypass invariant in one place instead of five.

**Tech Stack:** Deno edge functions (raw `fetch`, no SDK — SSE is streamed through), vanilla ES5-style browser JS (`window.*` globals, no bundler), `deno test`.

**Spec:** `docs/superpowers/specs/2026-08-27-multi-provider-byok-design.md`

## Global Constraints

- **Copied files must not be re-styled.** `_lib/providers/{config,agentic,openai-compat,openai-responses}.ts` and their tests are byte-copies from `askstat/`. Keep comments, Norwegian text and formatting exactly as-is.
- **Model IDs carry no date suffix.** `claude-haiku-4-5`, `claude-sonnet-5`, `claude-opus-5`.
- **`effort` errors on Haiku 4.5.** Never emit `effort` for the Fast tier or the v2 picker pass.
- **`output_config.effort` is nested**, not a top-level request field. No beta header.
- **The SSE output contract does not change**: `{type:"text",text}` / `{type:"done",inputTokens,outputTokens,cacheReadTokens,cacheCreationTokens}` / `{type:"error",message}`. `js/ai-chat.js`'s stream reader must need no edits.
- **Precedence:** env override > user quality selection > per-call default.
- **Never log a key.** `scrubKey` runs over upstream error text before it can reach `console.error`.
- Test command: `cd netlify/edge-functions && deno check *.ts _lib/*.ts _lib/providers/*.ts && deno test --allow-all _lib/`
- Branch: `multi-provider-byok`. Commit per task. Do not push.

---

### Task 1: Shared SSE frame parser

`transformAnthropicStream` currently carries its main loop and its drain block as a verbatim ~35-line copy-paste. `openai-compat` needs the same parsing. One parser, two callers.

**Files:**
- Create: `netlify/edge-functions/_lib/sse-frames.ts`
- Create: `netlify/edge-functions/_lib/sse-frames.test.ts`
- Modify: `netlify/edge-functions/_lib/anthropic.ts:202-290` (`transformAnthropicStream`)

**Interfaces:**
- Produces: `parseSseFrames(chunk: string, buffer: string): { payloads: string[]; buffer: string }` — appends `chunk` to `buffer`, splits on `\n\n`, returns each frame's `data:` payload (trimmed, `[DONE]` and empty dropped) plus the unconsumed remainder. `flushSseBuffer(buffer: string): string[]` drains a final unterminated frame.

- [ ] **Step 1: Write the failing test**

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { flushSseBuffer, parseSseFrames } from "./sse-frames.ts";

Deno.test("parseSseFrames extracts complete frames and keeps the remainder", () => {
  const r = parseSseFrames('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"', "");
  assertEquals(r.payloads, ['{"a":1}', '{"b":2}']);
  assertEquals(r.buffer, 'data: {"c"');
});

Deno.test("parseSseFrames joins a payload split across chunks", () => {
  const a = parseSseFrames('data: {"a":', "");
  assertEquals(a.payloads, []);
  const b = parseSseFrames('1}\n\n', a.buffer);
  assertEquals(b.payloads, ['{"a":1}']);
});

Deno.test("parseSseFrames drops [DONE] and empty payloads", () => {
  const r = parseSseFrames("data: [DONE]\n\ndata: \n\ndata: x\n\n", "");
  assertEquals(r.payloads, ["x"]);
});

Deno.test("parseSseFrames ignores frames with no data: line", () => {
  const r = parseSseFrames("event: ping\n\ndata: y\n\n", "");
  assertEquals(r.payloads, ["y"]);
});

Deno.test("flushSseBuffer drains a final frame with no trailing blank line", () => {
  assertEquals(flushSseBuffer('data: {"z":9}'), ['{"z":9}']);
  assertEquals(flushSseBuffer("   "), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd netlify/edge-functions && deno test --allow-all _lib/sse-frames.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`sse-frames.ts`: accumulate into `buffer`, loop on `indexOf("\n\n")`, for each frame find the line starting with `data:`, `slice(5).trim()`, skip empty and `[DONE]`. `flushSseBuffer` runs the same extraction on a non-empty trailing buffer.

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --allow-all _lib/sse-frames.test.ts` → PASS

- [ ] **Step 5: Refactor `transformAnthropicStream` onto the parser**

Replace both the main `while` loop's inline parsing and the entire duplicated drain block with calls to `parseSseFrames` / `flushSseBuffer`, keeping one `handlePayload(payload)` closure holding the existing `content_block_delta` / `message_start` / `message_delta` branches.

- [ ] **Step 6: Verify the whole edge suite is still green**

Run: `deno check *.ts _lib/*.ts && deno test --allow-all _lib/`
Expected: PASS, including the existing `anthropic.test.ts`. This is the regression gate — the Anthropic path must be behaviourally unchanged.

- [ ] **Step 7: Commit**

```bash
git add netlify/edge-functions/_lib/sse-frames.ts netlify/edge-functions/_lib/sse-frames.test.ts netlify/edge-functions/_lib/anthropic.ts
git commit -m "refactor(edge): én SSE-rammeparser — fjerner 35-linjers dublett i transformAnthropicStream"
```

---

### Task 2: Quality tiers and per-call model/effort defaults

**Files:**
- Create: `netlify/edge-functions/_lib/llm-choice.ts`
- Create: `netlify/edge-functions/_lib/llm-choice.test.ts`

**Interfaces:**
- Produces:
  - `type Quality = "fast" | "balanced" | "best"`
  - `type CallSite = "kode-svar" | "kode-svar-v2" | "picker" | "dm-vurder" | "tolk-resultat" | "data-svar"`
  - `coerceQuality(u: unknown): Quality | null` — `null` for anything not one of the three literals
  - `chooseModel(site: CallSite, quality: Quality | null, env: (k: string) => string | undefined): { model: string; effort?: string }`

The `env` parameter is injected so tests never touch `Deno.env`.

- [ ] **Step 1: Write the failing test**

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { chooseModel, coerceQuality } from "./llm-choice.ts";

const noEnv = (_k: string) => undefined;

Deno.test("per-call defaults when the user expressed no preference", () => {
  assertEquals(chooseModel("kode-svar", null, noEnv), { model: "claude-sonnet-5", effort: "high" });
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
  const c = chooseModel("kode-svar", "fast", noEnv);
  assertEquals(c, { model: "claude-haiku-4-5" });
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

Deno.test("PICKER_MODEL overrides the picker default", () => {
  const env = (k: string) => (k === "PICKER_MODEL" ? "m-pick" : undefined);
  assertEquals(chooseModel("picker", null, env), { model: "m-pick" });
});

Deno.test("no model ID carries a date suffix", () => {
  for (const q of ["fast", "balanced", "best"] as const) {
    assertEquals(/-\d{8}$/.test(chooseModel("kode-svar", q, noEnv).model), false);
  }
});

Deno.test("coerceQuality accepts only the three literals", () => {
  assertEquals(coerceQuality("best"), "best");
  assertEquals(coerceQuality("BEST"), null);
  assertEquals(coerceQuality(""), null);
  assertEquals(coerceQuality(undefined), null);
  assertEquals(coerceQuality({ q: "fast" }), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-all _lib/llm-choice.test.ts` → FAIL, module not found.

- [ ] **Step 3: Write minimal implementation**

Table-driven. Env lookup first (`PICKER_MODEL` for `picker`; `DATA_SVAR_MODEL` then `ANTHROPIC_MODEL` for `data-svar`; `ANTHROPIC_MODEL` otherwise). Then quality tier if set. Then the per-call default. `picker` always returns `{model, effort: undefined}`; the `fast` tier resolves to Haiku with no effort. When an env override supplies the model, keep the effort the tier/default would have given — except for `picker`, which never has one.

- [ ] **Step 4: Run test to verify it passes** → PASS

- [ ] **Step 5: Commit**

```bash
git add netlify/edge-functions/_lib/llm-choice.ts netlify/edge-functions/_lib/llm-choice.test.ts
git commit -m "feat(edge): kvalitetsnivåer + modell/effort-defaults per kallsted (effort aldri på Haiku)"
```

---

### Task 3: Copy askstat's provider layer, port the auth diff

**Files:**
- Create (byte-copies from `../askstat/netlify/edge-functions/_lib/providers/`): `config.ts`, `config.test.ts`, `agentic.ts`, `agentic.test.ts`, `openai-compat.ts`, `openai-compat.test.ts`, `openai-responses.ts`, `openai-responses.test.ts`
- Modify: `netlify/edge-functions/_lib/auth.ts`

**Interfaces:**
- Produces: `parseProviderConfig(raw, request): ProviderConfig | {error: Response} | null`, `scrubKey(text, key)`, `ProviderConfig {type, baseUrl, model, key, webSearch}`, `extractLlmKey(request): string | null`, `GateOptions.allowLlmKey?: boolean`.

- [ ] **Step 1: Copy the four modules and their tests verbatim**

```bash
cp ../askstat/netlify/edge-functions/_lib/providers/*.ts netlify/edge-functions/_lib/providers/
```

Do not reformat. `config.ts` imports `isPublicHttpUrl` from `../ssrf.ts` and `extractLlmKey` from `../auth.ts` — both resolve once Step 2 lands.

- [ ] **Step 2: Port `extractLlmKey` + `allowLlmKey` into `auth.ts`**

Take the askstat diff: add `extractLlmKey` (printable ASCII `[\x21-\x7E]`, 8–250 chars), add `allowLlmKey` to `GateOptions`, and in both `runGate` and `runAdminGate` widen the token requirement to `byokKey === null && llmKey === null` and the early return to `if (byokKey !== null || llmKey !== null) return null`. Keep askstat's comment warning that `allowLlmKey` alone proves nothing.

Do **not** port `skipRateLimit` — it exists for askstat's continuation hops, which microdata has no equivalent of. YAGNI.

- [ ] **Step 3: Run the suite**

Run: `deno check *.ts _lib/*.ts _lib/providers/*.ts && deno test --allow-all _lib/`
Expected: PASS — the copied provider tests and the existing `auth.test.ts` both green.

- [ ] **Step 4: Add a test that `allowLlmKey` is off by default**

```ts
Deno.test("extractLlmKey rejects out-of-range and non-printable keys", () => {
  assertEquals(extractLlmKey(req({ "x-llm-key": "short" })), null);
  assertEquals(extractLlmKey(req({ "x-llm-key": "a".repeat(251) })), null);
  assertEquals(extractLlmKey(req({ "x-llm-key": "abcdefghå" })), null);
  assertEquals(extractLlmKey(req({ "x-llm-key": "sk-abcdefgh" })), "sk-abcdefgh");
});
```

(`req` is the existing header-request helper in `auth.test.ts`; reuse it.)

- [ ] **Step 5: Run tests** → PASS

- [ ] **Step 6: Commit**

```bash
git add netlify/edge-functions/_lib/providers netlify/edge-functions/_lib/auth.ts netlify/edge-functions/_lib/auth.test.ts
git commit -m "feat(edge): leverandørlaget kopiert ordrett fra askstat + extractLlmKey/allowLlmKey"
```

---

### Task 4: `resolveLlm` — one place for the bypass invariant

**Files:**
- Modify: `netlify/edge-functions/_lib/llm-choice.ts`
- Modify: `netlify/edge-functions/_lib/llm-choice.test.ts`

**Interfaces:**
- Consumes: `chooseModel` (Task 2), `parseProviderConfig` (Task 3), `extractByokKey`/`extractLlmKey` (Task 3).
- Produces:

```ts
export interface LlmChoice {
  apiKey: string;
  model: string;
  effort?: string;
  provider?: ProviderConfig;
}
export function resolveLlm(
  request: Request,
  body: { provider?: unknown; quality?: unknown },
  site: CallSite,
  env?: (k: string) => string | undefined,
): LlmChoice | Response;
```

Rules, in order: parse the provider (a parse error returns its `Response`); **if an `X-Llm-Key` is present with no BYOK key and no complete provider config, return 401** — never fall through to the server key; then `apiKey = provider?.key ?? byok ?? env("ANTHROPIC_API_KEY")`; a missing key returns 500; `model`/`effort` come from `chooseModel`, and on the provider path the caller must use `provider.model` instead of `choice.model`.

- [ ] **Step 1: Write the failing test**

```ts
Deno.test("llm-key without a provider config is 401, never the server key", async () => {
  const r = resolveLlm(
    reqWith({ "x-llm-key": "sk-abcdefgh" }),
    {},
    "kode-svar",
    (k) => (k === "ANTHROPIC_API_KEY" ? "server-key" : undefined),
  );
  assertEquals(r instanceof Response, true);
  assertEquals((r as Response).status, 401);
});

Deno.test("byok key wins over the server key", () => {
  const c = resolveLlm(reqWith({ "x-anthropic-key": "sk-ant-user" }), {}, "kode-svar",
    (k) => (k === "ANTHROPIC_API_KEY" ? "server-key" : undefined)) as LlmChoice;
  assertEquals(c.apiKey, "sk-ant-user");
  assertEquals(c.provider, undefined);
});

Deno.test("complete provider config authenticates and carries its own key", () => {
  const c = resolveLlm(
    reqWith({ "x-llm-key": "sk-abcdefgh" }),
    { provider: { type: "openai-compat", base_url: "https://api.mistral.ai/v1", model: "mistral-large-latest" } },
    "kode-svar", () => undefined,
  ) as LlmChoice;
  assertEquals(c.apiKey, "sk-abcdefgh");
  assertEquals(c.provider?.model, "mistral-large-latest");
});

Deno.test("no key anywhere is a 500, not a crash", () => {
  const r = resolveLlm(reqWith({}), {}, "kode-svar", () => undefined);
  assertEquals((r as Response).status, 500);
});

Deno.test("quality from the body reaches the choice", () => {
  const c = resolveLlm(reqWith({ "x-anthropic-key": "sk-ant-user" }), { quality: "best" },
    "kode-svar", () => undefined) as LlmChoice;
  assertEquals(c.model, "claude-opus-5");
  assertEquals(c.effort, "xhigh");
});

Deno.test("a junk quality value falls back to the per-call default", () => {
  const c = resolveLlm(reqWith({ "x-anthropic-key": "k" }), { quality: "turbo" },
    "tolk-resultat", () => undefined) as LlmChoice;
  assertEquals(c.model, "claude-sonnet-5");
  assertEquals(c.effort, "medium");
});
```

- [ ] **Step 2: Run test to verify it fails** → FAIL, `resolveLlm` not exported.

- [ ] **Step 3: Implement `resolveLlm`** per the rules above.

- [ ] **Step 4: Run tests** → PASS

- [ ] **Step 5: Commit**

```bash
git add netlify/edge-functions/_lib/llm-choice.ts netlify/edge-functions/_lib/llm-choice.test.ts
git commit -m "feat(edge): resolveLlm — bypass-invarianten håndheves ett sted, ikke fem"
```

---

### Task 5: `anthropic.ts` gains `apiBase` and `effort`

**Files:**
- Modify: `netlify/edge-functions/_lib/anthropic.ts`
- Modify: `netlify/edge-functions/_lib/anthropic.test.ts`

**Interfaces:**
- Produces: `AnthropicStreamOptions` gains `apiBase?: string` and `effort?: string`. When `effort` is set the request body gains `output_config: { effort }` — **nested, never top-level**. When `apiBase` is set, POST to `${apiBase}/messages` instead of the hardcoded endpoint.

- [ ] **Step 1: Write the failing test**

```ts
Deno.test("effort is nested under output_config", async () => {
  const seen = captureBody();
  await streamAnthropic({ apiKey: "k", model: "claude-sonnet-5", prompt: "p", effort: "high" }, seen.deps);
  assertEquals(seen.body.output_config, { effort: "high" });
  assertEquals(seen.body.effort, undefined);
});

Deno.test("no effort field when effort is unset", async () => {
  const seen = captureBody();
  await streamAnthropic({ apiKey: "k", model: "claude-haiku-4-5", prompt: "p" }, seen.deps);
  assertEquals("output_config" in seen.body, false);
});

Deno.test("apiBase redirects the POST", async () => {
  const seen = captureBody();
  await streamAnthropic({ apiKey: "k", model: "m", prompt: "p", apiBase: "https://gw.example/v1" }, seen.deps);
  assertEquals(seen.url, "https://gw.example/v1/messages");
});
```

`captureBody()` returns injectable `RetryDeps` with a `fetchImpl` recording url + parsed body and returning a minimal SSE response. `streamAnthropic` currently takes no `deps` — add an optional second parameter mirroring `messageAnthropic`'s.

- [ ] **Step 2: Run test to verify it fails** → FAIL.

- [ ] **Step 3: Implement** — add the two options and the optional `deps` parameter.

- [ ] **Step 4: Run the whole suite** → PASS, existing anthropic tests included.

- [ ] **Step 5: Commit**

```bash
git add netlify/edge-functions/_lib/anthropic.ts netlify/edge-functions/_lib/anthropic.test.ts
git commit -m "feat(edge): streamAnthropic tar apiBase + effort (output_config, aldri toppnivå)"
```

---

### Task 6: The single-shot provider layer

**Files:**
- Create: `netlify/edge-functions/_lib/providers/single.ts`
- Create: `netlify/edge-functions/_lib/providers/single.test.ts`

**Interfaces:**
- Consumes: `ProviderConfig`, `scrubKey` (Task 3); `parseSseFrames`/`flushSseBuffer` (Task 1); `fetchWithRetry`, `StreamEvent`, `AnthropicMessageResult`, `streamAnthropic`, `messageAnthropic` (Tasks 1/5).
- Produces:

```ts
export function streamProvider(
  p: ProviderConfig, opts: AnthropicStreamOptions,
  choice: { effort?: string }, deps?: RetryDeps,
): Promise<ReadableStream<Uint8Array>>;

export function messageProvider(
  p: ProviderConfig, opts: AnthropicStreamOptions,
  choice: { effort?: string }, deps?: RetryDeps,
): Promise<AnthropicMessageResult>;
```

**The model always comes from `p.model`.** `choice.model` must never be read here — only `choice.effort`.

Mapping: `anthropic-compat` delegates to `streamAnthropic`/`messageAnthropic` with `apiBase: p.baseUrl`. `openai-compat` POSTs `{base}/chat/completions` with `{model, stream:true, stream_options:{include_usage:true}, messages:[{role:"system"},{role:"user"}], reasoning_effort?}` and reads `choices[0].delta.content`. `openai-responses` POSTs `{base}/responses` with `{model, stream:true, instructions, input, reasoning?:{effort}}` and reads `response.output_text.delta`.

- [ ] **Step 1: Write the failing test**

```ts
Deno.test("openai-compat emits the app's own SSE contract", async () => {
  const upstream = sse([
    '{"choices":[{"delta":{"content":"Hei"}}]}',
    '{"choices":[{"delta":{"content":" du"}}]}',
    '{"usage":{"prompt_tokens":11,"completion_tokens":3}}',
    "[DONE]",
  ]);
  const events = await drain(await streamProvider(
    prov("openai-compat"), { apiKey: "k", model: "IGNORED", prompt: "p", system: "s" }, {},
    { fetchImpl: () => Promise.resolve(new Response(upstream)) },
  ));
  assertEquals(events[0], { type: "text", text: "Hei" });
  assertEquals(events[1], { type: "text", text: " du" });
  assertEquals(events[2].type, "done");
  assertEquals(events[2].inputTokens, 11);
  assertEquals(events[2].outputTokens, 3);
  assertEquals(events[2].cacheReadTokens, 0);
});

Deno.test("streamProvider sends p.model and never choice.model", async () => {
  const seen = captureBody();
  await streamProvider(prov("openai-compat"), { apiKey: "k", model: "WRONG", prompt: "p" },
    { model: "ALSO-WRONG" } as never, seen.deps);
  assertEquals(seen.body.model, "mistral-large-latest");
});

Deno.test("openai-compat carries effort as reasoning_effort, and omits it when unset", async () => {
  const withEffort = captureBody();
  await streamProvider(prov("openai-compat"), base(), { effort: "high" }, withEffort.deps);
  assertEquals(withEffort.body.reasoning_effort, "high");
  const without = captureBody();
  await streamProvider(prov("openai-compat"), base(), {}, without.deps);
  assertEquals("reasoning_effort" in without.body, false);
});

Deno.test("openai-responses reads output_text.delta and nests effort under reasoning", async () => {
  const seen = captureBody();
  await streamProvider(prov("openai-responses"), base(), { effort: "xhigh" }, seen.deps);
  assertEquals(seen.body.reasoning, { effort: "xhigh" });
  assertEquals(seen.url, "https://api.openai.com/v1/responses");
});

Deno.test("anthropic-compat delegates with apiBase", async () => {
  const seen = captureBody();
  await streamProvider(prov("anthropic-compat"), base(), { effort: "high" }, seen.deps);
  assertEquals(seen.url, "https://gw.example/v1/messages");
  assertEquals(seen.body.output_config, { effort: "high" });
});

Deno.test("an upstream error never echoes the key", async () => {
  const deps = { fetchImpl: () => Promise.resolve(new Response("bad key sk-secret-123", { status: 401 })) };
  const err = await streamProvider(prov("openai-compat"), base(), {}, deps).catch((e) => String(e));
  assertEquals(String(err).includes("sk-secret-123"), false);
});

Deno.test("messageProvider returns joined text and usage", async () => {
  const deps = { fetchImpl: () => Promise.resolve(Response.json({
    choices: [{ message: { content: "svar" } }],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
  })) };
  const r = await messageProvider(prov("openai-compat"), base(), {}, deps);
  assertEquals(r.text, "svar");
  assertEquals(r.usage.inputTokens, 5);
});
```

Helpers: `prov(type)` builds a `ProviderConfig` (`openai-compat` → `https://api.mistral.ai/v1` + `mistral-large-latest`; `openai-responses` → `https://api.openai.com/v1`; `anthropic-compat` → `https://gw.example/v1`), `base()` returns `{apiKey:"k", model:"IGNORED", prompt:"p", system:"s"}`, `sse(lines)` builds a `ReadableStream` of `data: …\n\n` frames, `drain(stream)` collects parsed `StreamEvent`s.

- [ ] **Step 2: Run test to verify it fails** → FAIL, module not found.

- [ ] **Step 3: Implement `single.ts`.** Cache-token fields are always `0` for the two OpenAI shapes. Every thrown error runs through `scrubKey(text, p.key)` before it is logged or wrapped.

- [ ] **Step 4: Run tests** → PASS

- [ ] **Step 5: Commit**

```bash
git add netlify/edge-functions/_lib/providers/single.ts netlify/edge-functions/_lib/providers/single.test.ts
git commit -m "feat(edge): single-shot leverandørlag — ekte SSE-strømming for openai-compat/responses"
```

---

### Task 7: Wire the five endpoints

Each of the four single-shot endpoints currently has the identical four lines:

```ts
const byokKey = extractByokKey(request);
const apiKey = byokKey ?? Deno.env.get("ANTHROPIC_API_KEY");
const model = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-4-6";
if (!apiKey) { console.error("ANTHROPIC_API_KEY is not set"); return new Response("Server configuration error", { status: 500 }); }
```

which all become:

```ts
const choice = resolveLlm(request, body, "<site>");
if (choice instanceof Response) return choice;
```

and the call site becomes:

```ts
const stream = choice.provider
  ? await streamProvider(choice.provider, { apiKey: choice.apiKey, model: choice.model, prompt, maxTokens: N, system: S, cacheTtl: "1h" }, choice)
  : await streamAnthropic({ apiKey: choice.apiKey, model: choice.model, prompt, maxTokens: N, system: S, cacheTtl: "1h", effort: choice.effort });
```

**Files:**
- Modify: `netlify/edge-functions/tolk-resultat.ts:77,90-96,116` — site `"tolk-resultat"`, add `allowLlmKey: true` to the gate
- Modify: `netlify/edge-functions/kode-svar.ts:1250,1266` — site `"kode-svar"`
- Modify: `netlify/edge-functions/dm-vurder.ts:359,377` — site `"dm-vurder"`
- Modify: `netlify/edge-functions/kode-svar-v2.ts:102,116-117` — sites `"kode-svar-v2"` **and** `"picker"` (two `chooseModel` calls: the picker pass keeps its own model and never gets effort)
- Modify: `netlify/edge-functions/data-svar.ts:39,71` — site `"data-svar"`; dispatch on `provider.type` into `runProviderAgenticStream` with `makeOpenAiCompatTurn`/`makeOpenAiResponsesTurn`, else `runAgenticStream` with `apiBase` for `anthropic-compat` (copy askstat's `svar.ts:334-352` shape)
- Modify: each endpoint's `RequestBody` interface to add `provider?: unknown; quality?: unknown`

- [ ] **Step 1: Add `allowLlmKey: true` to all five gate calls.**

Safe only because Step 2 gives every handler the `resolveLlm` bypass check. Do both in one commit — never leave a handler with `allowLlmKey` and no check.

- [ ] **Step 2: Replace the key/model block and the call site in each endpoint.**

- [ ] **Step 3: Type-check and run the suite**

Run: `deno check *.ts _lib/*.ts _lib/providers/*.ts && deno test --allow-all _lib/` → PASS

- [ ] **Step 4: Smoke each endpoint locally against Anthropic (no provider set)**

Run `netlify dev`, then exercise Send⚗︎, Vurder personvern, and Tolk resultat. Expected: unchanged behaviour, now on `claude-sonnet-5`. This is the gate that the refactor didn't break the default path.

- [ ] **Step 5: Commit**

```bash
git add netlify/edge-functions/*.ts
git commit -m "feat(edge): alle fem endepunkter går via resolveLlm + leverandør-dispatch"
```

---

### Task 8: Client — provider config, quality, headers, hidden access token

**Files:**
- Modify: `js/ai-chat.js` (the `state` getters near line 18; `authHeaders()` at line 395; the settings load/save around lines 1328–1370)

**Interfaces:**
- Produces on `window`: `mdAiHasKey()`, `mdAiAuthHeaders()`, `mdAiProviderConfig()`, `mdAiQuality()`.
- localStorage keys: `md_llm_provider` (JSON `{type, base_url, model}`), `md_llm_key`, `md_ai_quality` (`"fast"|"balanced"|"best"`, default `"balanced"`), `md_access_token` (hidden, no UI).

- [ ] **Step 1: Add the four getters plus `customProviderReady()`**

`customProviderReady()` is `!!(providerConfig() && llmKey())`. Unlike askstat's, it reads `md_llm_key` directly — **do not** introduce `window.Keys`.

- [ ] **Step 2: Rewrite `authHeaders()` with the documented precedence**

```js
function providerAuthHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (customProviderReady()) { h['X-Llm-Key'] = llmKey(); return h; }
  if (state.anthropicKey) { h['X-Anthropic-Key'] = state.anthropicKey; return h; }
  const tok = accessToken();
  if (tok) { h['Authorization'] = 'Bearer ' + tok; return h; }
  return h;
}
```

- [ ] **Step 3: Widen every key gate**

Replace each `if (!state.anthropicKey)` / `hasByok` test (lines 27, 416, 872, 1181, 1449) with `mdAiHasKey()`, so a custom provider *or* a set access token unlocks the AI buttons. Line 872's "Web-modus krever egen Anthropic-nøkkel" message must be retitled — it is no longer Anthropic-specific.

- [ ] **Step 4: Send `provider` and `quality` in every request body**

All five fetch call sites gain `provider: mdAiProviderConfig() || undefined, quality: mdAiQuality()`.

- [ ] **Step 5: Verify the stream reader is untouched**

Run: `git diff js/ai-chat.js | grep -c "type === 'text'\|type === 'done'"` → expect `0`. The SSE contract did not change; if this reader changed, something is wrong.

- [ ] **Step 6: Commit**

```bash
git add js/ai-chat.js
git commit -m "feat(ai): leverandørkonfig, kvalitetsvalg og skjult md_access_token i klienten"
```

---

### Task 9: Settings UI and the preset table

**Files:**
- Modify: `index.html:290-310` (the AI settings modal)
- Modify: `js/ai-chat.js` (settings load/save wiring)

**Interfaces:**
- Consumes: the localStorage keys from Task 8.
- New element ids: `aiCfgProviderType`, `aiCfgProviderFields`, `aiCfgProviderUrl`, `aiCfgProviderModel`, `aiCfgLlmKey`, `aiCfgQuality`.

- [ ] **Step 1: Add the preset table to `js/ai-chat.js`**

```js
// Presets are convenience only — the three TYPES are the contract, and an
// unlisted vendor stays reachable via "Other" + a typed base URL.
var PROVIDER_PRESETS = [
  { id: 'anthropic',  label: 'Anthropic',            type: null },
  { id: 'openai',     label: 'OpenAI',               type: 'openai-responses', url: 'https://api.openai.com/v1' },
  { id: 'mistral',    label: 'Mistral',              type: 'openai-compat',    url: 'https://api.mistral.ai/v1' },
  { id: 'groq',       label: 'Groq',                 type: 'openai-compat',    url: 'https://api.groq.com/openai/v1' },
  { id: 'deepseek',   label: 'DeepSeek',             type: 'openai-compat',    url: 'https://api.deepseek.com/v1' },
  { id: 'openrouter', label: 'OpenRouter',           type: 'openai-compat',    url: 'https://openrouter.ai/api/v1' },
  { id: 'other',      label: 'Annen (OpenAI-kompatibel)', type: 'openai-compat', url: '' }
];
```

- [ ] **Step 2: Add the markup** — a provider `<select>` above the existing key field, a `<div id="aiCfgProviderFields" hidden>` with base-URL/model/key inputs, and a quality `<select>` (Rask / Balansert / Best, default Balansert). Follow the existing `ai-modal` class conventions and `data-i18n` attributes.

- [ ] **Step 3: Wire load/save** — selecting a preset fills type + base URL and reveals the three fields; selecting Anthropic hides them and reveals the existing key field. Save writes `md_llm_provider`/`md_llm_key`/`md_ai_quality`; choosing Anthropic removes `md_llm_provider`.

- [ ] **Step 4: Add the two honest cost notes** to the modal's help text: prompt caching is Anthropic-only so a custom provider pays full input rates on `kode-svar`'s catalog prefix; and the v2 picker pass reuses the generation model.

- [ ] **Step 5: Manual verification** — with `netlify dev` running, configure Mistral, send one question, confirm text streams token-by-token (not one lump). Then switch to Anthropic + Best and confirm the model changes.

- [ ] **Step 6: Commit**

```bash
git add index.html js/ai-chat.js
git commit -m "feat(ai): leverandørvelger m/presets + kvalitetsvelger i innstillinger"
```

---

### Task 10: Documentation and the privacy statement

**Files:**
- Modify: `personvern.html`, `hjelp.html`, `hjelp.en.html`, `README.md`, `.env.example`

- [ ] **Step 1: Rewrite the seven Anthropic mentions in `personvern.html`**

They currently name Anthropic as *the* recipient ("videresendes til Anthropic for den ene forespørselen", "Anthropic (AI-tjeneste, USA)"). Replace with: requests go to **the provider the user has configured**; with no custom provider that is Anthropic; the edge stores neither key nor content; a custom provider means the prompt and the key go to a URL the user chose, under that vendor's terms. Keep the existing structure and tone.

- [ ] **Step 2: Mirror the correction in `hjelp.html` and `hjelp.en.html`.**

- [ ] **Step 3: Update `README.md`** — the AI paragraph ("work only via a user-supplied Anthropic API key") becomes provider-agnostic; the edge-functions table row lists `X-Llm-Key` alongside `X-Anthropic-Key`; document `md_access_token` beside the existing `md_ai_autorun` power-user note.

- [ ] **Step 4: Update `.env.example`** — note that `ANTHROPIC_MODEL`/`PICKER_MODEL`/`DATA_SVAR_MODEL` are overrides that beat the user's quality selection, and that the defaults are now `claude-sonnet-5` / `claude-haiku-4-5`.

- [ ] **Step 5: Read `personvern.html` end-to-end once more** and confirm no sentence still asserts Anthropic is the only recipient. This is a compliance check, not a spellcheck.

- [ ] **Step 6: Commit**

```bash
git add personvern.html hjelp.html hjelp.en.html README.md .env.example
git commit -m "docs: personvernerklæringen navngir ikke lenger Anthropic som eneste mottaker"
```

---

## Self-Review

**Spec coverage:** §1 protocol types → Tasks 3, 6, 9 (presets). §2 files → all tasks. §3 single-shot layer → Task 6, sse-frames → Task 1. §4 quality/defaults → Tasks 2, 5 (effort plumbing), 9 (UI). §5 auth invariant → Tasks 3, 4, 7. §6 client → Tasks 8, 9. §7 privacy → Task 10. Error handling → Tasks 4, 6. Testing → each task's own steps. Deferred local models → no task, correctly.

**Type consistency:** `chooseModel(site, quality, env)` (T2) is consumed by `resolveLlm` (T4) and returns `{model, effort?}`, matching `LlmChoice`. `streamProvider(p, opts, choice, deps?)` (T6) is called with `choice` from `resolveLlm` (T7). `CallSite` literals — `kode-svar`, `kode-svar-v2`, `picker`, `dm-vurder`, `tolk-resultat`, `data-svar` — are identical in T2's tests and T7's wiring.

**Known ordering constraint:** Task 3 Step 1 copies `config.ts`, which imports `extractLlmKey` from `auth.ts`; the module does not type-check until Step 2 lands. Both are in the same task and the same commit, so no commit is left broken.
