import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Secret } from "../../../src/config/secret.ts";
import { createLogger } from "../../../src/log/logger.ts";

function captureStream(stream: NodeJS.WriteStream): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = stream.write.bind(stream);
  stream.write = ((chunk: string) => {
    lines.push(chunk);
    return true;
  }) as typeof stream.write;
  return { lines, restore: () => (stream.write = original) };
}

describe("createLogger", () => {
  it("writes info and debug to stdout, warn and error to stderr", () => {
    const out = captureStream(process.stdout);
    const err = captureStream(process.stderr);
    try {
      const logger = createLogger({ level: "debug", format: "text" });
      logger.debug("debug message");
      logger.info("info message");
      logger.warn("warn message");
      logger.error("error message");
    } finally {
      out.restore();
      err.restore();
    }

    assert.equal(out.lines.length, 2);
    assert.equal(err.lines.length, 2);
    assert.match(out.lines[0] ?? "", /debug message/);
    assert.match(out.lines[1] ?? "", /info message/);
    assert.match(err.lines[0] ?? "", /warn message/);
    assert.match(err.lines[1] ?? "", /error message/);
  });

  it("suppresses messages below the configured level", () => {
    const out = captureStream(process.stdout);
    const err = captureStream(process.stderr);
    try {
      const logger = createLogger({ level: "warn", format: "text" });
      logger.debug("debug message");
      logger.info("info message");
      logger.warn("warn message");
    } finally {
      out.restore();
      err.restore();
    }

    assert.equal(out.lines.length, 0);
    assert.equal(err.lines.length, 1);
  });

  it("writes valid JSON with the requested fields when format is json", () => {
    const out = captureStream(process.stdout);
    try {
      const logger = createLogger({ level: "info", format: "json" });
      logger.info("hello", { target: "dns-a" });
    } finally {
      out.restore();
    }

    const parsed = JSON.parse(out.lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(parsed.level, "info");
    assert.equal(parsed.message, "hello");
    assert.equal(parsed.target, "dns-a");
    assert.equal(typeof parsed.time, "string");
  });

  it("renders fields as a trailing JSON blob in text format", () => {
    const out = captureStream(process.stdout);
    try {
      const logger = createLogger({ level: "info", format: "text" });
      logger.info("hello", { target: "dns-a" });
    } finally {
      out.restore();
    }

    assert.match(out.lines[0] ?? "", /\[info\] hello \{"target":"dns-a"\}/);
  });

  it("does not let a caller-supplied field named time/level/message shadow the real ones", () => {
    const out = captureStream(process.stdout);
    try {
      const logger = createLogger({ level: "info", format: "json" });
      logger.info("hello", {
        level: "not-a-level",
        message: "not-the-message",
        time: "not-a-time",
      });
    } finally {
      out.restore();
    }

    const parsed = JSON.parse(out.lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(parsed.level, "info");
    assert.equal(parsed.message, "hello");
    assert.notEqual(parsed.time, "not-a-time");
  });

  it("diverts every level to stderr when allLogsToStderr is set, leaving stdout untouched", () => {
    const out = captureStream(process.stdout);
    const err = captureStream(process.stderr);
    try {
      const logger = createLogger({ level: "debug", format: "text", allLogsToStderr: true });
      logger.debug("debug message");
      logger.info("info message");
      logger.warn("warn message");
      logger.error("error message");
    } finally {
      out.restore();
      err.restore();
    }

    assert.equal(out.lines.length, 0);
    assert.equal(err.lines.length, 4);
  });

  it("keeps the ordinary stdout/stderr split when allLogsToStderr is explicitly false", () => {
    const out = captureStream(process.stdout);
    const err = captureStream(process.stderr);
    try {
      const logger = createLogger({ level: "debug", format: "text", allLogsToStderr: false });
      logger.debug("debug message");
      logger.warn("warn message");
    } finally {
      out.restore();
      err.restore();
    }

    assert.equal(out.lines.length, 1);
    assert.equal(err.lines.length, 1);
  });

  it("never lets a Secret-wrapped field value reach a log line, in either format", () => {
    const secret = new Secret("super-secret-value");

    const outJson = captureStream(process.stdout);
    try {
      createLogger({ level: "info", format: "json" }).info("hello", { apiToken: secret });
    } finally {
      outJson.restore();
    }
    assert.match(outJson.lines[0] ?? "", /\[REDACTED\]/);
    assert.equal((outJson.lines[0] ?? "").includes("super-secret-value"), false);

    const outText = captureStream(process.stdout);
    try {
      createLogger({ level: "info", format: "text" }).info("hello", { apiToken: secret });
    } finally {
      outText.restore();
    }
    assert.match(outText.lines[0] ?? "", /\[REDACTED\]/);
    assert.equal((outText.lines[0] ?? "").includes("super-secret-value"), false);
  });
});
