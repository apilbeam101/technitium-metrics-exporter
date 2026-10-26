// Defensive runtime check, not a duplicate of package.json's own
// engines.node enforcement: engines is advisory unless a package manager is
// configured to enforce it, and this binary may also be invoked directly
// (e.g. `node dist/index.js`) with no package manager involved at all.
const MIN_MAJOR_VERSION = 24;

export function checkNodeVersion(
  nodeVersion: string = process.version,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  const match = /^v(\d+)\./.exec(nodeVersion);
  const major = match?.[1] === undefined ? Number.NaN : Number.parseInt(match[1], 10);

  if (!Number.isFinite(major) || major < MIN_MAJOR_VERSION) {
    process.stderr.write(
      `technitium-metrics-exporter requires Node.js >= ${MIN_MAJOR_VERSION}, got ${nodeVersion}\n`,
    );
    exit(1);
  }
}
