// MIDLERTIDIG diagnose-endepunkt (60s-veggen, 2026-08-28): strømmer et tick
// hvert 5. sekund i 120 s. Slettes når målingen er gjort.
export default (): Response => {
  const enc = new TextEncoder();
  let n = 0;
  let timer: number;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      timer = setInterval(() => {
        n += 5;
        try { c.enqueue(enc.encode(`data: {"t":${n}}\n\n`)); } catch { clearInterval(timer); }
        if (n >= 120) { clearInterval(timer); try { c.close(); } catch { /* ok */ } }
      }, 5000);
    },
    cancel() { clearInterval(timer); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
};
