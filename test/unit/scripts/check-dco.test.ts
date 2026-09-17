import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findUnsignedCommits, parseGitLog } from "../../../scripts/check-dco.ts";

function commit(overrides: {
  sha?: string;
  authorEmail?: string;
  committerEmail?: string;
  message: string;
}) {
  return {
    sha: overrides.sha ?? "a1",
    authorEmail: overrides.authorEmail ?? "jane@example.com",
    committerEmail: overrides.committerEmail ?? "jane@example.com",
    message: overrides.message,
  };
}

describe("findUnsignedCommits", () => {
  it("passes a commit whose trailer email matches the author", () => {
    const commits = [
      commit({ message: "fix: thing\n\nSigned-off-by: Jane Doe <jane@example.com>\n" }),
    ];
    assert.deepEqual(findUnsignedCommits(commits), []);
  });

  it("flags a commit with no trailer at all", () => {
    const commits = [commit({ message: "fix: thing\n" })];
    assert.deepEqual(findUnsignedCommits(commits), commits);
  });

  it("flags a trailer missing an email address", () => {
    const commits = [commit({ message: "fix: thing\n\nSigned-off-by: Jane Doe\n" })];
    assert.deepEqual(findUnsignedCommits(commits), commits);
  });

  it("flags a trailer whose email does not match the author or committer", () => {
    const commits = [
      commit({ message: "fix: thing\n\nSigned-off-by: Someone Else <someone@example.com>\n" }),
    ];
    assert.deepEqual(findUnsignedCommits(commits), commits);
  });

  it("accepts a trailer matching the committer when it differs from the author (squash-merge)", () => {
    const commits = [
      commit({
        authorEmail: "jane@example.com",
        committerEmail: "bot@example.com",
        message: "fix: thing\n\nSigned-off-by: Merge Bot <bot@example.com>\n",
      }),
    ];
    assert.deepEqual(findUnsignedCommits(commits), []);
  });

  it("accepts the trailer case-insensitively and anywhere in the body", () => {
    const commits = [
      commit({ message: "fix: thing\n\nsigned-off-by: Jane Doe <JANE@EXAMPLE.COM>\nmore text" }),
    ];
    assert.deepEqual(findUnsignedCommits(commits), []);
  });

  it("checks each commit independently", () => {
    const signed = commit({
      sha: "a1",
      message: "Signed-off-by: Jane Doe <jane@example.com>",
    });
    const unsigned = commit({ sha: "b2", message: "no trailer here" });
    assert.deepEqual(findUnsignedCommits([signed, unsigned]), [unsigned]);
  });
});

describe("parseGitLog", () => {
  it("parses a single record", () => {
    const output = "abc123\x1fjane@example.com\x1fjane@example.com\x1fmy message\x1e";
    assert.deepEqual(parseGitLog(output), [
      {
        sha: "abc123",
        authorEmail: "jane@example.com",
        committerEmail: "jane@example.com",
        message: "my message",
      },
    ]);
  });

  it("parses multiple records and preserves multi-line messages", () => {
    const output =
      "abc\x1fa@example.com\x1fa@example.com\x1fsubject\n\nbody line\x1e\ndef\x1fb@example.com\x1fb@example.com\x1fother subject\x1e";
    assert.deepEqual(parseGitLog(output), [
      {
        sha: "abc",
        authorEmail: "a@example.com",
        committerEmail: "a@example.com",
        message: "subject\n\nbody line",
      },
      {
        sha: "def",
        authorEmail: "b@example.com",
        committerEmail: "b@example.com",
        message: "other subject",
      },
    ]);
  });

  it("returns an empty array for an empty range", () => {
    assert.deepEqual(parseGitLog(""), []);
  });

  it("throws on a malformed record missing fields", () => {
    assert.throws(() => parseGitLog("onlyonefield\x1e"), /malformed git log record/);
  });
});
