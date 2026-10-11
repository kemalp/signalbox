import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RecordKind } from "../../core/src/index.ts";

export function defaultConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

export function defaultSpoolDir(): string {
  return join(homedir(), "Library", "Application Support", "signalbox", "spool");
}

export interface TranscriptFile {
  path: string;
  kind: RecordKind;
  /** The owning (main) session id, taken from the path. */
  sessionId: string;
}

/**
 * Kind from the path relative to a project dir (verified layout, Claude Code 2.1.293):
 *   <sid>.jsonl                                          main
 *   <sid>/subagents/agent-<id>.jsonl                     subagent
 *   <sid>/subagents/workflows/wf_<id>/agent-<id>.jsonl   workflow
 *   <sid>/subagents/workflows/wf_<id>/journal.jsonl      skipped (no API usage)
 * Any other .jsonl under a session dir is kept as "other" so its tokens are still counted
 * (the reference cc_cost.py counts every .jsonl except journal.jsonl).
 */
export function classify(relParts: string[]): RecordKind | null {
  const name = relParts[relParts.length - 1];
  if (!name || !name.endsWith(".jsonl") || name === "journal.jsonl") return null;
  if (relParts.length === 1) return "main";
  const isAgent = name.startsWith("agent-") && relParts[1] === "subagents";
  if (isAgent && relParts.length === 3) return "subagent";
  if (isAgent && relParts.length === 5 && relParts[2] === "workflows") return "workflow";
  return "other";
}

const MAX_DEPTH = 6;

async function dirents(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Every transcript under <configDir>/projects. Symlinks are not followed. Order: by path. */
export async function listTranscripts(projectsDir: string): Promise<TranscriptFile[]> {
  const out: TranscriptFile[] = [];
  const walk = async (dir: string, rel: string[]): Promise<void> => {
    for (const ent of await dirents(dir)) {
      const parts = [...rel, ent.name];
      if (ent.isDirectory()) {
        if (parts.length < MAX_DEPTH) await walk(join(dir, ent.name), parts);
      } else if (ent.isFile()) {
        const kind = classify(parts);
        if (!kind) continue;
        const first = parts[0] ?? "";
        const sessionId = parts.length === 1 ? first.slice(0, -".jsonl".length) : first;
        out.push({ path: join(dir, ent.name), kind, sessionId });
      }
    }
  };
  for (const proj of await dirents(projectsDir)) {
    if (proj.isDirectory()) await walk(join(projectsDir, proj.name), []);
  }
  out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return out;
}

/** sessionId → main transcript path, for every <configDir>/projects/<proj>/<sid>.jsonl. */
export async function indexMainTranscripts(projectsDir: string): Promise<Map<string, string>> {
  const idx = new Map<string, string>();
  for (const proj of await dirents(projectsDir)) {
    if (!proj.isDirectory()) continue;
    const dir = join(projectsDir, proj.name);
    for (const ent of await dirents(dir)) {
      if (ent.isFile() && ent.name.endsWith(".jsonl")) idx.set(ent.name.slice(0, -".jsonl".length), join(dir, ent.name));
    }
  }
  return idx;
}

export async function mtimeMs(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

/** mtime and size, or undefined when the file is gone or unreadable. */
export async function fileStamp(path: string): Promise<{ mtimeMs: number; size: number } | undefined> {
  try {
    const s = await stat(path);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return undefined;
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
