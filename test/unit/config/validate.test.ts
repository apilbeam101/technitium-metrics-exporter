import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseEnvFile } from "../../../src/config/load.ts";
import { ConfigError, validate } from "../../../src/config/validate.ts";

type EnvVars = Record<string, string | undefined>;

function baseVars(overrides: EnvVars = {}): EnvVars {
  return {
    TECHNITIUM_TARGETS: "dns-a=https://dns-a.example.com:53443",
    TECHNITIUM_API_TOKEN: "base-token",
    ...overrides,
  };
}

describe("validate — targets", () => {
  it("accepts a single target using the base token", () => {
    const { config } = validate(baseVars());
    assert.equal(config.targets.length, 1);
    assert.equal(config.targets[0]?.name, "dns-a");
    assert.equal(config.targets[0]?.baseUrl, "https://dns-a.example.com:53443");
    assert.equal(config.targets[0]?.apiToken.reveal(), "base-token");
  });

  it("accepts multiple targets", () => {
    const { config } = validate(
      baseVars({
        TECHNITIUM_TARGETS:
          "dns-a=https://dns-a.example.com:53443,dns-b=https://dns-b.example.com:53443",
      }),
    );
    assert.equal(config.targets.length, 2);
    assert.deepEqual(
      config.targets.map((t) => t.name),
      ["dns-a", "dns-b"],
    );
  });

  it("a per-target token override takes precedence over the base token", () => {
    const { config } = validate(baseVars({ TECHNITIUM_API_TOKEN__DNS_A: "override-token" }));
    assert.equal(config.targets[0]?.apiToken.reveal(), "override-token");
  });

  it("an explicitly empty per-target override is treated as unset and falls back to the base value", () => {
    const { config } = validate(baseVars({ TECHNITIUM_API_TOKEN__DNS_A: "" }));
    assert.equal(config.targets[0]?.apiToken.reveal(), "base-token");
  });

  it("a per-target CA bundle path override takes precedence over the base path", () => {
    const { config } = validate(
      baseVars({
        TECHNITIUM_CA_BUNDLE_PATH: "/etc/base-ca.pem",
        TECHNITIUM_CA_BUNDLE_PATH__DNS_A: "/etc/dns-a-ca.pem",
      }),
    );
    assert.equal(config.targets[0]?.caBundlePath, "/etc/dns-a-ca.pem");
  });

  it("TECHNITIUM_TARGETS is required", () => {
    assert.throws(() => validate({ TECHNITIUM_API_TOKEN: "base-token" }), ConfigError);
  });

  it("rejects an empty entry in TECHNITIUM_TARGETS", () => {
    assert.throws(
      () =>
        validate(
          baseVars({
            TECHNITIUM_TARGETS: "dns-a=https://dns-a.example.com:53443,,dns-b=https://b",
          }),
        ),
      /TECHNITIUM_TARGETS contains an empty entry/,
    );
  });

  it("rejects a malformed target entry with no name=url separator", () => {
    assert.throws(
      () => validate(baseVars({ TECHNITIUM_TARGETS: "not-a-valid-entry" })),
      /not in the form name=url/,
    );
  });

  it("rejects an invalid target name", () => {
    assert.throws(
      () => validate(baseVars({ TECHNITIUM_TARGETS: "-bad-name=https://dns-a.example.com" })),
      /target name "-bad-name" is invalid/,
    );
  });

  it("rejects a target with a malformed base URL", () => {
    assert.throws(
      () => validate(baseVars({ TECHNITIUM_TARGETS: "dns-a=not-a-url" })),
      /invalid base URL/,
    );
  });

  it("rejects duplicate target names", () => {
    assert.throws(
      () =>
        validate(
          baseVars({
            TECHNITIUM_TARGETS:
              "dns-a=https://dns-a.example.com:53443,dns-a=https://dns-a2.example.com:53443",
          }),
        ),
      /duplicate target name "dns-a"/,
    );
  });

  it("rejects duplicate target names that differ only by case", () => {
    assert.throws(
      () =>
        validate(
          baseVars({
            TECHNITIUM_TARGETS:
              "dns-a=https://dns-a.example.com:53443,DNS-A=https://dns-a2.example.com:53443",
          }),
        ),
      /duplicate target name "DNS-A"/,
    );
  });

  it("rejects two target names that collide on the same override suffix", () => {
    assert.throws(
      () =>
        validate(
          baseVars({
            TECHNITIUM_TARGETS:
              "dns-a=https://dns-a.example.com:53443,dns_a=https://dns-a2.example.com:53443",
          }),
        ),
      /both resolve.*override suffix/,
    );
  });

  it("rejects an override suffix that matches no configured target — the orphan-override error", () => {
    assert.throws(
      () => validate(baseVars({ TECHNITIUM_API_TOKEN__NOPE: "token" })),
      /TECHNITIUM_API_TOKEN__NOPE does not match any configured target/,
    );
  });

  it("rejects a case-mismatched override key for a real target, suggesting the exact fix", () => {
    assert.throws(
      () => validate(baseVars({ technitium_api_token__DNS_A: "override-token" })),
      /technitium_api_token__DNS_A does not match any configured target override — did you mean "TECHNITIUM_API_TOKEN__DNS_A"/,
    );
  });

  it("rejects a wrong-case suffix for a real target rather than silently ignoring it", () => {
    assert.throws(
      () => validate(baseVars({ TECHNITIUM_API_TOKEN__dns_a: "override-token" })),
      /did you mean "TECHNITIUM_API_TOKEN__DNS_A"/,
    );
  });

  it("does not report a false orphan-override error for a target that failed its own URL validation", () => {
    try {
      validate(
        baseVars({
          TECHNITIUM_TARGETS: "dns-a=not-a-url",
          TECHNITIUM_API_TOKEN__DNS_A: "override-token",
        }),
      );
      assert.fail("expected validate to throw");
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /invalid base URL/);
      assert.doesNotMatch(error.message, /does not match any configured target/);
    }
  });

  it("requires an API token per target, from either the base or an override", () => {
    assert.throws(
      () =>
        validate({
          TECHNITIUM_TARGETS: "dns-a=https://dns-a.example.com:53443",
        }),
      /target "dns-a" has no API token/,
    );
  });

  it("reports a missing token independently for every affected target", () => {
    try {
      validate({
        TECHNITIUM_TARGETS:
          "dns-a=https://dns-a.example.com:53443,dns-b=https://dns-b.example.com:53443",
      });
      assert.fail("expected validate to throw");
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /target "dns-a" has no API token/);
      assert.match(error.message, /target "dns-b" has no API token/);
    }
  });
});

