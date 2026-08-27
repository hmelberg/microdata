import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { flushSseBuffer, parseSseFrames } from "./sse-frames.ts";

Deno.test("parseSseFrames extracts complete frames and keeps the remainder", () => {
  const r = parseSseFrames('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"', "");
  assertEquals(r.payloads, ['{"a":1}', '{"b":2}']);
  assertEquals(r.buffer, 'data: {"c"');
});

Deno.test("parseSseFrames joins a payload split across chunks", () => {
  const a = parseSseFrames('data: {"a":', "");
  assertEquals(a.payloads, []);
  const b = parseSseFrames("1}\n\n", a.buffer);
  assertEquals(b.payloads, ['{"a":1}']);
});

Deno.test("parseSseFrames drops [DONE] and empty payloads", () => {
  const r = parseSseFrames("data: [DONE]\n\ndata: \n\ndata: x\n\n", "");
  assertEquals(r.payloads, ["x"]);
});

Deno.test("parseSseFrames ignores frames with no data: line", () => {
  const r = parseSseFrames("event: ping\n\ndata: y\n\n", "");
  assertEquals(r.payloads, ["y"]);
});

Deno.test("parseSseFrames handles multi-line frames (event: + data:)", () => {
  const r = parseSseFrames('event: delta\ndata: {"n":1}\n\n', "");
  assertEquals(r.payloads, ['{"n":1}']);
});

Deno.test("flushSseBuffer drains a final frame with no trailing blank line", () => {
  assertEquals(flushSseBuffer('data: {"z":9}'), ['{"z":9}']);
  assertEquals(flushSseBuffer("   "), []);
  assertEquals(flushSseBuffer(""), []);
});
