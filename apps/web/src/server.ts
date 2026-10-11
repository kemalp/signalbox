// Localhost HTTP server for the Signalbox page and its JSON API.
//
// Security model (see CLAUDE.md): bind 127.0.0.1 only, a per-run bearer token on every /api/*
// request, exact Host and Origin checks, GET/HEAD only, no CORS headers, no cookies.
//
// Bun's HTML-import routes can't carry custom response headers, so the bundled page is served
// by a private inner server on a unix socket (in a 0700 temp dir) and proxied through the
// outer server, which applies the checks and headers above to every response.
import page from "./index.html";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterHealth, FleetSnapshot, Report } from "@signalbox/core";

/**
 * Fields /api/fleet sessions carry beyond core's FleetSession. Proposed for the contract
 * (FleetSession in core/types.ts); kept here until then.
 */
export interface FleetSessionExtras {
  /** Tokens of this session whose model has no price row, so `costUsd` leaves them out (counted at $0). */
  unpricedTokens?: number;
}

export interface ReportQuery {
  days: number;
  agent?: string;
}

export interface SignalboxApi {
  report(q: ReportQuery): Promise<Report>;
  fleet(): Promise<FleetSnapshot>;
  health(): Promise<AdapterHealth[]>;
}

export interface ServerOptions {
  /** 0 or omitted picks a random free port. */
  port?: number;
  /** Defaults to 32 random bytes, base64url. */
  token?: string;
  api: SignalboxApi;
}

export interface RunningServer {
  /** http://127.0.0.1:PORT/#token=... — the page reads the token from the fragment and strips it. */
  url: string;
  port: number;
  token: string;
  stop(): Promise<void>;
}

export const HOSTNAME = "127.0.0.1";
export const DEFAULT_DAYS = 7;
export const MAX_DAYS = 365;

export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const BASE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const TOKEN_RE = /^[A-Za-z0-9._~+/=-]+$/;
const AGENT_RE = /^[A-Za-z0-9._-]{1,64}$/;
// Bundled assets are flat, hashed files at the root (e.g. /chunk-1a2b3c.js).
const ASSET_RE = /^\/(?:[A-Za-z0-9][A-Za-z0-9._-]{0,127})?$/;

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Clamp `days` to 1..365; missing or non-numeric → 7. */
export function parseDays(raw: string | null): number {
  if (raw === null || raw.trim() === "") return DEFAULT_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.max(1, Math.floor(n)));
}

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

/** Constant-time comparison (hashing first makes the inputs equal length). */
export function tokenMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}

function respond(status: number, body: BodyInit | null, headers: Record<string, string>, head: boolean): Response {
  return new Response(head ? null : body, { status, headers: { ...BASE_HEADERS, ...headers } });
}

function json(status: number, data: unknown, head = false, extra: Record<string, string> = {}): Response {
  return respond(
    status,
    JSON.stringify(data),
    {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      ...extra,
    },
    head,
  );
}

