// Shared request gate for the AI edge functions (kode-svar, dm-vurder,
// tolk-resultat). Consolidates what was copy-pasted auth / rate-limit /
// body-guard logic in each handler:
//   - the password comparisons are constant-time;
//   - rate-limit runs before auth, so brute force against the passwords is
//     throttled;
//   - the spoofable x-forwarded-for fallback for the client IP is dropped
//     (only the platform-set x-nf-client-connection-ip is trusted).
//
// 2026-08-28: Anvil-fallbacken (mdataapi.anvil.app/_/api/auth/me) er fjernet.
// Appen er et offentlig BYOK-bygg uten innlogging, og kjøring av generert
// kode skjer nå i emulatoren (run_code) — de eneste gyldige Bearer-tokens er
// de to konfigurerte passordene (M2PY_ACCESS_TOKEN og
// M2PY_ACCESS_TOKEN_PERSONAL). Feil token gir umiddelbar 401 i stedet for en
// 4-sekunders nettverksrundtur mot Anvil.
import { checkRateLimit as defaultCheckRateLimit } from "./rate-limit.ts";

/** Constant-time string comparison (no early return on first mismatch). */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Client IP for rate limiting. On Netlify, x-nf-client-connection-ip is set by
 * the platform and cannot be forged by the client; x-forwarded-for can, so we
 * do NOT fall back to it (that fallback let a client spoof its IP to dodge the
 * per-IP limit).
 */
export interface IpContext {
  ip?: string;
}

export function clientIp(request: Request, context?: IpContext): string {
  return (context?.ip ?? "") || (request.headers.get("x-nf-client-connection-ip") ?? "");
}

/**
 * BYOK: user-supplied Anthropic key from the X-Anthropic-Key header. Only a
 * well-formed key (sk-ant-…, sane charset, ≤250 chars) counts; anything else
 * is treated as absent so the normal token path (and its 401) applies.
 * The value must never be logged or cached.
 */
export function extractByokKey(request: Request): string | null {
  const raw = (request.headers.get("x-anthropic-key") ?? "").trim();
  if (raw.length === 0 || raw.length > 250) return null;
  return /^sk-ant-[A-Za-z0-9_-]+$/.test(raw) ? raw : null;
}

/**
 * Custom-provider key from the X-Llm-Key header (spec 2026-08-27-multi-
 * provider-byok §5). Format-agnostic (providers differ) but sane: printable
 * ASCII, 8–250 chars. Same BYOK trust position as extractByokKey: the user
 * brings their own credentials and billing. Never logged or cached.
 */
export function extractLlmKey(request: Request): string | null {
  const raw = (request.headers.get("x-llm-key") ?? "").trim();
  if (raw.length < 8 || raw.length > 250) return null;
  return /^[\x21-\x7E]+$/.test(raw) ? raw : null;
}

/**
 * Map an upstream Anthropic failure to a client response. With BYOK, a 401
 * from Anthropic means the user's own key is invalid — surface that directly
 * instead of a generic 502 (the anthropic.ts helpers throw
 * `Error("Anthropic API error <status>")`).
 */
export function upstreamErrorResponse(e: unknown, byokKey: string | null): Response {
  if (byokKey && String(e).includes("Anthropic API error 401")) {
    return new Response("Ugyldig Anthropic-nøkkel", { status: 401 });
  }
  return new Response(`Upstream error: ${e}`, { status: 502 });
}

export interface GateOptions {
  endpoint: string;
  maxBodyBytes: number;
  allowedMethods?: string[];
  /**
   * Accept a well-formed X-Anthropic-Key in place of token/admin auth — only
   * for endpoints that forward the key to Anthropic, which validates it.
   * Never set this on endpoints that don't consume the key (they would
   * become effectively anonymous).
   */
  allowByok?: boolean;
  /**
   * Accept a well-formed X-Llm-Key in place of token/admin auth — only for
   * endpoints that require AND consume a full custom-provider config. Unlike
   * allowByok, an X-Llm-Key alone proves NOTHING (it is provider-agnostic and
   * never validated by this gate) — the handler MUST additionally reject any
   * X-Llm-Key-authenticated request that lacks a complete parsed `provider`
   * body, or it would fall through to the server's own env-configured API key
   * as an anonymous bypass. In this repo that check lives in resolveLlm
   * (_lib/llm-choice.ts); never set this flag on a handler that skips it.
   */
  allowLlmKey?: boolean;
}

export interface GateDeps {
  sharedToken?: string;
  /**
   * Hans' private tilgangspassord (M2PY_ACCESS_TOKEN_PERSONAL). Autentiserer
   * på lik linje med sharedToken; resolveLlm bruker i tillegg matchen til å
   * velge ANTHROPIC_API_KEY_PERSONAL i stedet for den delte servernøkkelen.
   */
  personalToken?: string;
  checkRateLimit: (
    endpoint: string,
    ip: string,
  ) => Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}

interface BaseCheckResult {
  presentedToken: string;
  failure: Response | null;
}

/**
 * Steps 1-4 shared by runGate and runAdminGate: token presence, method check,
 * content-length cap, and rate limit (in that order, before auth). Returns the
 * extracted token plus a short-circuit Response when one of the checks fails,
 * or `failure: null` when the caller should proceed to its own auth step.
 */
