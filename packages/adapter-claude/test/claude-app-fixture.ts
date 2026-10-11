// A SYNTHETIC Claude app session list (the app's claude-code-sessions folder) with decoys around it: files the
// reader must never open (cookies, tokens, the archive index, deleted_* records, scheduled tasks, a symlinked and an
// oversized record, records too deep or too shallow) and, in every record, fields it must drop (conversation
// summaries, prompt suggestions and drafts, errors) holding CANARY. Every id, title and path is made up.
// Used by the adapter's tests and the CLI's end-to-end tests.
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const APP_CANARY = "CANARY_SECRET";

/** Transcript session ids the records link to; the CLI test writes transcripts for the first two. */
export const APP_LINKED = "a1a1a1a1-0000-4000-8000-000000000001";
export const APP_ARCHIVED = "a1a1a1a1-0000-4000-8000-000000000002";
/** A record that names a transcript that doesn't exist. */
export const APP_GONE = "a1a1a1a1-0000-4000-8000-000000000003";

export const APP_IDS = {
  linked: "local_10000000-0000-4000-8000-000000000001",
  archived: "local_10000000-0000-4000-8000-000000000002",
  gone: "local_10000000-0000-4000-8000-000000000003",
  noCli: "local_10000000-0000-4000-8000-000000000004",
} as const;

export const APP_TITLES = {
  linked: "App title for the linked session",
  archived: "Renamed in the app",
  gone: "Transcript deleted since",
  noCli: "Listed by the app only",
} as const;

/** Every field the app writes that Signalbox must drop, each holding the canary. */
export function droppedFields(): Record<string, unknown> {
  return {
    postTurnSummary: { status_detail: `${APP_CANARY} summary detail`, status: "done", title: `${APP_CANARY} summary title` },
    postTurnSummaryFor: `${APP_CANARY}-turn`,
    promptSuggestion: `${APP_CANARY} suggested prompt`,
    scratchPromptRecents: [`${APP_CANARY} draft one`, `${APP_CANARY} draft two`],
    promptAppendSnapshot: { append: `${APP_CANARY} appended`, at: 1 },
    error: `${APP_CANARY} error text`,
    planPath: `/Users/you/${APP_CANARY}/plan.md`,
    prs: [{ url: `https://example.invalid/${APP_CANARY}` }],
    publishedArtifacts: [{ title: `${APP_CANARY} artifact` }],
    spawnSeed: { prompt: `${APP_CANARY} seed` },
    enabledMcpTools: { [`${APP_CANARY}_tool`]: true },
    toolSurfaceSnapshot: { tools: [`${APP_CANARY}`] },
    sessionPermissionUpdates: [{ rule: `${APP_CANARY}` }],
    alwaysAllowedReasons: [`${APP_CANARY} reason`],
    permissionMode: "default",
    completedTurns: 3,
  };
}

export interface AppTree {
  /** The claude-code-sessions folder (pass it as SIGNALBOX_CLAUDE_APP_DIR / claudeAppDir). */
  base: string;
  /** The files the reader may open: four valid records, one without a session id, one that isn't JSON. */
  allowed: string[];
  /** Files and folders that must never be opened or listed. */
  decoys: string[];
  /** The decoy files made unreadable (mode 000). */
  locked: string[];
}

export interface AppTreeTimes {
  /** Epoch ms for each record's createdAt / lastActivityAt. */
  linked: { createdAt: number; lastActivityAt: number };
  archived: { createdAt: number; lastActivityAt: number };
  gone: { createdAt: number; lastActivityAt: number };
  noCli: { createdAt: number; lastActivityAt: number };
}

/**
 * Writes the tree under `root`: <root>/Claude/claude-code-sessions/<acct>/<org>/local_*.json plus decoys, some
 * of them unreadable (mode 000) so that a reader that opened them would fail loudly.
 */
