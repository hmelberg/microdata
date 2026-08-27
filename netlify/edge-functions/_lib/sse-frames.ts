// One SSE frame parser, shared by every stream transform in this codebase.
//
// Written for the multi-provider round (spec 2026-08-27-multi-provider-byok):
// the openai-compat provider needs exactly the framing transformAnthropicStream
// already did inline — and that function carried its main loop and its
// end-of-stream drain block as a verbatim copy-paste of each other, so any fix
// had to be made twice or silently applied to only one path. Both now call in
// here.
//
// Deliberately dumb: it knows about SSE framing (`\n\n` separators, `data:`
// lines) and nothing about JSON or any provider's event vocabulary. Callers
// parse the payloads.

/** One frame's `data:` payload, or null for frames that carry none. */
function payloadOf(frame: string): string | null {
  const line = frame.split("\n").find((l) => l.startsWith("data:"));
  if (!line) return null;
  const payload = line.slice(5).trim();
  // `[DONE]` is OpenAI's terminator and Anthropic sends empty keep-alives;
  // neither is a payload a caller should try to parse.
  if (!payload || payload === "[DONE]") return null;
  return payload;
}

/**
 * Append `chunk` to `buffer` and split off every COMPLETE frame.
 *
 * Returns the payloads found and the unconsumed remainder, which the caller
 * feeds back in as `buffer` on the next chunk — that is what makes a payload
 * split across two network reads survive.
 */
export function parseSseFrames(
  chunk: string,
  buffer: string,
): { payloads: string[]; buffer: string } {
  let rest = buffer + chunk;
  const payloads: string[] = [];
  let idx: number;
  while ((idx = rest.indexOf("\n\n")) >= 0) {
    const payload = payloadOf(rest.slice(0, idx));
    if (payload !== null) payloads.push(payload);
    rest = rest.slice(idx + 2);
  }
  return { payloads, buffer: rest };
}

/**
 * Drain a trailing frame that the stream ended without terminating by `\n\n`.
 * Call once after the reader reports done.
 */
export function flushSseBuffer(buffer: string): string[] {
  if (!buffer.trim()) return [];
  const payload = payloadOf(buffer.trimEnd());
  return payload === null ? [] : [payload];
}
