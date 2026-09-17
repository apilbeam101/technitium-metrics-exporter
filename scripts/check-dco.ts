import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export type Commit = {
  sha: string;
  authorEmail: string;
  committerEmail: string;
  message: string;
};

const SIGNOFF_LINE = /^Signed-off-by:\s*.+<(.+)>\s*$/gim;

function signoffEmails(message: string): string[] {
  return [...message.matchAll(SIGNOFF_LINE)].map((match) => (match[1] ?? "").trim().toLowerCase());
}

// A trailer merely existing isn't enough — the DCO certifies that the person
// named in it made the commit, so the trailer's email must match the actual
// author or committer, the same check the DCO probot app and dcoapp/action
// perform. Matching author OR committer (not just author) covers a squash-
// merge whose committer identity differs from the original author.
export function findUnsignedCommits(commits: readonly Commit[]): Commit[] {
  return commits.filter((commit) => {
    const authorEmail = commit.authorEmail.toLowerCase();
    const committerEmail = commit.committerEmail.toLowerCase();
    return !signoffEmails(commit.message).some(
      (email) => email === authorEmail || email === committerEmail,
    );
  });
}

// Field/record separators outside the printable range so a commit message
// containing an ordinary colon or newline can never be mistaken for one.
const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";
const FIELDS_BEFORE_MESSAGE = 3;

export function parseGitLog(output: string): Commit[] {
  return output
    .split(RECORD_SEP)
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const parts = record.split(FIELD_SEP);
      if (parts.length < FIELDS_BEFORE_MESSAGE + 1) {
        throw new Error(
          `malformed git log record (expected ${FIELDS_BEFORE_MESSAGE} fields before the message): ${record}`,
        );
      }
      const [sha, authorEmail, committerEmail, ...rest] = parts as [
        string,
        string,
        string,
        ...string[],
      ];
      return { sha, authorEmail, committerEmail, message: rest.join(FIELD_SEP) };
    });
}

function commitsInRange(base: string, head: string): Commit[] {
  const output = execFileSync(
    "git",
    [
      "log",
      "--no-merges",
      `--format=%H${FIELD_SEP}%ae${FIELD_SEP}%ce${FIELD_SEP}%B${RECORD_SEP}`,
      `${base}..${head}`,
    ],
    { encoding: "utf8" },
  );
  return parseGitLog(output);
}

function main(): void {
  const base = process.argv[2];
  const head = process.argv[3];
  if (base === undefined || head === undefined) {
    console.error("usage: check-dco.ts <base-ref> <head-ref>");
    process.exit(2);
  }

  const commits = commitsInRange(base, head);
  const unsigned = findUnsignedCommits(commits);

  if (unsigned.length > 0) {
    console.error("Commits missing a DCO Signed-off-by trailer matching their author/committer:");
    for (const commit of unsigned) {
      console.error(`  ${commit.sha}`);
    }
    console.error("\nSee CONTRIBUTING.md — run `git commit -s` to sign off.");
    process.exit(1);
  }

  console.log(`${commits.length} commit(s) checked, all signed off.`);
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main();
}
