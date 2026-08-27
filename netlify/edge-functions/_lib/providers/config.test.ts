import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseProviderConfig, scrubKey } from "./config.ts";

const req = (key?: string) =>
  new Request("https://a.test/x", { headers: key ? { "X-Llm-Key": key } : {} });
const KEY = "sk-proj-abc123XYZ";

Deno.test("parseProviderConfig: absent or type anthropic → null", () => {
  assertEquals(parseProviderConfig(undefined, req(KEY)), null);
  assertEquals(parseProviderConfig(null, req(KEY)), null);
  assertEquals(parseProviderConfig({ type: "anthropic" }, req(KEY)), null);
});

Deno.test("parseProviderConfig: valid openai-compat", () => {
  const cfg = parseProviderConfig(
    { type: "openai-compat", base_url: "https://api.openai.com/v1/", model: "gpt-5.6" },
    req(KEY),
  );
  if (!cfg || "error" in cfg) throw new Error("uventet avvisning");
  assertEquals(cfg.baseUrl, "https://api.openai.com/v1");   // trailing slash strippet
  assertEquals(cfg.webSearch, "none");
  assertEquals(cfg.key, KEY);
});

Deno.test("parseProviderConfig: openai-responses gets webSearch native", () => {
  const cfg = parseProviderConfig(
    { type: "openai-responses", base_url: "https://api.openai.com/v1", model: "gpt-5.6" },
    req(KEY),
  );
  if (!cfg || "error" in cfg) throw new Error("uventet avvisning");
  assertEquals(cfg.webSearch, "native");
});

Deno.test("parseProviderConfig: rejections are 400 with named field, no key echo", async () => {
  const cases: [unknown, Request][] = [
    [{ type: "gemini", base_url: "https://x.example", model: "m" }, req(KEY)],       // ukjent type
    [{ type: "openai-compat", base_url: "http://169.254.169.254/v1", model: "m" }, req(KEY)], // SSRF
    [{ type: "openai-compat", base_url: "https://x.example", model: "har mellomrom" }, req(KEY)], // modell
    [{ type: "openai-compat", base_url: "https://x.example", model: "m" }, req()],   // mangler nøkkel
  ];
  for (const [raw, r] of cases) {
    const out = parseProviderConfig(raw, r);
    if (!out || !("error" in out)) throw new Error("skulle vært avvist: " + JSON.stringify(raw));
    assertEquals(out.error.status, 400);
    const text = await out.error.clone().text();
    if (text.includes(KEY)) throw new Error("nøkkel i feilkropp");
  }
});

Deno.test("scrubKey replaces every occurrence", () => {
  assertEquals(scrubKey(`err ${KEY} og ${KEY}`, KEY), "err *** og ***");
  assertEquals(scrubKey("ren tekst", KEY), "ren tekst");
  assertEquals(scrubKey("x", ""), "x");
});
