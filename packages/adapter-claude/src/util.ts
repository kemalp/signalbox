// Small defensive helpers. Agent formats change often: every field is optional and checked.

export type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A finite number, or undefined. */
export function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Per-response sanity cap: no single API response reads or writes anywhere near this many tokens. */
export const MAX_RESPONSE_TOKENS = 1e10;

/** A whole number in [0, max], else undefined (missing, fractional, negative, non-finite or absurd). */
export function validCount(v: unknown, max = MAX_RESPONSE_TOKENS): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : undefined;
}

/** A non-negative token count; missing or invalid becomes 0 (TokenCounts fields are required). */
export function count(v: unknown, max = MAX_RESPONSE_TOKENS): number {
  return validCount(v, max) ?? 0;
}

/** True when `v` is present but not a valid count, so `count` would silently turn it into 0. */
export function badCount(v: unknown, max = MAX_RESPONSE_TOKENS): boolean {
  return v !== undefined && v !== null && validCount(v, max) === undefined;
}

/** A non-empty string, or undefined. */
export function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * A short machine label such as "permission prompt": at most 48 letters, digits, spaces and `_ . : / -`.
 * Anything longer or with other characters is undefined, so free text (message content) never passes.
 */
export function label(v: unknown, max = 48): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s.length > 0 && s.length <= max && /^[A-Za-z0-9 _.:/-]+$/.test(s) ? s : undefined;
}

/** Epoch number (ms, or seconds if it looks like seconds) or date string → ISO-8601, else undefined. */
export function toIso(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    const ms = v < 1e11 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  if (typeof v === "string" && v.length > 0) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : new Date(t).toISOString();
  }
  return undefined;
}

export function errCode(e: unknown): string {
  if (isObj(e) && typeof e.code === "string") return e.code;
  return e instanceof Error ? e.name : "error";
}
