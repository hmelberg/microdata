import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { checkRateLimit, rateLimitBucket } from "./rate-limit.ts";

// Mirrors MAX_CALLS in rate-limit.ts. Kept as one constant so raising the
// budget does not mean rewriting assertions.
const LIMIT = 60;

// In-memory fake of the Netlify Blobs store.
function fakeStore() {
  const data = new Map<string, unknown>();
  return {
    get: (key: string) => Promise.resolve(data.get(key) ?? null),
    setJSON: (key: string, value: unknown) => {
      data.set(key, value);
      return Promise.resolve();
    },
  };
}

function throwingStore() {
  return {
    get: () => Promise.reject(new Error("blobs down")),
    setJSON: () => Promise.reject(new Error("blobs down")),
  };
}

Deno.test("checkRateLimit: empty ip is always allowed", async () => {
  const r = await checkRateLimit("ep", "", () => fakeStore());
  assertEquals(r.allowed, true);
});

Deno.test("checkRateLimit: allows up to the limit, then denies", async () => {
  const store = fakeStore();
  const getStoreImpl = () => store;
  let lastAllowed = true;
  for (let i = 0; i < LIMIT; i++) {
    const r = await checkRateLimit("ep", "1.2.3.4", getStoreImpl);
    lastAllowed = r.allowed;
  }
  assertEquals(lastAllowed, true); // the whole budget is within limit
  const denied = await checkRateLimit("ep", "1.2.3.4", getStoreImpl); // one over
  assertEquals(denied.allowed, false);
  assertEquals(denied.retryAfterSeconds > 0, true);
});

Deno.test("checkRateLimit: fails OPEN when the store throws (no 500 storm)", async () => {
  const r = await checkRateLimit("ep", "1.2.3.4", () => throwingStore());
  assertEquals(r.allowed, true);
});

Deno.test("checkRateLimit: separate IPs have separate budgets", async () => {
  const store = fakeStore();
  const getStoreImpl = () => store;
  for (let i = 0; i < LIMIT; i++) await checkRateLimit("ep", "a", getStoreImpl);
  const otherIp = await checkRateLimit("ep", "b", getStoreImpl);
  assertEquals(otherIp.allowed, true);
});

Deno.test("rateLimitBucket: IPv4 uendret, IPv6 bøttes på /64", () => {
  assertEquals(rateLimitBucket("1.2.3.4"), "1.2.3.4");
  assertEquals(rateLimitBucket("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
  assertEquals(rateLimitBucket("2001:db8:1:2::1"), "2001:db8:1:2::/64");
  assertEquals(rateLimitBucket("2001:0DB8:0001:0002:0:0:0:ffff"), "2001:db8:1:2::/64");
  // komprimert form der :: dekker deler av prefikset
  assertEquals(rateLimitBucket("2001:db8::1"), "2001:db8:0:0::/64");
  assertEquals(rateLimitBucket("::1"), "0:0:0:0::/64");
  assertEquals(rateLimitBucket("[2001:db8::1]"), "2001:db8:0:0::/64");
  assertEquals(rateLimitBucket("fe80::1%eth0"), "fe80:0:0:0::/64");
  // IPv4-mapped -> IPv4
  assertEquals(rateLimitBucket("::ffff:1.2.3.4"), "1.2.3.4");
  assertEquals(rateLimitBucket("::FFFF:102:304"), "1.2.3.4");
  // ugyldig -> uendret
  assertEquals(rateLimitBucket("1:2:3::4::5"), "1:2:3::4::5");
  assertEquals(rateLimitBucket("zzzz::1"), "zzzz::1");
});

Deno.test("checkRateLimit: IPv6-adresser i samme /64 deler bøtte", async () => {
  const store = fakeStore();
  const getStoreImpl = () => store;
  for (let i = 0; i < LIMIT; i++) {
    await checkRateLimit("ep", `2001:db8:1:2::${(i + 1).toString(16)}`, getStoreImpl);
  }
  const rotated = await checkRateLimit("ep", "2001:db8:1:2:ffff:ffff:ffff:ffff", getStoreImpl);
  assertEquals(rotated.allowed, false);
  const otherPrefix = await checkRateLimit("ep", "2001:db8:1:3::1", getStoreImpl);
  assertEquals(otherPrefix.allowed, true);
});

Deno.test("checkRateLimit: IPv4-mapped IPv6 deler bøtte med IPv4", async () => {
  const store = fakeStore();
  const getStoreImpl = () => store;
  for (let i = 0; i < LIMIT; i++) await checkRateLimit("ep", "5.6.7.8", getStoreImpl);
  const mapped = await checkRateLimit("ep", "::ffff:5.6.7.8", getStoreImpl);
  assertEquals(mapped.allowed, false);
});