describe("validate — TLS skip-verify", () => {
  it("defaults to false and produces no warning", () => {
    const { config, warnings } = validate(baseVars());
    assert.equal(config.targets[0]?.tlsInsecureSkipVerify, false);
    assert.equal(warnings.length, 0);
  });

  it("a per-target override to true is reflected in config and produces a warning naming the target", () => {
    const { config, warnings } = validate(
      baseVars({ TECHNITIUM_TLS_INSECURE_SKIP_VERIFY__DNS_A: "true" }),
    );
    assert.equal(config.targets[0]?.tlsInsecureSkipVerify, true);
    assert.equal(warnings[0], "TLS certificate verification disabled for target(s): dns-a");
  });

  it("a base override applies to every target and names them all in the warning", () => {
    const { config, warnings } = validate(
      baseVars({
        TECHNITIUM_TARGETS:
          "dns-a=https://dns-a.example.com:53443,dns-b=https://dns-b.example.com:53443",
        TECHNITIUM_TLS_INSECURE_SKIP_VERIFY: "true",
      }),
    );
    assert.ok(config.targets.every((t) => t.tlsInsecureSkipVerify));
    assert.equal(warnings[0], "TLS certificate verification disabled for target(s): dns-a, dns-b");
  });

  it("rejects a non-boolean value", () => {
    assert.throws(
      () => validate(baseVars({ TECHNITIUM_TLS_INSECURE_SKIP_VERIFY: "yes" })),
      /must be "true" or "false"/,
    );
  });
});

