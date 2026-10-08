import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fetchGuarded, guardedFetchImpl, ipv4Tall, isPublicHttpUrl } from "./ssrf.ts";

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

// ── Normalisering + reserverte områder (sikkerhetsrunde 2026-10-08) ────────
// new URL() kanoniserer allerede desimal/heks/oktal IPv4 til prikket desimal
// (målt i både Deno og Node: http://2130706433/ → 127.0.0.1), men den lar en
// avsluttende punktum stå: «localhost.» og «metadata.google.internal.» slapp
// derfor forbi suffiks-sjekkene. Testene under låser begge deler.
Deno.test("isPublicHttpUrl: trailing dot, *.localhost and .internal. are rejected", () => {
  const bad = [
    "http://localhost./x", "http://LOCALHOST./x", "http://localhost../x",
    "http://a.localhost/x", "http://a.b.localhost./x",
    "http://metadata.google.internal./computeMetadata/v1/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://printer.local./x", "http://127.0.0.1./x",
  ];
  for (const u of bad) assertEquals(isPublicHttpUrl(u), false, u);
});

Deno.test("isPublicHttpUrl: reserved IPv4 ranges are rejected", () => {
  const bad = [
    "http://100.64.0.1/", "http://100.127.255.254/",          // CGNAT 100.64/10
    "http://0.1.2.3/", "http://127.8.9.10/", "http://169.254.1.1/",
    "http://192.0.0.8/",                                         // 192.0.0/24
    "http://198.18.0.1/", "http://198.19.255.255/",              // 198.18/15
    "http://224.0.0.1/", "http://239.255.255.250/",              // 224/4
    "http://240.0.0.1/", "http://255.255.255.255/",              // 240/4 + broadcast
  ];
  for (const u of bad) assertEquals(isPublicHttpUrl(u), false, u);
  // Grensene rett utenfor områdene er offentlige.
  const good = ["http://100.63.255.255/", "http://100.128.0.1/", "http://198.17.0.1/",
    "http://198.20.0.1/", "http://192.0.1.1/", "http://223.255.255.255/", "https://8.8.8.8/"];
  for (const u of good) assertEquals(isPublicHttpUrl(u), true, u);
});

Deno.test("isPublicHttpUrl: decimal, hex and octal IPv4 forms are rejected", () => {
  const bad = [
    "http://2130706433/", "http://0x7f.1/", "http://017700000001/",
    "http://0x7f000001/", "http://127.1/", "http://0300.0250.0.1/",
    "http://0x7f.0.0.1./", "http://0xa9.0xfe.0xa9.0xfe/",
  ];
  for (const u of bad) assertEquals(isPublicHttpUrl(u), false, u);
});

Deno.test("isPublicHttpUrl: IPv6 literals incl. IPv4-mapped stay rejected", () => {
  for (const u of ["http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/", "http://[2001:4860::8888]/"]) {
    assertEquals(isPublicHttpUrl(u), false, u);
  }
});

Deno.test("isPublicHttpUrl: public hostnames with a trailing dot are still allowed", () => {
  assertEquals(isPublicHttpUrl("https://data.ssb.no./api/"), true);
});

// ipv4Tall er hjelperen bak de numeriske formene. new URL() kanoniserer dem
// i dag, men hjelperen skal stå på egne bein — den er forsvaret om en
// fremtidig runtime eller kaller sender inn en rå vertsstreng.
Deno.test("ipv4Tall parses decimal, hex, octal and short IPv4 forms", () => {
  assertEquals(ipv4Tall("127.0.0.1"), 0x7f000001);
  assertEquals(ipv4Tall("2130706433"), 0x7f000001);
  assertEquals(ipv4Tall("0x7f.1"), 0x7f000001);
  assertEquals(ipv4Tall("017700000001"), 0x7f000001);
  assertEquals(ipv4Tall("0300.0250.0.1"), 0xc0a80001);
  assertEquals(ipv4Tall("10.1"), 0x0a000001);
  assertEquals(ipv4Tall("data.ssb.no"), null);
  assertEquals(ipv4Tall("1.2.3.4.5"), null);
  assertEquals(ipv4Tall("256.1.1.1"), null);
  assertEquals(ipv4Tall("09.1.1.1"), null);
});
