// A compressed session log is a concatenation of independent Zstandard frames: one for the header line, then
// one per append batch. Walking the frame and block headers (RFC 8878, section 3.1.1) finds where each frame
// ends without decoding it, so a reader can take whole frames only: the frame being written, or one torn by a
// crash, stays untouched until it is complete, and a log that grew is read from the last frame it ended on.

const FRAME_MAGIC = 0xfd2fb528;
const SKIPPABLE_MAGIC = 0x184d2a50;
const SKIPPABLE_MASK = 0xfffffff0;
const DICTIONARY_ID_BYTES = [0, 1, 2, 4] as const;

/**
 * The end offset of every complete frame at the start of `bytes`, in order. The walk stops at the first byte that
 * does not start a frame, or at a frame whose end lies beyond `bytes`; whatever follows is left alone.
 */
export function completeFrameEnds(bytes: Uint8Array): number[] {
  const ends: number[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  while (at + 4 <= bytes.length) {
    const magic = view.getUint32(at, true);
    if ((magic & SKIPPABLE_MASK) >>> 0 === SKIPPABLE_MAGIC) {
      if (at + 8 > bytes.length) break;
      const end = at + 8 + view.getUint32(at + 4, true);
      if (end > bytes.length) break;
      ends.push((at = end));
      continue;
    }
    if (magic !== FRAME_MAGIC || at + 5 > bytes.length) break;
    const descriptor = bytes[at + 4]!;
    const contentSizeFlag = descriptor >> 6;
    const singleSegment = (descriptor >> 5) & 1;
    const contentSizeBytes = contentSizeFlag === 0 ? singleSegment : contentSizeFlag === 1 ? 2 : contentSizeFlag === 2 ? 4 : 8;
    let p = at + 5 + (singleSegment ? 0 : 1) + DICTIONARY_ID_BYTES[descriptor & 3]! + contentSizeBytes;
    let closed = false;
    while (p + 3 <= bytes.length) {
      const header = bytes[p]! | (bytes[p + 1]! << 8) | (bytes[p + 2]! << 16);
      const type = (header >> 1) & 3;
      if (type === 3) break; // reserved: not a frame this reader understands
      // An RLE block stores one byte, whatever size it regenerates.
      p += 3 + (type === 1 ? 1 : header >> 3);
      if (header & 1) {
        closed = true;
        break;
      }
    }
    if (!closed) break;
    if ((descriptor >> 2) & 1) p += 4; // content checksum
    if (p > bytes.length) break;
    ends.push((at = p));
  }
  return ends;
}

/** Frames are inflated in runs of about this many compressed bytes, so a long log is never held in memory whole. */
const SLICE_BYTES = 1 << 20;

export interface InflateResult {
  /** Bytes of `bytes` that were inflated: the end of the last good frame. */
  consumed: number;
  /** A complete frame failed its checksum or did not decode; nothing after it was read. */
  corrupt: boolean;
}

function tryInflate(frames: Uint8Array): Uint8Array | undefined {
  try {
    return Bun.zstdDecompressSync(frames);
  } catch {
    return undefined;
  }
}

/**
 * Inflates the complete frames at the start of `bytes` and hands the plain bytes to `onPlain` in order. A frame
 * that fails to decode stops the read there (`corrupt`): the frames before it were still delivered.
 */
export function inflateFrames(bytes: Uint8Array, onPlain: (plain: Uint8Array) => void): InflateResult {
  const ends = completeFrameEnds(bytes);
  let start = 0;
  let first = 0; // index in `ends` of the first frame of the current run
  for (let i = 0; i < ends.length; i++) {
    const end = ends[i]!;
    if (end - start < SLICE_BYTES && i < ends.length - 1) continue;
    const plain = tryInflate(bytes.subarray(start, end));
    if (plain) {
      onPlain(plain);
    } else {
      // One frame in the run is bad: deliver the good ones before it, one at a time.
      let from = start;
      for (let k = first; k <= i; k++) {
        const one = tryInflate(bytes.subarray(from, ends[k]!));
        if (!one) return { consumed: from, corrupt: true };
        onPlain(one);
        from = ends[k]!;
      }
    }
    start = end;
    first = i + 1;
  }
  return { consumed: start, corrupt: false };
}
