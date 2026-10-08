// Korrekthet i strømmen og videresendingen (review-runden 2026-10-08):
// streamAnthropic meldte avkorting/midt-strøm-feil som `done`, svar-løpet
// sendte Anthropic-taket (32000) og ingen historikk til egne leverandører,
// og svar.ts videresendte rå-felt som kunne sprenge jobbens 2 MB-tak.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { streamAnthropic } from "./anthropic.ts";
import { byggLop } from "./svar-lop.ts";
import { byggJobbKropp } from "../svar.ts";

async function collect(stream: ReadableStream<Uint8Array>): Promise<Record<string, unknown>[]> {
  const text = await new Response(stream).text();
  return text.split("\n\n").filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, "")));
}

function sseFetch(lines: string[]): typeof fetch {
  const enc = new TextEncoder();
  return (() => Promise.resolve(new Response(new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(`data: ${l}\n\n`));
      c.close();
    },
  })))) as typeof fetch;
}

// ── streamAnthropic ──────────────────────────────────────────────────────

Deno.test("streamAnthropic: stop_reason max_tokens → error, ikke done", async () => {
  const events = await collect(await streamAnthropic({ apiKey: "k", model: "m", prompt: "p" }, {
    fetchImpl: sseFetch([
      '{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hei"}}',
      '{"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":5}}',
      '{"type":"message_stop"}',
    ]),
  }));
  assertEquals(events[0], { type: "text", text: "Hei" });
  assertEquals(events.some((e) => e.type === "done"), false);
  assert(String(events.find((e) => e.type === "error")?.message).includes("avkortet"));
});

Deno.test("streamAnthropic: midt-strøm error-event (overloaded) → error, ikke done", async () => {
  const events = await collect(await streamAnthropic({ apiKey: "k", model: "m", prompt: "p" }, {
    fetchImpl: sseFetch([
      '{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hei"}}',
      '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    ]),
  }));
  assertEquals(events.some((e) => e.type === "done"), false);
  assert(String(events.find((e) => e.type === "error")?.message).includes("overloaded_error"));
});

Deno.test("streamAnthropic: end_turn → fortsatt done", async () => {
  const events = await collect(await streamAnthropic({ apiKey: "k", model: "m", prompt: "p" }, {
    fetchImpl: sseFetch([
      '{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hei"}}',
      '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
    ]),
  }));
  assertEquals(events[events.length - 1].type, "done");
});

// ── byggLop: egen leverandør ─────────────────────────────────────────────

async function lopMotCompat(forhistorikk?: { role: "user" | "assistant"; content: string }[]) {
  const bodies: Record<string, unknown>[] = [];
  const ekte = globalThis.fetch;
  globalThis.fetch = ((_u: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Promise.resolve(Response.json({ choices: [{ finish_reason: "stop", message: { content: "Svar" } }] }));
  }) as typeof fetch;
  try {
    const ut = await byggLop({
      origin: "https://eksempel.invalid", question: "Nå?", mode: "microdata",
      choice: {
        apiKey: "", model: "claude-sonnet-5", effort: "high",
        provider: { type: "openai-compat", baseUrl: "https://llm.example/v1", model: "deepseek-chat", key: "sk-x-12345678", webSearch: "none" },
      },
      erPersonlig: false, byokKey: null, runOkCalls: 0, kvalitet: "balanced",
      journalHendelse: () => {}, turnDeadlineMs: 50_000, forhistorikk,
      buildSystem: () => "SYS",
    });
    await collect(ut as ReadableStream<Uint8Array>);
  } finally {
    globalThis.fetch = ekte;
  }
  return bodies;
}

Deno.test("byggLop: egen leverandør får ikke Anthropic-taket 32000", async () => {
  const bodies = await lopMotCompat();
  assert(Number(bodies[0].max_tokens) <= 16384, String(bodies[0].max_tokens));
});

Deno.test("byggLop: egen leverandør får samtalehistorikken før dagens spørsmål", async () => {
  const bodies = await lopMotCompat([
    { role: "user", content: "Før?" }, { role: "assistant", content: "Svar før." },
  ]);
  const msgs = bodies[0].messages as { role: string; content: string }[];
  assertEquals(msgs.map((m) => m.role), ["system", "user", "assistant", "user"]);
  assertEquals(msgs[1].content, "Før?");
  assert(msgs[3].content.includes("Nå?"));
});

// ── svar.ts: videresendt jobbkropp ───────────────────────────────────────

Deno.test("byggJobbKropp: rå run_result/historikk/resume reiser ikke videre", () => {
  const r = byggJobbKropp(
    { question: "q", run_result: "R".repeat(500), historikk: [{ rolle: "bruker", tekst: "x" }], resume: { state: {} } },
    { jobId: "j", runResultTilLopet: "R", forhistorikk: [] },
  );
  assert(r.ok);
  const b = JSON.parse(r.body);
  assertEquals("run_result" in b, false);
  assertEquals("historikk" in b, false);
  assertEquals("resume" in b, false);
  assertEquals(b.question, "q");
  assertEquals(b.runResultTilLopet, "R");
});

Deno.test("byggJobbKropp: over jobbens 2 MB-tak → ok:false (klar feil før spawn)", () => {
  const r = byggJobbKropp({ question: "q", script: "x".repeat(2_000_100) }, { jobId: "j" });
  assertEquals(r.ok, false);
});
