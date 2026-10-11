// Line readers for JSONL transcripts. Files can be hundreds of MB and single lines over 1 MB,
// so nothing here loads a whole file into memory.

/**
 * Streams `path` and calls `fn` once per line (without the newline). Invalid UTF-8 is replaced,
 * not thrown. A final line without a trailing newline (a live file mid-write) is still delivered;
 * callers must tolerate it failing to parse.
 */
export async function forEachLine(path: string, fn: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder("utf-8");
  let carry = "";
  const reader = Bun.file(path).stream().getReader();
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    const text = carry + decoder.decode(chunk, { stream: true });
    let lineStart = 0;
    // `carry` never contains a newline, so the search can start after it.
    let searchFrom = carry.length;
    let idx: number;
    while ((idx = text.indexOf("\n", searchFrom)) !== -1) {
      fn(text.slice(lineStart, idx));
      lineStart = searchFrom = idx + 1;
    }
    carry = lineStart === 0 ? text : text.slice(lineStart);
  }
  carry += decoder.decode();
  if (carry.length > 0) fn(carry);
}

const TAIL_START = 256 * 1024;
const TAIL_MAX = 16 * 1024 * 1024;

/**
 * Scans `path` backwards (newest line first) and returns the first value `pick` returns that is
 * not undefined. Reads a growing tail window (256 KiB doubling up to 16 MiB) instead of the file.
 */
export async function findFromEnd<T>(path: string, pick: (line: string) => T | undefined): Promise<T | undefined> {
  const file = Bun.file(path);
  const size = file.size;
  if (size === 0) return undefined;
  let window = Math.min(TAIL_START, size);
  let checkedFrom = size; // byte offset where the already-checked region begins
  for (;;) {
    const start = size - window;
    const bytes = new Uint8Array(await file.slice(start, checkedFrom).arrayBuffer());
    // Only complete lines: drop the leading fragment unless we are at the start of the file.
    let from = 0;
    if (start > 0) {
      const nl = bytes.indexOf(10);
      if (nl === -1) {
        if (window >= TAIL_MAX || window >= size) return undefined;
        window = Math.min(window * 2, size, TAIL_MAX);
        continue;
      }
      from = nl + 1;
    }
    const text = new TextDecoder("utf-8").decode(bytes.subarray(from));
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      const v = pick(line);
      if (v !== undefined) return v;
    }
    if (start === 0 || window >= TAIL_MAX) return undefined;
    checkedFrom = start + from;
    window = Math.min(window * 2, size, TAIL_MAX);
  }
}