export function writeClaudeAppTree(root: string, times: AppTreeTimes, opts: { cwd?: string } = {}): AppTree {
  const claude = join(root, "Claude");
  const base = join(claude, "claude-code-sessions");
  const org = join(base, "acct-0001", "org-0001");
  const outside = join(root, "outside");
  for (const d of [org, outside, join(org, "sub"), join(outside, "linked-org")]) mkdirSync(d, { recursive: true });
  const cwd = opts.cwd ?? "/Users/you/code/app-project";
  const record = (fields: Record<string, unknown>) => JSON.stringify({ ...droppedFields(), ...fields });

  const allowed: string[] = [];
  const put = (name: string, text: string) => {
    const p = join(org, name);
    writeFileSync(p, text);
    allowed.push(p);
  };
  put(
    `${APP_IDS.linked}.json`,
    record({
      sessionId: APP_IDS.linked,
      cliSessionId: APP_LINKED,
      title: APP_TITLES.linked,
      titleSource: "auto",
      cwd,
      originCwd: cwd,
      ...times.linked,
      isArchived: false,
      model: "claude-opus-5-5",
      effort: "high",
    }),
  );
  put(
    `${APP_IDS.archived}.json`,
    record({ sessionId: APP_IDS.archived, cliSessionId: APP_ARCHIVED, title: APP_TITLES.archived, cwd, originCwd: cwd, ...times.archived, isArchived: true, model: "claude-sonnet-5-5" }),
  );
  put(
    `${APP_IDS.gone}.json`,
    record({ sessionId: APP_IDS.gone, cliSessionId: APP_GONE, title: APP_TITLES.gone, titleSource: "auto", cwd: "/Users/you/code/gone", originCwd: "/Users/you/code/gone", ...times.gone, isArchived: false, model: "claude-fable-5", effort: "xhigh" }),
  );
  put(
    `${APP_IDS.noCli}.json`,
    record({ sessionId: APP_IDS.noCli, title: APP_TITLES.noCli, cwd: "/Users/you/code/remote", originCwd: "/Users/you/code/remote", ...times.noCli, isArchived: true, model: "claude-opus-5", transcriptUnavailable: true }),
  );
  // Allowed names that hold nothing usable: counted as unreadable, never as sessions.
  put("local_20000000-0000-4000-8000-000000000005.json", record({ title: `${APP_CANARY} no session id` }));
  put("local_20000000-0000-4000-8000-000000000006.json", `{"sessionId": "local_x", "title": "${APP_CANARY} truncated`);

  const decoys: string[] = [];
  const locked: string[] = [];
  const decoy = (p: string, text: string) => {
    writeFileSync(p, text);
    chmodSync(p, 0o000);
    decoys.push(p);
    locked.push(p);
  };
  const secret = record({ sessionId: "local_30000000-0000-4000-8000-000000000009", title: `${APP_CANARY} decoy title`, createdAt: times.linked.createdAt });
  // The app's own credentials and settings next to the session list.
  decoy(join(claude, "config.json"), `{"oauth:tokenCache": "${APP_CANARY}"}`);
  decoy(join(claude, "Cookies"), APP_CANARY);
  decoy(join(base, "cookies.json"), secret);
  decoy(join(org, "token.json"), secret);
  decoy(join(org, "archived-sessions.idx"), APP_CANARY);
  decoy(join(org, "deleted_30000000-0000-4000-8000-000000000001"), secret);
  decoy(join(org, "scheduled-tasks.json"), secret);
  decoy(join(org, "local_30000000-0000-4000-8000-000000000002.json.bak"), secret);
  decoy(join(org, "local_with_underscore.json"), secret);
  decoy(join(org, "sub", "local_30000000-0000-4000-8000-000000000003.json"), secret);
  decoy(join(base, "acct-0001", "local_30000000-0000-4000-8000-000000000004.json"), secret);
  // A record name that is a symlink to a file outside the list, and a symlinked org folder.
  const target = join(outside, "secret.json");
  decoy(target, secret);
  const link = join(org, "local_30000000-0000-4000-8000-000000000005.json");
  symlinkSync(target, link);
  decoys.push(link);
  decoy(join(outside, "linked-org", "local_30000000-0000-4000-8000-000000000006.json"), secret);
  const linkedOrg = join(base, "acct-0001", "org-linked");
  symlinkSync(join(outside, "linked-org"), linkedOrg);
  decoys.push(linkedOrg);
  // A 2 MiB record (over the 1 MiB cap), and a folder named like a record.
  decoy(join(org, "local_30000000-0000-4000-8000-000000000007.json"), `${secret.slice(0, -1)}, "pad": "${"x".repeat(2 * 1024 * 1024)}"}`);
  const dirRecord = join(org, "local_30000000-0000-4000-8000-000000000008.json");
  mkdirSync(dirRecord);
  decoys.push(dirRecord);
  return { base, allowed, decoys, locked };
}

/** Undoes the mode-000 decoys so the temp dir can be removed. */
export function makeTreeRemovable(tree: AppTree): void {
  for (const p of tree.locked) chmodSync(p, 0o644);
}
