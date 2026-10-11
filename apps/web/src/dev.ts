// Starts the server with synthetic data: `bun apps/web/src/dev.ts`.
// PORT=nnnn pins the port; MOCK=empty serves a machine with no sessions, limits or usage.
import { mockFleet, mockHealth, mockReport } from "./mock.ts";
import { startServer } from "./server.ts";

const empty = process.env.MOCK === "empty";

const server = await startServer({
  port: Number(process.env.PORT ?? 0),
  api: {
    report: async (q) => mockReport(empty ? { ...q, agent: "none" } : q),
    fleet: async () =>
      empty ? { generatedAt: new Date().toISOString(), sessions: [], limits: [], compactions: [], health: mockHealth() } : mockFleet(),
    health: async () => mockHealth(),
  },
});

console.log(`Signalbox (${empty ? "empty " : ""}mock data) running.\nOpen: ${server.url}`);

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, async () => {
    await server.stop();
    process.exit(0);
  });
}
