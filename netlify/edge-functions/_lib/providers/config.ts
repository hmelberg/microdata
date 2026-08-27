// Custom-LLM provider config (spec 2026-07-23-llm-provider-tiers A1/A2).
// Parsed per request from the JSON body's `provider` field + the X-Llm-Key
// header. base_url is user-supplied and the edge will POST the prompt AND the
// key there — hence the SSRF guard and the everything-before-endpoint-name
// convention ({base}/messages | {base}/chat/completions | {base}/responses).
import { isPublicHttpUrl } from "../ssrf.ts";
import { extractLlmKey } from "../auth.ts";

export type ProviderType = "anthropic-compat" | "openai-compat" | "openai-responses";

export interface ProviderConfig {
  type: ProviderType;
  baseUrl: string;
  model: string;
  key: string;
  webSearch: "none" | "native";
}

const TYPES = new Set<string>(["anthropic-compat", "openai-compat", "openai-responses"]);
const MODEL_RE = /^[A-Za-z0-9._:/-]{1,100}$/;

export function parseProviderConfig(
  raw: unknown,
  request: Request,
): ProviderConfig | { error: Response } | null {
  if (raw === undefined || raw === null) return null;
  const p = raw as Record<string, unknown>;
  if (p.type === "anthropic" || p.type === undefined) return null;
  if (typeof p.type !== "string" || !TYPES.has(p.type)) {
    return { error: new Response("Ukjent leverandørtype", { status: 400 }) };
  }
  const baseUrl = typeof p.base_url === "string" ? p.base_url.trim().replace(/\/+$/, "") : "";
  if (!baseUrl || !isPublicHttpUrl(baseUrl)) {
    return { error: new Response("Ugyldig eller blokkert base-URL for leverandøren", { status: 400 }) };
  }
  const model = typeof p.model === "string" ? p.model.trim() : "";
  if (!MODEL_RE.test(model)) {
    return { error: new Response("Ugyldig modellnavn", { status: 400 }) };
  }
  const key = extractLlmKey(request);
  if (!key) {
    return { error: new Response("Mangler eller ugyldig X-Llm-Key", { status: 400 }) };
  }
  return {
    type: p.type as ProviderType,
    baseUrl,
    model,
    key,
    webSearch: p.type === "openai-compat" ? "none" : "native",
  };
}

/** Scrub a key out of upstream error text before it may be logged. */
export function scrubKey(text: string, key: string): string {
  return key ? text.split(key).join("***") : text;
}
