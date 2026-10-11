// Test listener for the spike's `$.http.fetch({ socketPath })` check (docs/SPIKE.md).
//
//   bun research/mods/spike-probe/listener.ts [socketPath] [--minutes N]
//
// Default socket: ~/Library/Application Support/signalbox/spike.sock (dir 0700, socket 0600).
// Answers GET /ping with a per-run nonce, so the probe's results prove it reached this process.
// Logs method, path and header names only. Stops after N idle minutes (default 30) or on Ctrl-C.
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const minutesAt = args.indexOf("--minutes");
const minutes = minutesAt >= 0 ? Number(args.splice(minutesAt, 2)[1]) : 30;
const socketPath = args[0] ?? join(homedir(), "Library/Application Support/signalbox/spike.sock");
if (!socketPath.startsWith("/") || Buffer.byteLength(socketPath) > 100) {
  console.error(`socket path must be absolute and at most 100 bytes: ${socketPath}`);
  process.exit(2);
}

mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
try {
  if (lstatSync(socketPath).isSocket()) unlinkSync(socketPath);
  else {
    console.error(`refusing to replace a non-socket file at ${socketPath}`);
    process.exit(2);
  }
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}

const nonce = crypto.randomUUID().slice(0, 8);
let idle: ReturnType<typeof setTimeout> | undefined;
const armIdle = () => {
  clearTimeout(idle);
  if (Number.isFinite(minutes) && minutes > 0) idle = setTimeout(() => stop(`idle for ${minutes} min`), minutes * 60_000);
};

const server = Bun.serve({
  unix: socketPath,
  fetch(req) {
    armIdle();
    const url = new URL(req.url);
    console.log(`${new Date().toISOString()} ${req.method} ${url.pathname} headers=[${[...req.headers.keys()].join(",")}]`);
    if (req.method !== "GET") return new Response("method not allowed\n", { status: 405 });
    if (url.pathname !== "/ping") return new Response("not found\n", { status: 404 });
    return Response.json({ ok: true, listener: "signalbox-spike", nonce, path: url.pathname, at: new Date().toISOString() });
  },
});
chmodSync(socketPath, 0o600);
armIdle();
console.log(`signalbox spike listener on ${socketPath}`);
console.log(`nonce ${nonce}  (the probe's httpSocket.reply.nonce must match)`);

function stop(why: string): void {
  console.log(`stopping: ${why}`);
  server.stop(true);
  try {
    unlinkSync(socketPath);
  } catch {}
  process.exit(0);
}
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