describe("validate — behavioural scalars", () => {
  it("applies documented defaults", () => {
    const { config } = validate(baseVars());
    assert.equal(config.metricsPort, 10053);
    assert.equal(config.metricsBindAddress, "0.0.0.0");
    assert.equal(config.pollIntervalSeconds, 30);
    assert.equal(config.clusterPollIntervalSeconds, 60);
    assert.equal(config.statsPollIntervalSeconds, 300);
    assert.equal(config.requestTimeoutSeconds, 15);
    assert.equal(config.enableClusterCollector, false);
    assert.equal(config.enableStatsCollector, false);
    assert.equal(config.enableStatsQueryTypes, false);
    assert.equal(config.zonesIncludeInternal, false);
    assert.equal(config.enableDefaultMetrics, true);
    assert.equal(config.logLevel, "info");
    assert.equal(config.logFormat, "json");
    assert.equal(config.metricsTls, undefined);
  });

  it("rejects a non-integer METRICS_PORT", () => {
    assert.throws(
      () => validate(baseVars({ METRICS_PORT: "not-a-number" })),
      /must be a positive integer/,
    );
  });

  it("rejects a METRICS_PORT out of range", () => {
    assert.throws(
      () => validate(baseVars({ METRICS_PORT: "70000" })),
      /must be between 1 and 65535/,
    );
  });

  it("rejects a POLL_INTERVAL_SECONDS above the upper bound", () => {
    assert.throws(
      () => validate(baseVars({ POLL_INTERVAL_SECONDS: "86401" })),
      /must be between 1 and 86400/,
    );
  });

  it("rejects a CLUSTER_POLL_INTERVAL_SECONDS above the upper bound", () => {
    assert.throws(
      () => validate(baseVars({ CLUSTER_POLL_INTERVAL_SECONDS: "86401" })),
      /must be between 1 and 86400/,
    );
  });

  it("rejects a STATS_POLL_INTERVAL_SECONDS above the upper bound", () => {
    assert.throws(
      () => validate(baseVars({ STATS_POLL_INTERVAL_SECONDS: "86401" })),
      /must be between 1 and 86400/,
    );
  });

  it("rejects a REQUEST_TIMEOUT_SECONDS above the upper bound", () => {
    assert.throws(
      () => validate(baseVars({ REQUEST_TIMEOUT_SECONDS: "3601" })),
      /must be between 1 and 3600/,
    );
  });

  it("rejects an interval so large it would overflow a 32-bit timer", () => {
    assert.throws(
      () => validate(baseVars({ POLL_INTERVAL_SECONDS: "99999999999999999999" })),
      /must be between 1 and 86400/,
    );
  });

  it("rejects an invalid LOG_LEVEL", () => {
    assert.throws(
      () => validate(baseVars({ LOG_LEVEL: "verbose" })),
      /LOG_LEVEL must be one of debug, info, warn, error/,
    );
  });

  it("accepts LOG_LEVEL case-insensitively, normalising to the canonical casing", () => {
    const { config } = validate(baseVars({ LOG_LEVEL: "INFO" }));
    assert.equal(config.logLevel, "info");
  });

  it("rejects an invalid LOG_FORMAT", () => {
    assert.throws(
      () => validate(baseVars({ LOG_FORMAT: "xml" })),
      /LOG_FORMAT must be one of json, text/,
    );
  });

  it("rejects an invalid boolean for ENABLE_STATS_COLLECTOR", () => {
    assert.throws(
      () => validate(baseVars({ ENABLE_STATS_COLLECTOR: "1" })),
      /ENABLE_STATS_COLLECTOR must be "true" or "false"/,
    );
  });

  it("accepts a boolean case-insensitively", () => {
    const { config } = validate(baseVars({ ENABLE_STATS_COLLECTOR: "TRUE" }));
    assert.equal(config.enableStatsCollector, true);
  });

  it("clamps STATS_POLL_INTERVAL_SECONDS to the 60-second floor and warns", () => {
    const { config, warnings } = validate(baseVars({ STATS_POLL_INTERVAL_SECONDS: "10" }));
    assert.equal(config.statsPollIntervalSeconds, 60);
    assert.ok(warnings.some((w) => w.includes("60-second floor")));
  });

  it("accepts a valid IPv6 METRICS_BIND_ADDRESS", () => {
    const { config } = validate(baseVars({ METRICS_BIND_ADDRESS: "::" }));
    assert.equal(config.metricsBindAddress, "::");
  });

  it("rejects a METRICS_BIND_ADDRESS that is not a valid IP address", () => {
    assert.throws(
      () => validate(baseVars({ METRICS_BIND_ADDRESS: "not-an-address" })),
      /METRICS_BIND_ADDRESS must be a valid IPv4 or IPv6 address/,
    );
  });
});

