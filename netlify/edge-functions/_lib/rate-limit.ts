const WINDOW_MS = 60 * 60 * 1000;
// Generous on purpose: these are interactive endpoints, and 10/hour ran out
// mid-session. This is an abuse guard, not a quota.
const MAX_CALLS = 60;

interface RateRecord {
  calls: number[];
}

export interface RateStore {
  get(key: string, opts: { type: "json" }): Promise<unknown>;
  setJSON(key: string, value: unknown): Promise<unknown>;
}

// Utvider en IPv6-adresse (også komprimert, f.eks. 2001:db8::1, og med
// innebygd IPv4-hale) til 8 grupper à 16 bit. null hvis ugyldig.
function expandIpv6(addr: string): number[] | null {
  let a = addr;
  // IPv4-hale (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) -> to hex-grupper
  const v4 = a.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(2).map(Number);
    if (o.some((n) => n > 255)) return null;
    a = v4[1] + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }
  const parts = a.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (parts.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array(parts.length === 2 ? missing : 0).fill("0"), ...tail];
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

/**
 * Nøkkel for rate-limit-bøtta. IPv4 brukes som den er. IPv6 bøttes på /64-
 * prefikset: en klient får typisk et helt /64 og kan ellers rotere adresse
 * innenfor det og få en fersk bøtte per adresse. IPv4-mappede adresser
 * (::ffff:1.2.3.4) behandles som IPv4. Ukjent format -> strengen uendret.
 */
export function rateLimitBucket(ip: string): string {
  let a = ip.trim();
  if (a.startsWith("[") && a.endsWith("]")) a = a.slice(1, -1);
  if (!a.includes(":")) return a; // IPv4 (eller ukjent) — uendret
  a = a.replace(/%.*$/, ""); // sone-id (fe80::1%eth0)
  const g = expandIpv6(a);
  if (!g) return ip;
  // ::ffff:a.b.c.d (IPv4-mapped) -> IPv4
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join(".");
  }
  return g.slice(0, 4).map((x) => x.toString(16)).join(":") + "::/64";
}

export async function checkRateLimit(
  endpoint: string,
  ip: string,
  getStoreImpl: (name: string) => RateStore,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  if (!ip) return { allowed: true, retryAfterSeconds: 0 };
  try {
    const store = getStoreImpl("rate-limits");
    const key = `${endpoint}:${rateLimitBucket(ip)}`;
    const now = Date.now();
    // NOTE: this read-modify-write is not atomic — Netlify Blobs has no
    // compare-and-set. Concurrent requests for the same key all read the same
    // record and last-writer-wins, so N parallel requests may be counted as
    // one: a client firing bursts in parallel can exceed the limit by roughly
    // its concurrency factor. The limit is a coarse abuse guard, so we accept
    // that undercount rather than add a locking layer.
    const record = (await store.get(key, { type: "json" })) as RateRecord ??
      { calls: [] };
    record.calls = record.calls.filter((t) => now - t < WINDOW_MS);
    if (record.calls.length >= MAX_CALLS) {
      const oldest = record.calls[0];
      const retryAfter = Math.ceil((WINDOW_MS - (now - oldest)) / 1000);
      return { allowed: false, retryAfterSeconds: retryAfter };
    }
    record.calls.push(now);
    await store.setJSON(key, record);
    return { allowed: true, retryAfterSeconds: 0 };
  } catch (e) {
    // A Blobs outage previously threw here and 500'd EVERY request (a worse DoS
    // than missing the limit). Fail open: log and allow.
    console.warn("rate-limit store error (failing open):", e);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
