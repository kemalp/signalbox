import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { networkInterfaces } from "node:os";
import { connect } from "node:net";
import { mockFleet, mockHealth, mockReport } from "../src/mock.ts";
import { parseDays, startServer, tokenMatches, type ReportQuery, type RunningServer } from "../src/server.ts";

let srv: RunningServer;
const reportCalls: ReportQuery[] = [];
let failNext = false;

beforeAll(async () => {
  srv = await startServer({
    api: {
      report: async (q) => {
        reportCalls.push(q);
        if (failNext) {
          failNext = false;
          throw new Error("boom /secret/path");
        }
        return mockReport(q);
      },
      fleet: async () => mockFleet(),
      health: async () => mockHealth(),
    },
  });
});

afterAll(async () => {
  await srv.stop();
});

const base = () => `http://127.0.0.1:${srv.port}`;
const auth = () => ({ Authorization: `Bearer ${srv.token}` });

function noCors(res: Response) {
  const cors = [...res.headers.keys()].filter((k) => k.toLowerCase().startsWith("access-control-"));
  expect(cors).toEqual([]);
}

/** Resolves true if a TCP connection to host:port succeeds. */
function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port, timeout: 1500 });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
    sock.once("timeout", () => {
      sock.destroy();
      resolve(false);
    });
  });
}

