# Multi-provider BYOK for microdata — design

**Date:** 2026-08-27
**Status:** Approved (design discussion with Hans, 2026-08-27)
**Applies to:** `microdata/` only. Portions are copied verbatim from `askstat/`;
where they are, the file is marked COPIED and must not be re-styled — it keeps
`git cherry-pick` between the sibling repos working.

## Goal

Let a microdata user bring credentials for **any** major LLM provider — Anthropic,
OpenAI, Mistral, Groq, DeepSeek, OpenRouter and every other vendor speaking the
OpenAI chat-completions protocol — instead of being locked to Anthropic, and give
them a single, comprehensible control over answer quality.

microdata is the public, BYOK-only build: there is no login and no account. The
user's own key is the entire access story, so being able to choose *whose* key it
is matters more here than in the sibling repos.

## Non-goals

- **Local models** (Ollama, LM Studio, llama.cpp). Technically reachable, but they
  need a second execution path, not a provider entry — see "Deferred: local models".
- Accounts, login, key sync. microdata deliberately has none.
- `js/keys.js` (askstat's user-key store). It is entangled with injecting data-source
  keys into user scripts; microdata has no such need and should not grow one.
- Reworking the agentic loop. `data-svar` gains provider support but keeps its shape;
  replacing it with a `run_code` loop is a separate spec.

## Background: what exists today

Four of microdata's five AI endpoints are **single-shot** — one system prompt, one
user prompt, streamed back as SSE:

| Endpoint | Call shape |
|---|---|
| `kode-svar` | `streamAnthropic` |
| `kode-svar-v2` | `messageAnthropic` (picker pass) + `streamAnthropic` (generation) |
| `dm-vurder` | `streamAnthropic` |
| `tolk-resultat` | `streamAnthropic` |
| `data-svar` | `runAgenticStream` |

`auth.ts` already implements BYOK for Anthropic (`X-Anthropic-Key`) and a
timing-safe shared access token (`M2PY_ACCESS_TOKEN`) — but **nothing in the client
ever sends the token**, and `data-loader.js`'s `authToken` parameter has no caller.
The server half is built and unreachable.

Model selection is entirely server-side (`ANTHROPIC_MODEL`, `PICKER_MODEL`,
`DATA_SVAR_MODEL`). The user has no say. Effort is not implemented anywhere in any
of the four sibling repos; askstat's `depth` is a tool-call budget, not model effort.

## Design

### 1. Provider types are protocols, not vendors

Three types cover the entire cloud market. This is the key simplification: we are
not maintaining a vendor list.

| Type | Endpoint convention | Covers |
|---|---|---|
| `anthropic-compat` | `{base}/messages` | Anthropic, Anthropic-compatible gateways |
| `openai-compat` | `{base}/chat/completions` | Mistral, Groq, DeepSeek, Together, Fireworks, OpenRouter, xAI, Cerebras, vLLM, gateways |
| `openai-responses` | `{base}/responses` | OpenAI |

The `provider` field arrives in the JSON body; the key arrives in the `X-Llm-Key`
header, never in the body.

A **preset table** (static, client-side) fills type + base URL from a vendor name so
nobody has to know that Mistral is "openai-compat". The user still types their key
and model. Presets are a convenience layer only — the three types remain the
contract, and an unlisted vendor is reachable by picking a type and typing a URL.

### 2. Files

**Copied verbatim from askstat** (with their tests):

- `_lib/providers/config.ts` — `ProviderConfig`, `parseProviderConfig`, `scrubKey`
- `_lib/providers/agentic.ts`
- `_lib/providers/openai-compat.ts`
- `_lib/providers/openai-responses.ts`

`agentic.ts` and the two turn adapters serve `data-svar` now and are the foundation
the future `run_code` port lands on.

**New:**

- `_lib/providers/single.ts` (~150 lines) — the single-shot layer
- `_lib/sse-frames.ts` (~25 lines) — one SSE frame parser
- `_lib/llm-choice.ts` (~80 lines) — quality → model + effort, and `resolveLlm`

**Changed:** `_lib/auth.ts`, `_lib/anthropic.ts`, the five endpoints, `js/ai-chat.js`,
`index.html`, `.env.example`, `README.md`, `personvern.html`, `hjelp.html` /
`hjelp.en.html`.

### 3. The single-shot layer

Both Anthropic entry points take the same small option bag —
`{apiKey, model, prompt, maxTokens?, system?, cacheTtl?}`: one system string, one
user prompt, no tool blocks. So the provider side is a two-function mirror:

```ts
streamProvider(p: ProviderConfig, opts, choice): Promise<ReadableStream<Uint8Array>>
messageProvider(p: ProviderConfig, opts, choice, deps?): Promise<AnthropicMessageResult>
```

and every endpoint's change is one expression:

```ts
const { provider, ...choice } = resolveLlm(request, body);   // { apiKey, model, effort? }
const stream = provider
  ? await streamProvider(provider, opts, choice)
  : await streamAnthropic({ ...opts, ...choice });
```

`choice` carries `{apiKey, model, effort?}`. On the **Anthropic path** it supplies
both model and effort. On the **custom-provider path** the model always comes from
`p.model` (what the user typed) and `choice.model` is ignored — `choice` contributes
only the effort mapping there. `streamProvider` must not read `choice.model`.

Wire mapping:

| Type | Request | Text deltas | Usage |
|---|---|---|---|
| `anthropic-compat` | existing `streamAnthropic` + `apiBase` | — | — |
| `openai-compat` | `{base}/chat/completions`, `stream:true`, `stream_options:{include_usage:true}` | `choices[0].delta.content` | final usage chunk |
| `openai-responses` | `{base}/responses`, `stream:true` | `response.output_text.delta` | `response.completed` |

**The output contract does not change.** The layer emits exactly the SSE events
`js/ai-chat.js` already consumes:

```
data: {"type":"text","text":"…"}
data: {"type":"done","inputTokens":N,"outputTokens":N,"cacheReadTokens":N,"cacheCreationTokens":N}
data: {"type":"error","message":"…"}
```

Cache-token fields are `0` for non-Anthropic providers; the client only displays
them. **No change to the client's stream reader is required.**

Two consequences, to be stated in the settings help text rather than discovered:

- Prompt caching is Anthropic-only. `kode-svar`'s large cached catalog prefix is
  billed at **full input rates on every call** with a custom provider.
- `kode-svar-v2`'s picker pass reuses the generation model, because a custom
  provider config carries exactly one model.

`_lib/sse-frames.ts` exists because `openai-compat` needs frame parsing anyway, and
`transformAnthropicStream` currently carries its main loop and its drain block as a
verbatim 35-line copy-paste of each other. Both call the shared parser. This is
in-scope cleanup of code the change already touches.

### 4. Quality: one selector, per-call resolution

The user picks one of three. `_lib/llm-choice.ts` resolves it per call site:

| Quality | Anthropic model | Effort |
|---|---|---|
| Fast | `claude-haiku-4-5` | omitted |
| **Balanced** (default) | `claude-sonnet-5` | `high` |
| Best | `claude-opus-5` | `xhigh` |

Per-call defaults when the user has expressed no preference:

| Call | Model | Effort |
|---|---|---|
| `kode-svar`, `kode-svar-v2` generation | `claude-sonnet-5` | `high` |
| `kode-svar-v2` picker pass | `claude-haiku-4-5` | **omitted** |
| `dm-vurder` | `claude-sonnet-5` | `high` |
| `tolk-resultat` | `claude-sonnet-5` | `medium` |
| `data-svar` | `claude-sonnet-5` | `high` |

Env vars (`ANTHROPIC_MODEL`, `PICKER_MODEL`, `DATA_SVAR_MODEL`) remain overrides so
retuning needs no deploy. Precedence: **env override > user quality selection >
per-call default.**

Four constraints this encodes, each of which is a 400 or a silent regression if
ignored:

1. **Effort errors on Haiku 4.5.** The picker pass therefore never sends `effort`,
   and the Fast tier never sends it either. This is enforced in `llm-choice.ts`, not
   left to each call site.
2. **`output_config.effort` is nested**, not a top-level request field, and needs no
   beta header.
3. **On Sonnet 5, omitting `thinking` still runs adaptive thinking**, and `display`
   defaults to `"omitted"`. Moving the default model from `claude-sonnet-4-6` to
   `claude-sonnet-5` therefore turns thinking on silently, which in a streaming chat
   reads as a pause before any text. microdata's existing `appendThinking()` spinner
   covers this; it is accepted, not accidental.
4. **Model IDs carry no date suffix.** Today's `PICKER_MODEL` default
   `claude-haiku-4-5-20251001` becomes `claude-haiku-4-5`, and
   `claude-sonnet-4-6` becomes `claude-sonnet-5`.

For custom providers the model is whatever the user typed; quality maps to
`reasoning_effort` where the vendor supports it and is dropped where it does not.
Dropping is silent by design — a knob that errors on half the market is worse than
one that quietly does nothing on some of it.

### 5. Auth and the bypass invariant

Port `extractLlmKey` (printable ASCII, 8–250 chars) and the `allowLlmKey` gate flag
from askstat.

> An `X-Llm-Key` alone proves nothing — it is provider-agnostic and is never
> validated by the gate. A handler that accepts one **must** reject any request
> lacking a complete parsed `provider` body, or it falls through to the server's own
> `ANTHROPIC_API_KEY` as an anonymous bypass.

askstat documents this and enforces it in one handler. microdata has five, so the
check lives in a single shared helper rather than five copies:

```ts
resolveLlm(request, body): { apiKey, model, effort?, provider? } | Response
```

One place to get right, one place to test. This is a deliberate improvement over
askstat's shape, not a divergence for its own sake.

Server-side precedence is unchanged from askstat: a valid BYOK or llm-key header
wins over a Bearer token, and the token is then never validated.

### 6. Client

- `md_llm_provider` — JSON `{type, base_url, model}` in localStorage
- `md_llm_key` — plain localStorage, same as the existing Anthropic key. No `keys.js`.
- `md_ai_quality` — `"fast" | "balanced" | "best"`, default `balanced`
- `md_access_token` — **the hidden access-password path.** No UI field. Documented in
  the README beside the existing `md_ai_autorun` opt-out. `hasKey()` counts it, so
  setting it unlocks the AI buttons. This finally gives `data-loader.js`'s dead
  `authToken` parameter a real source.

`providerAuthHeaders()` precedence: custom provider → `X-Llm-Key`; else Anthropic key
→ `X-Anthropic-Key`; else `md_access_token` → `Authorization: Bearer`.

Settings modal: a provider `<select>` (preset vendors + "Other"), which toggles
between the existing single key field and three fields (base URL, model, key), plus
the Quality selector.

### 7. Privacy statement

`personvern.html` currently names Anthropic as *the* recipient in seven places
("relayed to Anthropic for that one request", "Anthropic (AI service, USA)"). That
statement becomes **false** the moment a custom provider is configured — the edge
relays the prompt and the key to a URL the user chose.

It must be rewritten to say: requests go to the provider the user has configured;
with no custom provider that is Anthropic; the edge stores neither key nor content.
The same correction goes into `hjelp.html` / `hjelp.en.html`. This is a compliance
edit, not a cosmetic one, and it ships in the same change — not as a follow-up.

## Error handling

- Upstream failures surface through the existing `upstreamErrorResponse` path; a 401
  from the provider means the user's own key is bad and is reported as such rather
  than as a generic 502.
- `scrubKey` runs over any upstream error text before it can reach a log. Covered by
  a test that asserts the key never appears.
- A malformed or SSRF-blocked `base_url` is a 400 with a readable message.
- An `X-Llm-Key` without a complete provider config is a 401 — never a fall-through
  to the server key.

## Testing

- `providers/single.test.ts` — wire mapping and SSE framing per provider type with
  injected `fetch`; split-chunk and missing-trailing-`\n\n` cases.
- `llm-choice.test.ts` — the quality → (model, effort) table, **including that Fast
  and the picker pass never emit `effort`**, and that env overrides win.
- `resolveLlm` invariant table — BYOK × llm-key × provider-present, **including the
  bypass case** (llm-key, no provider → 401, never the server key).
- askstat's `providers/*.test.ts` come along with the copied files.
- `anthropic.test.ts` / `auth.test.ts` must stay green: the Anthropic path is
  behaviourally unchanged apart from the model/effort defaults.
- Manual smoke: one real call per provider type from the settings UI; one call per
  quality tier; a check that no upstream error echoes the key.

## Deferred: local models

Ollama, LM Studio and llama.cpp all speak `openai-compat`, so the *protocol* is
already handled. What blocks them is topology, and it is worth writing down so the
next spec does not rediscover it:

1. **The edge cannot reach the user's machine.** The flow is browser → Netlify edge
   (in the cloud) → provider. `http://localhost:11434` is on the user's laptop. And
   `ssrf.ts` deliberately rejects `localhost`, `.local`, `.internal` and the RFC1918
   ranges — that guard is exactly what stops a user-supplied base URL from becoming
   an SSRF pivot. **It must not be relaxed.** Local models need browser → localhost
   directly, with the edge out of the loop.
2. **Prompt assembly lives server-side** — but `buildCachedPrefix` reads only three
   public static files from the same origin (`/variable_metadata.json`,
   `/command_help.js`, `/functions.py`). No secrets, no server state. So a small
   `/api/prompt` endpoint can return the assembled system prompt for the browser to
   POST straight to localhost — avoiding a fourth copy of the assembly logic.
   Estimated ~30 edge lines plus ~250 client lines for the direct call and a
   JS-side OpenAI-compat SSE reader.
3. **Setup we cannot do for the user.** Ollama needs `OLLAMA_ORIGINS` to allow the
   site's origin or the browser blocks the call on CORS. Mixed content is *not* a
   problem — browsers treat `http://localhost` as a secure context, so an HTTPS page
   may call it.

Plus an honest expectation for the help text: an 8B local model facing a prompt that
carries the whole variable catalog and strict microdata syntax will do markedly
worse than Sonnet.

## Open questions

None blocking. Two things to watch once it is live:

- Whether the Sonnet 5 thinking pause on `kode-svar` is tolerable in practice, or
  whether that path should set `thinking: {type:"disabled"}` (accepted on Sonnet 5)
  for latency.
- Whether the preset list needs maintaining, or whether "pick a type, paste a URL"
  turns out to be enough.
