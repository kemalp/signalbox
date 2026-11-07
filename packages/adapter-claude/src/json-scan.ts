// Cutting one top-level member out of a JSON document without parsing the rest of it. Claude Code's global config
// and settings files hold secrets (MCP server settings, `env` values, an API key helper) next to the one value
// Signalbox reads, so the rest of the file is never turned into objects: only the member's own text is parsed.

/** Throws unless the text looks like one whole JSON object (a file caught mid-write usually doesn't). */
export function assertWholeObject(text: string): void {
  if (!/^\s*\{/.test(text) || !/\}\s*$/.test(text)) throw new SyntaxError("unparsable");
}

/**
 * The raw text of the root object's `key` member, found by scanning (strings, escapes and nesting respected) instead
 * of parsing the whole document; undefined when there is none. Throws a SyntaxError when the text is cut off (a
 * string, the member or the root object never closes), so a file caught mid-write never reads as "not set".
 */
export function topLevelValueText(text: string, key: string): string | undefined {
  const n = text.length;
  const cut = () => new SyntaxError("unparsable");
  /** Index just past the string that opens at `j`. */
  const past = (j: number): number => {
    for (j++; j < n; j++) {
      if (text[j] === "\\") j++;
      else if (text[j] === '"') return j + 1;
    }
    throw cut();
  };
  let depth = 0;
  for (let i = 0; i < n; ) {
    const c = text[i];
    if (c === '"') {
      const end = past(i);
      if (depth === 1) {
        let k = end;
        while (k < n && /\s/.test(text[k]!)) k++;
        if (text[k] === ":") {
          let name: unknown;
          try {
            name = JSON.parse(text.slice(i, end));
          } catch {
            throw cut();
          }
          if (name === key) return valueAt(text, k + 1, past, cut);
        }
      }
      i = end;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    i++;
  }
  if (depth !== 0) throw cut();
  return undefined;
}

/** The text of the value that starts at or after `from` (whitespace skipped): an object, array, string or literal. */
function valueAt(text: string, from: number, past: (j: number) => number, cut: () => SyntaxError): string {
  const n = text.length;
  let v = from;
  while (v < n && /\s/.test(text[v]!)) v++;
  if (v >= n) throw cut();
  const first = text[v];
  if (first === '"') return text.slice(v, past(v));
  if (first !== "{" && first !== "[") {
    let e = v;
    while (e < n && !/[\s,}\]]/.test(text[e]!)) e++;
    if (e >= n) throw cut();
    return text.slice(v, e);
  }
  let d = 0;
  for (let j = v; j < n; ) {
    const ch = text[j];
    if (ch === '"') {
      j = past(j);
      continue;
    }
    if (ch === "{" || ch === "[") d++;
    else if (ch === "}" || ch === "]") {
      d--;
      if (d === 0) return text.slice(v, j + 1);
    }
    j++;
  }
  throw cut();
}

/** The root object's `key` member when it is an object (see topLevelValueText); undefined when absent or not one. */
export function topLevelObjectText(text: string, key: string): string | undefined {
  const raw = topLevelValueText(text, key);
  return raw?.startsWith("{") ? raw : undefined;
}

/** The parsed value of the root object's `key` member: `{ set: false }` when absent. Throws on a cut-off file. */
export function topLevelValue(text: string, key: string): { set: false } | { set: true; value: unknown } {
  assertWholeObject(text);
  const raw = topLevelValueText(text, key);
  if (raw === undefined) return { set: false };
  try {
    return { set: true, value: JSON.parse(raw) };
  } catch {
    throw new SyntaxError("unparsable");
  }
}
