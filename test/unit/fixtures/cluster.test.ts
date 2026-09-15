import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

interface ClusterNodeFixture {
  id: number;
  name: string;
  url: string;
  type: string;
  state: string;
  lastSeen: string;
}

interface ClusterStateFixture {
  clusterInitialized: boolean;
  dnsServerDomain: string;
  version: string;
  clusterDomain: string;
  heartbeatRefreshIntervalSeconds: number;
  heartbeatRetryIntervalSeconds: number;
  configRefreshIntervalSeconds: number;
  configLastSynced: string;
  nodes: ClusterNodeFixture[];
}

const fixturePath = join(
  import.meta.dirname,
  "..",
  "..",
  "fixtures",
  "cluster",
  "cluster-state.json",
);

function loadFixture(): ClusterStateFixture {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    response: ClusterStateFixture;
  };
  return fixture.response;
}

function loadNodes(): ClusterNodeFixture[] {
  return loadFixture().nodes;
}

describe("cluster/state fixture", () => {
  it("includes a peer in the Unknown state", () => {
    const nodes = loadNodes();
    assert.ok(nodes.some((n) => n.state === "Unknown"));
  });

  it("includes a peer using the never-sentinel lastSeen, with no Z suffix", () => {
    const nodes = loadNodes();
    const sentinelPeer = nodes.find((n) => n.lastSeen === "0001-01-01T00:00:00");
    assert.ok(sentinelPeer !== undefined);
    assert.equal(sentinelPeer?.lastSeen.endsWith("Z"), false);
  });

  it("gives every non-sentinel lastSeen a trailing Z, per real captured behaviour", () => {
    const nodes = loadNodes();
    for (const node of nodes) {
      if (node.lastSeen === "0001-01-01T00:00:00") continue;
      assert.ok(node.lastSeen.endsWith("Z"), `${node.name} lastSeen missing Z suffix`);
    }
  });

  it("covers both Primary and Secondary peer types", () => {
    const nodes = loadNodes();
    const types = new Set(nodes.map((n) => n.type));
    assert.ok(types.has("Primary"));
    assert.ok(types.has("Secondary"));
  });

  it("covers Self, Connected and Unreachable states alongside Unknown", () => {
    const nodes = loadNodes();
    const states = new Set(nodes.map((n) => n.state));
    for (const state of ["Unknown", "Self", "Connected", "Unreachable"]) {
      assert.ok(states.has(state), `missing cluster state ${state}`);
    }
  });

  it("gives every node an id, name and url, and never a peer IP field", () => {
    const nodes = loadNodes();
    for (const node of nodes) {
      assert.equal(typeof node.id, "number");
      assert.ok(node.name.length > 0);
      assert.ok(node.url.length > 0);
      assert.equal(Object.hasOwn(node, "ipAddress"), false);
      assert.equal(Object.hasOwn(node, "ipAddresses"), false);
    }
  });

  it("exposes cluster-wide identity and config sync fields under the real field names", () => {
    const fixture = loadFixture();
    assert.equal(typeof fixture.clusterInitialized, "boolean");
    assert.equal(typeof fixture.dnsServerDomain, "string");
    assert.equal(typeof fixture.version, "string");
    assert.equal(typeof fixture.clusterDomain, "string");
    assert.equal(typeof fixture.configLastSynced, "string");
  });

  it("exposes only the three interval fields DESIGN.md's cluster metrics list covers, under their real seconds-suffixed names", () => {
    const fixture = loadFixture() as unknown as Record<string, unknown>;
    assert.equal(typeof fixture.heartbeatRefreshIntervalSeconds, "number");
    assert.equal(typeof fixture.heartbeatRetryIntervalSeconds, "number");
    assert.equal(typeof fixture.configRefreshIntervalSeconds, "number");
    assert.equal(Object.hasOwn(fixture, "configRetryIntervalSeconds"), false);
  });

  it("reports interval values on a plausible seconds scale, not a millisecond scale", () => {
    const fixture = loadFixture();
    for (const seconds of [
      fixture.heartbeatRefreshIntervalSeconds,
      fixture.heartbeatRetryIntervalSeconds,
      fixture.configRefreshIntervalSeconds,
    ]) {
      assert.ok(
        seconds < 3600,
        `interval value ${seconds} looks millisecond-scale, not seconds-scale`,
      );
    }
  });
});
