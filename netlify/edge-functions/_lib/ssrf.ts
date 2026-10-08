// SSRF guard for outbound fetches made on behalf of user-influenced URLs
// (/api/hent proxy and the probe tool). Hostname-based: the edge runtime
// cannot pre-resolve DNS, so a public hostname resolving to a private IP is
// not catchable here. Compensating controls: no credential forwarding,
// GET/POST-json only, byte cap, timeout, redirect hops re-checked.
//
// DNS REBINDING: the same hostname-only guard also protects the user-supplied
// provider base_url, and the svar agentic loop now runs in a Node background
// function (netlify/functions/svar-jobb.mts) with ordinary DNS resolution. A
// public hostname that resolves (or later re-resolves) to a private address is
// NOT caught here, on either runtime. Accepted limitation: those fetches send
// only the user's own key to the user's own chosen host, never server
// credentials, and use redirect: "error".

// Reserverte/ikke-offentlige IPv4-områder som [nettverk, prefikslengde].
const RESERVERT_V4: [number, number][] = [
  [0x00000000, 8],   // 0.0.0.0/8      «denne» nettverket
  [0x0a000000, 8],   // 10.0.0.0/8     privat
  [0x64400000, 10],  // 100.64.0.0/10  CGNAT
  [0x7f000000, 8],   // 127.0.0.0/8    loopback
  [0xa9fe0000, 16],  // 169.254.0.0/16 link-local (sky-metadata)
  [0xac100000, 12],  // 172.16.0.0/12  privat
  [0xc0000000, 24],  // 192.0.0.0/24   IETF-protokolltildelinger
  [0xc0a80000, 16],  // 192.168.0.0/16 privat
  [0xc6120000, 15],  // 198.18.0.0/15  benchmarking
  [0xe0000000, 4],   // 224.0.0.0/4    multicast
  [0xf0000000, 4],   // 240.0.0.0/4    reservert + 255.255.255.255
];

function erReservertV4(ip: number): boolean {
  return RESERVERT_V4.some(([nett, len]) => {
    const maske = len === 0 ? 0 : (~0 << (32 - len)) >>> 0;
    return ((ip & maske) >>> 0) === nett;
  });
}

/** Tolker en vertsstreng som IPv4 i alle inet_aton-former (desimal, 0x-heks,
 * 0-oktal, 1-4 deler: «127.1», «2130706433», «0x7f.1»). null = ikke en IPv4.
 * new URL() kanoniserer disse allerede, men vi stoler ikke blindt på det. */
export function ipv4Tall(host: string): number | null {
  const deler = host.split(".");
  if (deler.length < 1 || deler.length > 4) return null;
  const tall: number[] = [];
  for (const d of deler) {
    let n: number;
    if (/^0x[0-9a-f]*$/i.test(d)) n = d.length === 2 ? 0 : parseInt(d.slice(2), 16);
    else if (/^0[0-7]+$/.test(d)) n = parseInt(d, 8);
    else if (/^(0|[1-9]\d*)$/.test(d)) n = parseInt(d, 10);
    else return null;
    if (!Number.isFinite(n)) return null;
    tall.push(n);
  }
  const siste = tall.pop()!;
  if (tall.some((n) => n > 255)) return null;
  const restBits = 8 * (4 - tall.length);
  if (siste >= 2 ** restBits) return null;
  let ip = 0;
  for (const n of tall) ip = ip * 256 + n;
  return ip * 2 ** restBits + siste;
}

export function isPublicHttpUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  // Normaliser FØRST: små bokstaver og ingen avsluttende punktum. Uten dette
  // slapp «localhost.» og «metadata.google.internal.» forbi suffiks-sjekkene
  // (new URL() beholder punktumet), selv om DNS behandler dem likt.
  const host = u.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".local") || host === "internal" || host.endsWith(".internal")) return false;
  if (host.includes(":") || host.startsWith("[")) return false; // IPv6 literals (inkl. IPv4-mapped): reject
  const ip = ipv4Tall(host);
  if (ip !== null) return !erReservertV4(ip);
  // Ser ut som et tall-literal, men lot seg ikke tolke (f.eks. «09.1.1.1»):
  // avvis heller enn å la resolveren gjette.
  if (/^[0-9.x]+$/i.test(host) && /^\d/.test(host)) return false;
  return true;
}

export interface GuardedResult {
  status: number;
  headers: Headers;
  body: Uint8Array;
  truncated: boolean;
  finalUrl: string;
}

export interface GuardedOptions {
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  fetchImpl?: typeof fetch;
  // Eksakt origin (f.eks. appens eget, http://localhost:8888 under netlify
  // dev) som slipper offentlig-vert-sjekken. Kun for statiske filer på vårt
  // eget origin — redirects videre derfra sjekkes som normalt.
  trustedOrigin?: string;
}

