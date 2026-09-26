import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fetchGuarded, guardedFetchImpl, isPublicHttpUrl } from "./ssrf.ts";

Deno.test("isPublicHttpUrl blocks non-http, private and local hosts", () => {
  const bad = [
    "ftp://x.example/f", "file:///etc/passwd", "not a url",
    "http://localhost/x", "http://127.0.0.1/x", "http://10.0.0.5/x",
    "http://192.168.1.1/x", "http://172.16.9.9/x", "http://169.254.169.254/meta",
    "http://0.0.0.0/x", "http://[::1]/x", "http://foo.local/x", "http://db.internal/x",
  ];
  for (const u of bad) assertEquals(isPublicHttpUrl(u), false, u);
  const good = ["https://data.ssb.no/api/", "http://api.worldbank.org/v2/", "https://172.15.1.1/edge", "https://data.ssb.no/api/pxwebapi/v2-beta/tables/05839/data?valueCodes[Kjonn]=0&outputFormat=csv"];
  for (const u of good) assertEquals(isPublicHttpUrl(u), true, u);
});

function fakeFetch(routes: Record<string, () => Response>): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = String(input);
    const hit = Object.keys(routes).find((k) => url.startsWith(k));
    if (!hit) return Promise.resolve(new Response("not found", { status: 404 }));
    return Promise.resolve(routes[hit]());
  }) as typeof fetch;
}

Deno.test("fetchGuarded follows public redirects, blocks private hop", async () => {
  const f = fakeFetch({
    "https://a.example/ok": () => new Response("DATA", { status: 200 }),
    "https://a.example/hop": () =>
      new Response(null, { status: 302, headers: { location: "https://a.example/ok" } }),
    "https://a.example/evil": () =>
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/meta" } }),
  });
  const ok = await fetchGuarded("https://a.example/hop", { fetchImpl: f });
  assertEquals(ok.status, 200);
  assertEquals(new TextDecoder().decode(ok.body), "DATA");
  assertEquals(ok.finalUrl, "https://a.example/ok");
  let threw = "";
  try { await fetchGuarded("https://a.example/evil", { fetchImpl: f }); } catch (e) { threw = String(e); }
  if (!threw.includes("blokkert")) throw new Error("privat redirect skulle blokkeres: " + threw);
});

Deno.test("fetchGuarded caps body size and flags truncation", async () => {
  const big = new Uint8Array(1024).fill(65);
  const f = fakeFetch({ "https://a.example/big": () => new Response(big, { status: 200 }) });
  const r = await fetchGuarded("https://a.example/big", { fetchImpl: f, maxBytes: 100 });
  assertEquals(r.truncated, true);
  assertEquals(r.body.length, 100);
});

Deno.test("fetchGuarded rejects non-public start URL", async () => {
  let threw = "";
  try { await fetchGuarded("http://localhost/x"); } catch (e) { threw = String(e); }
  if (!threw.includes("blokkert")) throw new Error("skulle blokkeres");
});

Deno.test("fetchGuarded drops auth headers on cross-host redirects", async () => {
  const seenHeaders: Record<string, HeadersInit | undefined> = {};
  const f = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seenHeaders[url] = init?.headers;
    if (url === "https://a.example/hop2") {
      return Promise.resolve(new Response(null, { status: 302, headers: { location: "https://b.example/final" } }));
    }
    if (url === "https://b.example/final") {
      return Promise.resolve(new Response("OK", { status: 200 }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;

  const r = await fetchGuarded("https://a.example/hop2", { headers: { "X-Key": "S3CRET" }, fetchImpl: f });
  assertEquals(r.status, 200);

  const aHeaders = new Headers(seenHeaders["https://a.example/hop2"]);
  const bHeaders = new Headers(seenHeaders["https://b.example/final"]);
  assertEquals(aHeaders.get("X-Key"), "S3CRET");
  assertEquals(bHeaders.get("X-Key"), null);
});

Deno.test("guardedFetchImpl: gir vanlig Response, bevarer headers-record og POST-body", async () => {
  let seen: { method?: string; accept?: string; body?: string; redirect?: string } = {};
  const raw = ((_u: string | URL | Request, init?: RequestInit) => {
    const h = init?.headers as Record<string, string>;
    seen = { method: init?.method, accept: h?.Accept, body: String(init?.body), redirect: init?.redirect };
    return Promise.resolve(new Response('{"ok":1}', { status: 200 }));
  }) as typeof fetch;
  const f = guardedFetchImpl(raw);
  const res = await f("https://api.example/x", { method: "POST", headers: { Accept: "application/json" }, body: "{}" });
  assertEquals(res.ok, true);
  assertEquals(await res.json(), { ok: 1 });
  assertEquals(seen, { method: "POST", accept: "application/json", body: "{}", redirect: "manual" });
});

Deno.test("guardedFetchImpl: avkuttet svar over maxBytes kastes (ingen halv JSON)", async () => {
  const raw = (() => Promise.resolve(new Response("x".repeat(100), { status: 200 }))) as unknown as typeof fetch;
  await assertRejects(() => guardedFetchImpl(raw, { maxBytes: 10 })("https://api.example/big"), Error, "over 10 byte");
});

Deno.test("guardedFetchImpl: privat vert blokkeres, unntatt eksakt trustedOrigin", async () => {
  let calls = 0;
  const raw = (() => { calls++; return Promise.resolve(new Response("[]", { status: 200 })); }) as unknown as typeof fetch;
  await assertRejects(() => guardedFetchImpl(raw)("http://localhost:8888/data/x.json"), Error, "blokkert");
  assertEquals(calls, 0);
  const own = guardedFetchImpl(raw, { trustedOrigin: "http://localhost:8888" });
  assertEquals((await own("http://localhost:8888/data/x.json")).status, 200);
  await assertRejects(() => own("http://localhost:9999/x"), Error, "blokkert");
  // dobbel innpakning pakker ut til rå fetch og bruker de nye opsjonene
  const twice = guardedFetchImpl(guardedFetchImpl(raw), { trustedOrigin: "http://localhost:8888" });
  assertEquals((await twice("http://localhost:8888/data/x.json")).status, 200);
  assertEquals(calls, 2);
});
