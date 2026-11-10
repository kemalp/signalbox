// signalbox-switch's `claude` shim (docs/SWITCH.md §3) picks the account from a pointer file. Signalbox's own
// `claude agents --json` must run the real binary instead, so every lookup of `claude` skips a file that carries the
// shim's marker on one of its first two lines. Reads at most 512 bytes of the candidate, nothing else.
import { closeSync, openSync, readSync } from "node:fs";

/** The second line of the shim starts with this (apps/macos/Sources/SignalboxSwitch/Scripts.swift). */
export const SWITCH_SHIM_MARKER = "# signalbox-switch shim";

export function isSwitchShim(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(512);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8").split("\n", 2).some((l) => l.startsWith(SWITCH_SHIM_MARKER));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
