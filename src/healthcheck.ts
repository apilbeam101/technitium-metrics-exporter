// Standalone Docker HEALTHCHECK probe, run as its own short-lived process on
// every check interval. It must enforce its own timeout: Docker's own
// `--timeout` flag marks a check failed once it elapses but does not kill
// the CMD's process tree, so a hung server would otherwise leak one
// unreachable Node process per check forever.
import * as http from "node:http";
import * as https from "node:https";

const TIMEOUT_MS = 5_000;

function main(): void {
  const rawPort = process.env.METRICS_PORT;
  const port = rawPort === undefined || rawPort === "" ? "10053" : rawPort;
  const usesTls = (process.env.METRICS_TLS_CERT_PATH ?? "") !== "";
  const client = usesTls ? https : http;

  const req = client.request(
    {
      host: "127.0.0.1",
      port,
      path: "/healthz",
      method: "GET",
      timeout: TIMEOUT_MS,
      // A local loopback liveness probe, not a security-sensitive call —
      // the listener's own cert (possibly self-signed, possibly mTLS-only)
      // is irrelevant to "is the process alive and answering".
      rejectUnauthorized: false,
    },
    (res) => {
      res.resume();
      process.exit(res.statusCode === 200 ? 0 : 1);
    },
  );

  // `timeout` above only fires this event; it does not itself abort the
  // socket, so the exit here has to be explicit rather than assumed.
  req.on("timeout", () => {
    req.destroy();
    process.exit(1);
  });
  req.on("error", () => process.exit(1));
  req.end();
}

main();
