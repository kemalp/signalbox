// Cutting one top-level member out of a JSON document without parsing the rest of it. Claude Code's global config
// and settings files hold secrets (MCP server settings, `env` values, an API key helper) next to the one value
// Signalbox reads, so the rest of the file is never turned into objects: it is only checked to be valid JSON, and
// only the member's own text (and the root object's key names) is parsed.

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const ESCAPES = '"\\/bfnrt';

/**
 * The raw text of the root object's `key` member; undefined when there is none. The whole text is checked against
 * strict JSON (RFC 8259: JSON whitespace only, no comments, no trailing commas, nothing after the root object)
 * without building any values, and a SyntaxError is thrown when it isn't one whole JSON object. Claude Code reads
 * its settings files as strict JSON, so a file it would reject (or one caught mid-write) never reads as "not set".
 * With duplicate keys the last one wins, as with JSON.parse.
 */
export function topLevelValueText(text: string, key: string): string | undefined {
  const n = text.length;
  let i = 0;
  const fail = (): never => {
    throw new SyntaxError("unparsable");
  };
  const ws = () => {
    for (; i < n; i++) {
      const c = text.charCodeAt(i);
      if (c !== 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) return;
    }
  };
  /** Moves past the string that opens at i. */
  const string = () => {
    if (text.charCodeAt(i) !== 0x22) fail();
    for (i++; i < n; ) {
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        i++;
        return;
      }
      if (c === 0x5c) {
        const e = text[i + 1];
        if (e === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail();
          i += 6;
        } else if (e !== undefined && ESCAPES.includes(e)) i += 2;
        else fail();
        continue;
      }
      if (c < 0x20) fail();
      i++;
    }
    fail();
  };
  // Containers open on the way in (0x7b object, 0x5b array); no recursion, so deep nesting can't overflow the stack.
  const stack: number[] = [];
  let found: string | undefined;
  /** Where the value of a root member named `key` starts, while that value is being scanned. */
  let pending = -1;
  let targetNext = false;
  /** A member's name and colon, at i. */
  const member = () => {
    ws();
    const start = i;
    string();
    if (stack.length === 1) targetNext = JSON.parse(text.slice(start, i)) === key;
    ws();
    if (text.charCodeAt(i) !== 0x3a) fail();
    i++;
  };

  ws();
  if (text.charCodeAt(i) !== 0x7b) fail();
  for (;;) {
    // A value starts here.
    ws();
    if (targetNext) {
      pending = i;
      targetNext = false;
    }
    const c = text.charCodeAt(i);
    if (c === 0x7b || c === 0x5b) {
      stack.push(c);
      i++;
      ws();
      if (text.charCodeAt(i) !== (c === 0x7b ? 0x7d : 0x5d)) {
        if (c === 0x7b) member();
        continue;
      }
      i++;
      stack.pop();
    } else if (c === 0x22) {
      string();
    } else if (text.startsWith("true", i)) {
      i += 4;
    } else if (text.startsWith("false", i)) {
      i += 5;
    } else if (text.startsWith("null", i)) {
      i += 4;
    } else {
      NUMBER.lastIndex = i;
      if (!NUMBER.test(text)) fail();
      i = NUMBER.lastIndex;
    }
    // A value ended at i: close containers until a comma asks for the next value.
    for (;;) {
      if (pending >= 0 && stack.length === 1) {
        found = text.slice(pending, i);
        pending = -1;
      }
      ws();
      if (stack.length === 0) {
        if (i !== n) fail();
        return found;
      }
      const top = stack[stack.length - 1];
      const d = text.charCodeAt(i);
      if (d === 0x2c) {
        i++;
        if (top === 0x7b) member();
        break;
      }
      if (d !== (top === 0x7b ? 0x7d : 0x5d)) fail();
      i++;
      stack.pop();
    }
  }
}

/** The root object's `key` member when it is an object (see topLevelValueText); undefined when absent or not one. */
export function topLevelObjectText(text: string, key: string): string | undefined {
  const raw = topLevelValueText(text, key);
  return raw?.startsWith("{") ? raw : undefined;
}

/** The parsed value of the root object's `key` member: `{ set: false }` when absent. Throws unless strict JSON. */
export function topLevelValue(text: string, key: string): { set: false } | { set: true; value: unknown } {
  const raw = topLevelValueText(text, key);
  return raw === undefined ? { set: false } : { set: true, value: JSON.parse(raw) };
}
