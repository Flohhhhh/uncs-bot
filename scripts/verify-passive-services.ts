import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import net from "node:net";
import { ROOT } from "./utils/scripts.constants";

/** Only the disposable storage-test database is accepted; injected production configuration is never inherited. */
const databasePort = process.env.UNCS_TEST_POSTGRES_PORT;
assert(databasePort && /^\d+$/.test(databasePort), "Supply the disposable loopback PostgreSQL test port.");
async function freePort() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function check(app: "api" | "bot", extra: Record<string, string>) {
  const port = await freePort();
  const child = spawn(process.execPath, ["dist/main.js"], {
    cwd: path.join(ROOT, "apps", app),
    env: { PATH: process.env.PATH, NODE_ENV: "production", NEST_ENV: "production", PORT: String(port), ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostic = "";
  child.stdout.on("data", (value) => (diagnostic += String(value)));
  child.stderr.on("data", (value) => (diagnostic += String(value)));
  try {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`${app} passive startup failed: ${diagnostic}`);
      try {
        response = await fetch(`http://127.0.0.1:${port}/health/ready`, { signal: AbortSignal.timeout(500) });
        if (response.ok) break;
      } catch {
        /* Only bounded readiness probes are repeated; operational requests are never retried. */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(response?.status, 200);
    assert.equal((await response!.json()).status, "passive");
    assert.equal((await fetch(`http://127.0.0.1:${port}/health/live`)).status, 200);
    const operation = app === "api" ? "welcome/settings" : "weekly/render";
    const refused = await fetch(`http://127.0.0.1:${port}/internal/v1/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(refused.status, app === "api" ? 403 : 401);
    assert.equal(child.exitCode, null);
    console.info(`${app}: compiled passive startup, readiness and disabled operations passed.`);
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(timeout);
    }
  }
}
async function main() {
  await check("api", {
    DATABASE_URL: `postgresql://uncs_launch_test:uncs_launch_test@127.0.0.1:${databasePort}/uncs_launch_test`,
    DISCORD_BOT_TOKEN: "simulation-only",
    ADMIN_ENABLED: "false",
    API_WORKERS_ENABLED: "false",
    API_MUTATIONS_ENABLED: "false",
  });
  await check("bot", { BOT_GATEWAY_ENABLED: "false" });
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
