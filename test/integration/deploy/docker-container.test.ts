import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { test } from "node:test";
import { startMockTechnitiumServer } from "../../support/mock-technitium-server.ts";

const SESSION_V15 = readFileSync("test/fixtures/session/session-get-v15.json", "utf8");

// `--network host` below only behaves like a native Linux docker daemon on
// an actual Linux host: Docker Desktop on macOS/Windows (and Colima) also
// report OSType "linux" from the daemon, but `--network host` there joins
// the VM's netns, not this host's — a free port picked on the host would
// then be unreachable from inside the container. process.platform, not the
// daemon's own OSType, is what actually distinguishes the two.
function dockerAvailable(): boolean {
  if (process.platform !== "linux") return false;
  try {
    execFileSync("docker", ["version"], { stdio: "ignore" });
    const osType = execFileSync("docker", ["info", "--format", "{{.OSType}}"], {
      encoding: "utf8",
    }).trim();
    return osType === "linux";
  } catch {
    return false;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

test("a real container reaches /readyz 200 against the mock server", {
  skip: dockerAvailable()
    ? false
    : "docker is not available, or is not configured for native Linux containers, in this environment",
  timeout: 180_000,
}, async (t) => {
  const mock = await startMockTechnitiumServer(SESSION_V15);

  const metricsPort = await freePort();
  const imageTag = `technitium-metrics-exporter-container-test:${process.pid}`;
  const containerName = `technitium-metrics-exporter-container-test-${process.pid}`;

  // Registered unconditionally, before any docker command, and sequenced
  // internally — not split across several t.after calls relying on
  // node:test's FIFO registration order, since a throw from `docker build`
  // or `docker run` below would then skip registering a later cleanup hook
  // entirely and leave the mock server's listener (and thus this test file's
  // process) alive forever instead of just leaking one image.
  t.after(async () => {
    try {
      execFileSync("docker", ["stop", containerName], { stdio: "ignore" });
    } catch {
      // never started, or already stopped/removed
    }
    try {
      execFileSync("docker", ["rmi", imageTag], { stdio: "ignore" });
    } catch {
      // never built
    }
    await mock.close();
  });

  execFileSync("docker", ["build", "-t", imageTag, "."], { stdio: "ignore" });

  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--rm",
      "--name",
      containerName,
      "--network",
      "host",
      "-e",
      `METRICS_PORT=${metricsPort}`,
      "-e",
      `TECHNITIUM_TARGETS=dns-a=${mock.baseUrl}`,
      "-e",
      "TECHNITIUM_API_TOKEN=test-token",
      imageTag,
    ],
    { stdio: "ignore" },
  );

  const deadline = Date.now() + 60_000;
  let lastStatus: number | undefined;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${metricsPort}/readyz`);
      lastStatus = res.status;
      if (res.status === 200) break;
    } catch {
      // container may not have bound the port yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  assert.equal(lastStatus, 200, "container never reached /readyz 200 against the mock server");

  // /readyz alone only proves the container started and completed a poll
  // cycle, even if every upstream call inside it failed — this proves the
  // cycle actually succeeded against the mock server's session/get stub.
  const metricsRes = await fetch(`http://127.0.0.1:${metricsPort}/metrics?target=dns-a`);
  assert.equal(metricsRes.status, 200);
  assert.match(await metricsRes.text(), /technitium_up 1/);
});