describe("startServer", () => {
  test("returns a 127.0.0.1 URL carrying the token in the fragment", () => {
    expect(srv.port).toBeGreaterThan(0);
    expect(srv.url).toBe(`http://127.0.0.1:${srv.port}/#token=${srv.token}`);
    // 32 random bytes, base64url
    expect(srv.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("binds 127.0.0.1 only", async () => {
    expect(await canConnect("127.0.0.1", srv.port)).toBe(true);
    expect(await canConnect("::1", srv.port)).toBe(false);
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal);
    if (lan) expect(await canConnect(lan.address, srv.port)).toBe(false);
  });

  test("another process can't bind the same port with SO_REUSEPORT", async () => {
    const code = `try { Bun.serve({ hostname: "127.0.0.1", port: ${srv.port}, reusePort: true, fetch: () => new Response("hijack") }); console.log("bound"); } catch (e) { console.log(e.code ?? "error"); } process.exit(0);`;
    const proc = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    expect(out).toBe("EADDRINUSE");
  });

  test("uses a provided token and rejects weak ones", async () => {
    const token = "a-very-long-test-token-0123456789";
    const s = await startServer({
      token,
      api: { report: async (q) => mockReport(q), fleet: async () => mockFleet(), health: async () => mockHealth() },
    });
    try {
      expect(s.token).toBe(token);
      const ok = await fetch(`http://127.0.0.1:${s.port}/api/health`, { headers: { Authorization: `Bearer ${token}` } });
      expect(ok.status).toBe(200);
    } finally {
      await s.stop();
    }
    const noop = { report: async (q: ReportQuery) => mockReport(q), fleet: async () => mockFleet(), health: async () => mockHealth() };
    await expect(startServer({ token: "short", api: noop })).rejects.toThrow();
    await expect(startServer({ token: "has spaces in it, long enough", api: noop })).rejects.toThrow();
  });

  test("stop() closes the port", async () => {
    const s = await startServer({
      api: { report: async (q) => mockReport(q), fleet: async () => mockFleet(), health: async () => mockHealth() },
    });
    const port = s.port;
    await s.stop();
    await s.stop(); // idempotent
    expect(await canConnect("127.0.0.1", port)).toBe(false);
  });
});

describe("auth", () => {
  for (const path of ["/api/report", "/api/fleet", "/api/health", "/api/nope"]) {
    test(`401 without a token: ${path}`, async () => {
      const res = await fetch(base() + path);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
      expect(await res.json()).toEqual({ error: "unauthorized" });
      noCors(res);
    });
  }

  test("401 with a wrong or malformed token", async () => {
    const wrong = [
      `Bearer ${srv.token}x`,
      `Bearer ${srv.token.slice(0, -1)}`,
      "Bearer ",
      `Basic ${srv.token}`,
      srv.token,
      `bearer${srv.token}`,
    ];
    for (const header of wrong) {
      const res = await fetch(`${base()}/api/fleet`, { headers: { Authorization: header } });
      expect(res.status).toBe(401);
    }
  });

  test("token in the query string is not accepted", async () => {
    const res = await fetch(`${base()}/api/fleet?token=${srv.token}`);
    expect(res.status).toBe(401);
  });

  test("tokenMatches is exact", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abc", "abd")).toBe(false);
    expect(tokenMatches("abc", "abcd")).toBe(false);
    expect(tokenMatches("", "abc")).toBe(false);
  });
});

describe("api", () => {
  test("200 with the token, JSON with no-store and nosniff", async () => {
    for (const path of ["/api/report?days=7", "/api/fleet", "/api/health"]) {
      const res = await fetch(base() + path, { headers: auth() });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("set-cookie")).toBeNull();
      noCors(res);
      await res.json();
    }
  });

  test("returns what the api gave", async () => {
    const fleet = (await (await fetch(`${base()}/api/fleet`, { headers: auth() })).json()) as { sessions: unknown[] };
    expect(fleet.sessions.length).toBe(5);
    const health = (await (await fetch(`${base()}/api/health`, { headers: auth() })).json()) as unknown[];
    expect(health).toEqual(mockHealth());
  });

  test("days is clamped to 1..365 and defaults to 7", async () => {
    const cases: Array<[string, number]> = [
      ["days=0", 1],
      ["days=-5", 1],
      ["days=1", 1],
      ["days=30", 30],
      ["days=7.9", 7],
      ["days=365", 365],
      ["days=9999", 365],
      ["days=1e9", 365],
      ["days=abc", 7],
      ["days=", 7],
      ["", 7],
    ];
    for (const [qs, want] of cases) {
      reportCalls.length = 0;
      const res = await fetch(`${base()}/api/report?${qs}`, { headers: auth() });
      expect(res.status).toBe(200);
      expect(reportCalls).toEqual([{ days: want }]);
    }
  });

  test("agent is passed through and validated", async () => {
    reportCalls.length = 0;
    const ok = await fetch(`${base()}/api/report?days=30&agent=codex`, { headers: auth() });
    expect(ok.status).toBe(200);
    expect(reportCalls).toEqual([{ days: 30, agent: "codex" }]);
    const bad = await fetch(`${base()}/api/report?agent=${encodeURIComponent("../etc")}`, { headers: auth() });
    expect(bad.status).toBe(400);
  });

  test("parseDays", () => {
    expect(parseDays(null)).toBe(7);
    expect(parseDays("0")).toBe(1);
    expect(parseDays("400")).toBe(365);
    expect(parseDays("Infinity")).toBe(7);
  });

  test("errors return a generic 500 without details", async () => {
    failNext = true;
    const res = await fetch(`${base()}/api/report`, { headers: auth() });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("secret");
    expect(JSON.parse(text)).toEqual({ error: "internal error" });
  });

  test("unknown api path is 404 after auth", async () => {
    const res = await fetch(`${base()}/api/nope`, { headers: auth() });
    expect(res.status).toBe(404);
  });

  test("HEAD returns headers without a body", async () => {
    const res = await fetch(`${base()}/api/fleet`, { method: "HEAD", headers: auth() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await res.text()).toBe("");
  });
});

describe("host and origin checks", () => {
  test("421 for a Host that isn't 127.0.0.1:PORT or localhost:PORT", async () => {
    const bad = ["evil.example", `evil.example:${srv.port}`, `127.0.0.1:${srv.port + 1}`, "127.0.0.1", `0.0.0.0:${srv.port}`, `[::1]:${srv.port}`];
    for (const host of bad) {
      for (const path of ["/api/fleet", "/"]) {
        const res = await fetch(base() + path, { headers: { ...auth(), Host: host } });
        expect(res.status).toBe(421);
        noCors(res);
      }
    }
  });

  test("localhost:PORT is an accepted Host", async () => {
    const res = await fetch(`${base()}/api/fleet`, { headers: { ...auth(), Host: `localhost:${srv.port}` } });
    expect(res.status).toBe(200);
  });

  test("403 for a foreign Origin, even with the token", async () => {
    const bad = ["http://evil.example", "null", `http://127.0.0.1:${srv.port + 1}`, `https://127.0.0.1:${srv.port}`, `http://localhost.evil.example:${srv.port}`];
    for (const origin of bad) {
      const res = await fetch(`${base()}/api/fleet`, { headers: { ...auth(), Origin: origin } });
      expect(res.status).toBe(403);
      noCors(res);
    }
  });

  test("same Origin is accepted", async () => {
    for (const origin of [`http://127.0.0.1:${srv.port}`, `http://localhost:${srv.port}`]) {
      const res = await fetch(`${base()}/api/fleet`, { headers: { ...auth(), Origin: origin } });
      expect(res.status).toBe(200);
      noCors(res);
    }
  });
});

describe("methods", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    test(`405 for ${method}`, async () => {
      for (const path of ["/api/fleet", "/"]) {
        const res = await fetch(base() + path, {
          method,
          headers: { ...auth(), "Access-Control-Request-Method": "GET", Origin: base() },
          ...(method === "POST" || method === "PUT" || method === "PATCH" ? { body: "{}" } : {}),
        });
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("GET, HEAD");
        noCors(res);
      }
    });
  }
});