function originOf(raw: string): string | null {
  try { return new URL(raw).origin; } catch { return null; }
}

export async function fetchGuarded(rawUrl: string, opts: GuardedOptions = {}): Promise<GuardedResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? 50 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 5;

  let url = rawUrl;
  const initialHost = new URL(rawUrl).host;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const trusted = !!opts.trustedOrigin && originOf(url) === opts.trustedOrigin;
    if (!trusted && !isPublicHttpUrl(url)) throw new Error(`blokkert URL (ikke offentlig http/https): ${url}`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    // Auth/credential headers (e.g. a header-injected API key) must never be
    // replayed to a host other than the one the caller originally targeted —
    // a redirect to a foreign host must not receive them.
    const sameHost = new URL(url).host === initialHost;
    try {
      const resp = await fetchImpl(url, {
        method: opts.method ?? "GET",
        body: opts.body,
        headers: sameHost ? opts.headers : {},
        redirect: "manual",
        signal: ctrl.signal,
      });
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get("location");
        await resp.body?.cancel();
        if (!loc) throw new Error(`redirect uten Location fra ${url}`);
        url = new URL(loc, url).toString();
        continue;
      }
      // size-capped body read
      const chunks: Uint8Array[] = [];
      let total = 0;
      let truncated = false;
      if (resp.body) {
        const reader = resp.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (total + value.length > maxBytes) {
            chunks.push(value.slice(0, maxBytes - total));
            total = maxBytes;
            truncated = true;
            await reader.cancel();
            break;
          }
          chunks.push(value);
          total += value.length;
        }
      }
      const body = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { body.set(c, off); off += c.length; }
      return { status: resp.status, headers: resp.headers, body, truncated, finalUrl: url };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`for mange redirects fra ${rawUrl}`);
}

// ── Fetch-kompatibel innpakning for faste oppstrøms-API-er ──
// Katalogsøk og tabellmetadata (search-catalog, table-metadata, catalogs/*)
// kalte før rå fetch + res.json() uten timeout eller byte-tak: en treg eller
// enorm respons kunne henge/sprenge edge-funksjonen. Innpakningen ruter via
// fetchGuarded (timeout, byte-tak, SSRF-sjekk per redirect-hop) og gir
// tilbake en vanlig Response, så adapterne beholder res.ok/.json()/.text().
// Et avkuttet svar kastes i stedet for å gi halv JSON/XML til parseren.
export const UPSTREAM_TIMEOUT_MS = 15_000;
// SDMX ?references=all (OECD/Eurostat) kan være flere MB; de statiske
// katalogfilene er ~1 MB. 16 MB gir god margin uten å være ubegrenset.
export const UPSTREAM_MAX_BYTES = 16 * 1024 * 1024;

const RAW_FETCH = Symbol("rawFetch");
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

export interface UpstreamOptions {
  timeoutMs?: number;
  maxBytes?: number;
  trustedOrigin?: string;
}

export function guardedFetchImpl(fetchImpl: typeof fetch = fetch, opts: UpstreamOptions = {}): typeof fetch {
  // Pakk aldri inn to ganger (table-metadata → worldbankMetadata o.l.):
  // gå tilbake til den rå fetch-en og legg nye opsjoner på den.
  const raw = (fetchImpl as unknown as Record<symbol, typeof fetch>)[RAW_FETCH] ?? fetchImpl;
  const wrapped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") throw new Error(`metode ${method} ikke støttet mot oppstrøms`);
    let headers: Record<string, string> | undefined;
    if (init?.headers instanceof Headers || Array.isArray(init?.headers)) {
      headers = Object.fromEntries(new Headers(init!.headers));
    } else {
      headers = init?.headers as Record<string, string> | undefined;
    }
    const r = await fetchGuarded(url, {
      method: method as "GET" | "POST",
      body: init?.body == null ? undefined : String(init.body),
      headers,
      timeoutMs: opts.timeoutMs ?? UPSTREAM_TIMEOUT_MS,
      maxBytes: opts.maxBytes ?? UPSTREAM_MAX_BYTES,
      trustedOrigin: opts.trustedOrigin,
      fetchImpl: raw,
    });
    if (r.truncated) {
      throw new Error(`oppstrøms-svar fra ${new URL(r.finalUrl).host} over ${opts.maxBytes ?? UPSTREAM_MAX_BYTES} byte — avbrutt`);
    }
    return new Response(NULL_BODY_STATUS.has(r.status) ? null : r.body as BodyInit, { status: r.status, headers: r.headers });
  };
  (wrapped as unknown as Record<symbol, typeof fetch>)[RAW_FETCH] = raw;
  return wrapped as typeof fetch;
}