function text(status: number, message: string, head = false, extra: Record<string, string> = {}): Response {
  return respond(
    status,
    message,
    { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extra },
    head,
  );
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const token = opts.token ?? generateToken();
  if (token.length < 16 || !TOKEN_RE.test(token)) {
    throw new Error("startServer: token must be at least 16 URL-safe characters");
  }
  const { api } = opts;

  const sockDir = mkdtempSync(join(tmpdir(), "signalbox-"));
  const sockPath = join(sockDir, "ui.sock");
  // Remove the socket dir on any normal exit, even if stop() is never called. (SIGKILL can't be caught.)
  const cleanup = () => rmSync(sockDir, { recursive: true, force: true });
  process.once("exit", cleanup);
  let inner: ReturnType<typeof Bun.serve>;
  try {
    inner = Bun.serve({
      unix: sockPath,
      development: false,
      routes: { "/": page },
      fetch: () => new Response("Not found", { status: 404 }),
    });
  } catch (err) {
    process.removeListener("exit", cleanup);
    cleanup();
    throw err;
  }

  let allowedHosts = new Set<string>();
  let allowedOrigins = new Set<string>();

  async function handleApi(req: Request, url: URL, head: boolean): Promise<Response> {
    const authz = req.headers.get("authorization") ?? "";
    const m = /^Bearer +(\S+)$/i.exec(authz);
    if (!m || !tokenMatches(m[1]!, token)) {
      return json(401, { error: "unauthorized" }, head, { "WWW-Authenticate": 'Bearer realm="signalbox"' });
    }
    const route = url.pathname;
    try {
      if (route === "/api/report") {
        const days = parseDays(url.searchParams.get("days"));
        const agentRaw = url.searchParams.get("agent");
        if (agentRaw !== null && agentRaw !== "" && !AGENT_RE.test(agentRaw)) {
          return json(400, { error: "invalid agent" }, head);
        }
        const q: ReportQuery = agentRaw ? { days, agent: agentRaw } : { days };
        return json(200, await api.report(q), head);
      }
      if (route === "/api/fleet") return json(200, await api.fleet(), head);
      if (route === "/api/health") return json(200, await api.health(), head);
    } catch (err) {
      console.error(`signalbox: ${route} failed:`, err instanceof Error ? err.message : err);
      return json(500, { error: "internal error" }, head);
    }
    return json(404, { error: "not found" }, head);
  }

  async function handleAsset(url: URL, head: boolean): Promise<Response> {
    if (!ASSET_RE.test(url.pathname)) return text(404, "Not found", head);
    let upstream: Response;
    try {
      upstream = await fetch(`http://localhost${url.pathname}`, { unix: sockPath });
    } catch (err) {
      console.error("signalbox: page bundle unavailable:", err instanceof Error ? err.message : err);
      return text(502, "Page bundle unavailable", head);
    }
    if (!upstream.ok) {
      await upstream.body?.cancel();
      return text(upstream.status === 404 ? 404 : 502, upstream.status === 404 ? "Not found" : "Page bundle error", head);
    }
    const isPage = url.pathname === "/";
    const headers: Record<string, string> = {
      "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "Cache-Control": isPage ? "no-store" : (upstream.headers.get("cache-control") ?? "no-cache"),
    };
    const etag = upstream.headers.get("etag");
    if (etag && !isPage) headers.ETag = etag;
    if (isPage) headers["Content-Security-Policy"] = PAGE_CSP;
    const body = await upstream.arrayBuffer();
    return respond(200, body, headers, head);
  }

  async function handle(req: Request): Promise<Response> {
    const host = req.headers.get("host")?.toLowerCase();
    if (!host || !allowedHosts.has(host)) return text(421, "Misdirected request");
    const origin = req.headers.get("origin");
    if (origin !== null && !allowedOrigins.has(origin)) return text(403, "Forbidden");
    const head = req.method === "HEAD";
    if (req.method !== "GET" && !head) return text(405, "Method not allowed", false, { Allow: "GET, HEAD" });
    const url = new URL(req.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return handleApi(req, url, head);
    return handleAsset(url, head);
  }

  let outer: ReturnType<typeof Bun.serve>;
  try {
    outer = Bun.serve({
      hostname: HOSTNAME,
      port: opts.port ?? 0,
      // Explicit: with development:false, Bun 1.4.2 sets SO_REUSEPORT despite the documented default,
      // which lets another local process bind the same port and take over new connections (and the token).
      reusePort: false,
      development: false,
      fetch: handle,
      error(err) {
        console.error("signalbox: request failed:", err.message);
        return text(500, "Internal error");
      },
    });
  } catch (err) {
    await inner.stop(true);
    process.removeListener("exit", cleanup);
    cleanup();
    throw err;
  }

  const port = outer.port as number;
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  // Build the page bundle now so the first browser load is fast and build errors surface early.
  try {
    const warm = await fetch("http://localhost/", { unix: sockPath });
    if (!warm.ok) console.error(`signalbox: page bundle returned HTTP ${warm.status}`);
    await warm.arrayBuffer();
  } catch (err) {
    console.error("signalbox: page bundle failed to build:", err instanceof Error ? err.message : err);
  }

  let stopped = false;
  return {
    url: `http://${HOSTNAME}:${port}/#token=${token}`,
    port,
    token,
    async stop() {
      if (stopped) return;
      stopped = true;
      await outer.stop(true);
      await inner.stop(true);
      process.removeListener("exit", cleanup);
      cleanup();
    },
  };
}