describe("page", () => {
  test("serves the page without a token, with a strict CSP", async () => {
    const res = await fetch(`${base()}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    noCors(res);
    const html = await res.text();
    expect(html).toContain("<title>Signalbox</title>");
    // No inline scripts: every <script> has a src.
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1] ?? "");
    expect(scripts.length).toBeGreaterThan(0);
    for (const attrs of scripts) expect(attrs).toMatch(/\bsrc="/);
  });

  test("bundled assets load with nosniff and the right types", async () => {
    const html = await (await fetch(`${base()}/`)).text();
    const paths = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]!);
    expect(paths.some((p) => p.endsWith(".js"))).toBe(true);
    expect(paths.some((p) => p.endsWith(".css"))).toBe(true);
    for (const p of paths) {
      const res = await fetch(base() + p);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      noCors(res);
      if (p.endsWith(".js")) expect(res.headers.get("content-type")).toContain("javascript");
      if (p.endsWith(".css")) expect(res.headers.get("content-type")).toContain("text/css");
      await res.arrayBuffer();
    }
  });

  test("unknown and odd paths are 404", async () => {
    for (const path of ["/nope.js", "/index.html", "/a/b", "/.env", "/%2e%2e/etc/passwd"]) {
      const res = await fetch(base() + path);
      expect(res.status).toBe(404);
    }
  });
});

describe("cleanup", () => {
  test("stop() removes the private socket dir and its exit hook", async () => {
    const { readdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const before = new Set(readdirSync(tmpdir()).filter((n) => /^signalbox-[A-Za-z0-9]{6}$/.test(n)));
    const listeners = process.listenerCount("exit");
    const s = await startServer({
      api: { report: async (q) => mockReport(q), fleet: async () => mockFleet(), health: async () => mockHealth() },
    });
    const created = readdirSync(tmpdir()).filter((n) => /^signalbox-[A-Za-z0-9]{6}$/.test(n) && !before.has(n));
    // Other processes may create their own dirs concurrently, so only require that ours went away.
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(process.listenerCount("exit")).toBe(listeners + 1);
    await s.stop();
    const still = new Set(readdirSync(tmpdir()));
    expect(created.some((n) => !still.has(n))).toBe(true);
    expect(process.listenerCount("exit")).toBe(listeners);
  });
});
