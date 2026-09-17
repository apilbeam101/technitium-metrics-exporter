import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync, zstdDecompressSync } from "node:zlib";

const SENTINEL = "SENTINEL_DO_NOT_SHIP_7f3a9c2e";

// GitHub's windows-latest runners ship a Docker CLI/daemon configured for
// Windows containers only — `docker version` succeeds either way, so this
// project's Linux-only Dockerfile needs the daemon's actual OSType checked
// too, not just CLI presence.
function dockerAvailable(): boolean {
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

const DOCKER_SKIP_REASON =
  "docker is not available, or is not configured for Linux containers, in this environment";

// A copy of the repo's build context with a sentinel-bearing .env planted at
// the root — mirroring exactly what a developer's real local .env sitting
// next to the Dockerfile during `docker build .` would put into the build
// context, since .dockerignore is the only thing standing between it and a
// COPY instruction that later starts matching more broadly than it does today.
function buildDirFromRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "technitium-dockerignore-sentinel-"));
  for (const entry of [
    "Dockerfile",
    ".dockerignore",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
  ]) {
    cpSync(entry, join(dir, entry));
  }
  cpSync("src", join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, ".env"), `${SENTINEL}=do-not-ship-this\n`);
  return dir;
}

/**
 * Every blob in a `docker save` OCI layout, decompressed if gzip or zstd.
 * `docker save` has used the OCI blobs/sha256 layout since Docker 25 (2024)
 * — an older daemon emitting the legacy <id>/layer.tar layout instead is
 * called out explicitly rather than left to a bare ENOENT.
 */
function decompressedBlobs(extractedDir: string): Buffer[] {
  const blobsDir = join(extractedDir, "blobs", "sha256");
  if (!existsSync(blobsDir)) {
    throw new Error(
      `expected an OCI-layout image save at ${blobsDir} (Docker 25+) — ` +
        "this daemon may be emitting the older docker save layout instead",
    );
  }

  return readdirSync(blobsDir).map((name) => {
    const raw = readFileSync(join(blobsDir, name));
    try {
      return gunzipSync(raw);
    } catch {
      // Not gzip. Try zstd before falling back to raw, since a blob this
      // check can't actually decompress would otherwise pass the sentinel
      // check below vacuously rather than genuinely proving its absence.
      try {
        return zstdDecompressSync(raw);
      } catch {
        return raw; // one of the small JSON manifest/config blobs
      }
    }
  });
}

test("a stray local .env never reaches any layer of the shipped image", {
  skip: dockerAvailable() ? false : DOCKER_SKIP_REASON,
  timeout: 180_000,
}, (t) => {
  const buildDir = buildDirFromRepo();
  const imageTag = `technitium-dockerignore-sentinel-test:${process.pid}`;
  const saveDir = mkdtempSync(join(tmpdir(), "technitium-dockerignore-sentinel-save-"));

  t.after(() => {
    try {
      execFileSync("docker", ["rmi", imageTag], { stdio: "ignore" });
    } catch {
      // best-effort cleanup
    }
    rmSync(buildDir, { recursive: true, force: true });
    rmSync(saveDir, { recursive: true, force: true });
  });

  execFileSync("docker", ["build", "--no-cache", "-t", imageTag, buildDir], { stdio: "ignore" });

  const tarPath = join(saveDir, "image.tar");
  execFileSync("docker", ["save", imageTag, "-o", tarPath]);
  execFileSync("tar", ["xf", tarPath], { cwd: saveDir });

  const blobs = decompressedBlobs(saveDir);
  assert.ok(blobs.length > 0, "expected at least one layer/manifest blob in the saved image");

  for (const blob of blobs) {
    assert.ok(
      !blob.includes(SENTINEL),
      "sentinel value from the local .env was found in a built image layer",
    );
  }
});

test("shipped runtime image contains only dist/ and package manifests under /app — no source, no .env", {
  skip: dockerAvailable() ? false : DOCKER_SKIP_REASON,
  timeout: 180_000,
}, (t) => {
  const imageTag = `technitium-runtime-inventory-test:${process.pid}`;
  t.after(() => {
    try {
      execFileSync("docker", ["rmi", imageTag], { stdio: "ignore" });
    } catch {
      // best-effort cleanup
    }
  });

  execFileSync("docker", ["build", "--no-cache", "-t", imageTag, "."], { stdio: "ignore" });

  const listing = execFileSync("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "/bin/sh",
    imageTag,
    "-c",
    "ls -A /app",
  ])
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  assert.deepEqual(
    [...listing].sort(),
    ["dist", "node_modules", "package-lock.json", "package.json"],
    `expected /app to contain only dist/, node_modules/, and the package manifests; got: ${listing.join(", ")}`,
  );
});