async function runBaseChecks(
  request: Request,
  opts: GateOptions,
  checkRateLimit: GateDeps["checkRateLimit"],
  requireToken = true,
  context?: IpContext,
  rateLimitExempt?: (token: string) => boolean,
): Promise<BaseCheckResult> {
  // 1. token presence (free) — skipped for BYOK requests, which carry the
  // user's own Anthropic key instead of an account token.
  const authHeader = request.headers.get("authorization") ?? "";
  const presentedToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : "";
  if (!presentedToken && requireToken) {
    return {
      presentedToken,
      failure: new Response("Unauthorized: missing token", { status: 401 }),
    };
  }

  // 2. method (free)
  const allowed = opts.allowedMethods ?? ["POST"];
  if (!allowed.includes(request.method)) {
    return {
      presentedToken,
      failure: new Response("Method not allowed", { status: 405 }),
    };
  }

  // 3. content-length guard (free)
  const contentLength = parseInt(
    request.headers.get("content-length") ?? "0",
    10,
  );
  if (contentLength > opts.maxBodyBytes) {
    return {
      presentedToken,
      failure: new Response("Payload too large", { status: 413 }),
    };
  }

  // 4. rate-limit BEFORE auth. Det PERSONLIGE passordet er helt unntatt:
  // matchen er gratis (konstant-tid, ingen nettverk), og eieren skal ikke
  // stoppes av sin egen 60/t-kvote. Feilgjetninger matcher ikke og
  // rate-limites som før, så brute force mot passordene er fortsatt bremset.
  const exempt = !!rateLimitExempt && presentedToken.length > 0 &&
    rateLimitExempt(presentedToken);
  if (!exempt) {
    const rate = await checkRateLimit(opts.endpoint, clientIp(request, context));
    if (!rate.allowed) {
      return {
        presentedToken,
        failure: new Response("Rate limited", {
          status: 429,
          headers: { "Retry-After": String(rate.retryAfterSeconds) },
        }),
      };
    }
  }

  return { presentedToken, failure: null };
}

/** True when the token matches the shared or the personal password. */
function matchesConfiguredToken(
  token: string,
  deps: { sharedToken?: string; personalToken?: string },
): boolean {
  return (!!deps.sharedToken && timingSafeEqual(token, deps.sharedToken)) ||
    (!!deps.personalToken && timingSafeEqual(token, deps.personalToken));
}

/**
 * Core gate logic with injected dependencies (testable). Returns a Response to
 * short-circuit the request, or null when the caller should proceed.
 */
export async function runGate(
  request: Request,
  opts: GateOptions,
  deps: GateDeps,
  context?: IpContext,
): Promise<Response | null> {
  const byokKey = opts.allowByok ? extractByokKey(request) : null;
  const llmKey = opts.allowLlmKey ? extractLlmKey(request) : null;
  const { presentedToken, failure } = await runBaseChecks(
    request,
    opts,
    deps.checkRateLimit,
    /* requireToken */ byokKey === null && llmKey === null, context,
    (t) => !!deps.personalToken && timingSafeEqual(t, deps.personalToken),
  );
  if (failure) return failure;

  // BYOK: the user's own Anthropic key replaces account auth. Method, body
  // and rate-limit checks above still ran; the handler uses the key upstream.
  // Deliberate server-side precedence: when both a valid BYOK header and a
  // Bearer token are present, BYOK wins and the token is never validated.
  if (byokKey !== null || llmKey !== null) return null;

  // 5. auth: kun de konfigurerte passordene (konstant-tid). Alt annet gir
  // umiddelbar 401 — ingen ekstern validering.
  if (!matchesConfiguredToken(presentedToken, deps)) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

/** Env-wired gate used by the handlers. */
export function gate(request: Request, opts: GateOptions, context?: IpContext): Promise<Response | null> {
  return runGate(request, opts, {
    sharedToken: Deno.env.get("M2PY_ACCESS_TOKEN") ?? undefined,
    personalToken: Deno.env.get("M2PY_ACCESS_TOKEN_PERSONAL") ?? undefined,
    checkRateLimit: defaultCheckRateLimit,
  }, context);
}

export interface AdminGateDeps {
  sharedToken?: string;
  /** Se GateDeps.personalToken — samme rolle, teller også som admin. */
  personalToken?: string;
  checkRateLimit: GateDeps["checkRateLimit"];
}

/**
 * Gate + admin requirement (data-svar, hent). Begge de konfigurerte
 * passordene teller som admin; alt annet gir 401. (Uten kontoer finnes det
 * ingen «innlogget, men ikke admin»-tilstand, så 403-veien er borte.)
 */
export async function runAdminGate(
  request: Request,
  opts: GateOptions,
  deps: AdminGateDeps,
  context?: IpContext,
): Promise<Response | null> {
  const byokKey = opts.allowByok ? extractByokKey(request) : null;
  const llmKey = opts.allowLlmKey ? extractLlmKey(request) : null;
  const { presentedToken, failure } = await runBaseChecks(
    request,
    opts,
    deps.checkRateLimit,
    /* requireToken */ byokKey === null && llmKey === null, context,
    (t) => !!deps.personalToken && timingSafeEqual(t, deps.personalToken),
  );
  if (failure) return failure;

  // BYOK: the user's own Anthropic key replaces account auth. Method, body
  // and rate-limit checks above still ran; the handler uses the key upstream.
  if (byokKey !== null || llmKey !== null) return null;

  if (!matchesConfiguredToken(presentedToken, deps)) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

/** Env-wired admin gate used by data-svar and hent. */
export function adminGate(request: Request, opts: GateOptions, context?: IpContext): Promise<Response | null> {
  return runAdminGate(request, opts, {
    sharedToken: Deno.env.get("M2PY_ACCESS_TOKEN") ?? undefined,
    personalToken: Deno.env.get("M2PY_ACCESS_TOKEN_PERSONAL") ?? undefined,
    checkRateLimit: defaultCheckRateLimit,
  }, context);
}