describe("validate — metrics listener TLS", () => {
  it("is undefined when neither cert nor key path is set", () => {
    const { config } = validate(baseVars());
    assert.equal(config.metricsTls, undefined);
  });

  it("requires both cert and key path together (cert alone)", () => {
    assert.throws(
      () => validate(baseVars({ METRICS_TLS_CERT_PATH: "/etc/cert.pem" })),
      /must both be set, or neither/,
    );
  });

  it("requires both cert and key path together (key alone)", () => {
    assert.throws(
      () => validate(baseVars({ METRICS_TLS_KEY_PATH: "/etc/key.pem" })),
      /must both be set, or neither/,
    );
  });

  it("rejects a client CA path without cert and key", () => {
    assert.throws(
      () => validate(baseVars({ METRICS_TLS_CLIENT_CA_PATH: "/etc/ca.pem" })),
      /METRICS_TLS_CLIENT_CA_PATH requires/,
    );
  });

  it("rejects an invalid METRICS_TLS_MIN_VERSION", () => {
    assert.throws(
      () =>
        validate(
          baseVars({
            METRICS_TLS_CERT_PATH: "/etc/cert.pem",
            METRICS_TLS_KEY_PATH: "/etc/key.pem",
            METRICS_TLS_MIN_VERSION: "TLSv1.1",
          }),
        ),
      /METRICS_TLS_MIN_VERSION must be one of TLSv1\.2, TLSv1\.3/,
    );
  });

  it("accepts a full TLS configuration", () => {
    const { config } = validate(
      baseVars({
        METRICS_TLS_CERT_PATH: "/etc/cert.pem",
        METRICS_TLS_KEY_PATH: "/etc/key.pem",
        METRICS_TLS_CLIENT_CA_PATH: "/etc/ca.pem",
        METRICS_TLS_MIN_VERSION: "TLSv1.3",
      }),
    );
    assert.deepEqual(config.metricsTls, {
      certPath: "/etc/cert.pem",
      keyPath: "/etc/key.pem",
      clientCaPath: "/etc/ca.pem",
      minVersion: "TLSv1.3",
    });
  });

  it("accepts METRICS_TLS_MIN_VERSION case-insensitively, normalising to the canonical casing", () => {
    const { config } = validate(
      baseVars({
        METRICS_TLS_CERT_PATH: "/etc/cert.pem",
        METRICS_TLS_KEY_PATH: "/etc/key.pem",
        METRICS_TLS_MIN_VERSION: "tlsv1.3",
      }),
    );
    assert.equal(config.metricsTls?.minVersion, "TLSv1.3");
  });
});

describe("validate — frozen output", () => {
  it("the returned config is deeply frozen", () => {
    const { config } = validate(baseVars());
    assert.throws(() => {
      (config as { metricsPort: number }).metricsPort = 1;
    });
    assert.throws(() => {
      (config.targets as unknown[]).push({});
    });
  });
});

describe("validate — no secret leakage", () => {
  const DISTINCTIVE_TOKEN = "distinctive-super-secret-token-value";

  it("a thrown ConfigError never contains the token, even when other validation fails", () => {
    try {
      validate({
        TECHNITIUM_TARGETS:
          "dns-a=https://dns-a.example.com:53443,dns-a=https://dns-a2.example.com:53443",
        TECHNITIUM_API_TOKEN: DISTINCTIVE_TOKEN,
        METRICS_PORT: "not-a-number",
      });
      assert.fail("expected validate to throw");
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.message.includes(DISTINCTIVE_TOKEN), false);
      // Both independent failures are reported together, not one-at-a-time.
      assert.match(error.message, /duplicate target name/);
      assert.match(error.message, /must be a positive integer/);
    }
  });
});

describe("validate — the shipped example.env", () => {
  it("parses and validates cleanly once a target and token are supplied", () => {
    const exampleEnvPath = join(import.meta.dirname, "..", "..", "..", "example.env");
    const fileVars = parseEnvFile(readFileSync(exampleEnvPath, "utf8"));

    assert.doesNotThrow(() =>
      validate({
        ...fileVars,
        TECHNITIUM_TARGETS: "dns-a=https://dns-a.example.com:53443",
        TECHNITIUM_API_TOKEN: "a-token",
      }),
    );
  });
});
