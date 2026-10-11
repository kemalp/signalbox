// The tap mod can't set modes ($.fs.write creates missing dirs with the default umask), so the
// reader makes its spool directory private before first use, and tightens one the mod made first.
import { chmod, mkdir, stat } from "node:fs/promises";

/** Mode bits that let anyone but the owner in. */
export const OPEN_BITS = 0o077;

/**
 * Creates `path` 0700, or chmods an existing directory we own to 0700 when group or others can read
 * it. Returns the old mode (e.g. "0755") when it tightened one, else undefined.
 */
export async function ensurePrivateDir(path: string): Promise<string | undefined> {
  let st;
  try {
    st = await stat(path);
  } catch {
    await mkdir(path, { recursive: true, mode: 0o700 });
    return undefined;
  }
  if (!st.isDirectory()) throw new Error(`${path} exists but is not a directory`);
  const uid = process.getuid?.();
  if ((st.mode & OPEN_BITS) === 0 || (uid !== undefined && st.uid !== uid)) return undefined;
  await chmod(path, 0o700);
  return (st.mode & 0o777).toString(8).padStart(4, "0");
}
