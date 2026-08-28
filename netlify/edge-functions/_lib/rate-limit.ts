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

export async function checkRateLimit(
  endpoint: string,
  ip: string,
  getStoreImpl: (name: string) => RateStore,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  if (!ip) return { allowed: true, retryAfterSeconds: 0 };
  try {
    const store = getStoreImpl("rate-limits");
    const key = `${endpoint}:${ip}`;
    const now = Date.now();
    // NOTE: this read-modify-write is not atomic — Netlify Blobs has no
    // compare-and-set, so two truly-concurrent requests for the same key can
    // race and undercount. The window is small and the limit is a coarse abuse
    // guard, so we accept it rather than add a locking layer.
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
