// The user's names for their accounts: Signalbox's own accounts.json ({ "v": 1, "labels": { "<account id>": "…" } }),
// written by the macOS app when you rename an account, read here so the CLI and the web page use the same names.
// Account ids are hashes (core's accountId), so the file holds no vendor ids or emails. Read-only here; a missing,
// oversized or broken file just means no labels (UIs then show the short id).
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseAccountLabels } from "@signalbox/core";

export const ACCOUNTS_FILE_ENV = "SIGNALBOX_ACCOUNTS_FILE";
export const ACCOUNTS_FILE_MAX_BYTES = 64 * 1024;

/** $SIGNALBOX_ACCOUNTS_FILE, else ~/Library/Application Support/signalbox/accounts.json. */
export function accountsFilePath(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  return env[ACCOUNTS_FILE_ENV] || join(home, "Library", "Application Support", "signalbox", "accounts.json");
}

let cached: { path: string; mtimeMs: number; size: number; labels: Record<string, string> } | undefined;

/** Account id → label; {} when the file is missing, not a regular file, over 64 KiB or unparsable. */
export async function readAccountLabels(path = accountsFilePath()): Promise<Record<string, string>> {
  try {
    const st = await lstat(path);
    if (!st.isFile() || st.size > ACCOUNTS_FILE_MAX_BYTES) return {};
    if (cached && cached.path === path && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.labels;
    const text = await Bun.file(path).text();
    if (text.length > ACCOUNTS_FILE_MAX_BYTES) return {};
    const labels = parseAccountLabels(text);
    cached = { path, mtimeMs: st.mtimeMs, size: st.size, labels };
    return labels;
  } catch {
    return {};
  }
}
