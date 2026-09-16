import type { IncomingMessage, ServerResponse } from "node:http";
import type { Registry } from "@prometheus-io/client";
import type { Logger } from "../log/logger.ts";
import type { TargetRegistry } from "../poller/target-registry.ts";

export interface RouteDeps {
  readonly globalRegistry: Registry;
  // A provider rather than a direct reference: the server must start
  // listening (D§7 startup order step 5, so /healthz answers immediately)
  // before the TargetRegistry is even constructed (step 6). Until then this
  // returns undefined and every target-dependent route degrades honestly
  // (503/400) instead of throwing on a null reference.
  readonly getTargetRegistry: () => TargetRegistry | undefined;
  readonly logger: Logger;
}

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: RouteDeps,
) => Promise<void> | void;

const ROUTES: ReadonlyMap<
  string,
  { readonly methods: readonly string[]; readonly handle: Handler }
> = new Map([
  ["/", { methods: ["GET"], handle: handleRoot }],
  ["/metrics", { methods: ["GET"], handle: handleMetrics }],
  ["/healthz", { methods: ["GET"], handle: handleHealthz }],
  ["/readyz", { methods: ["GET"], handle: handleReadyz }],
]);

function sendText(
  res: ServerResponse,
  statusCode: number,
  body: string,
  headers?: Record<string, string>,
): void {
  res.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
}

function handleRoot(_req: IncomingMessage, res: ServerResponse): void {
  sendText(
    res,
    200,
    "technitium-metrics-exporter\n\nendpoints: /metrics /metrics?target=<name> /healthz /readyz\n",
  );
}

// Liveness only: it must answer 200 the moment the listener is up,
// independent of any poll outcome, so it can never be dragged down by a
// target that's hard down (N3).
function handleHealthz(_req: IncomingMessage, res: ServerResponse): void {
  sendText(res, 200, "ok\n");
}

// Readiness: 200 only once every configured target has completed at least
// one poll cycle, success or failure both counting as "completed" (N3) — a
// permanently-down target must not withhold readiness from the exporter as
// a whole, since every other target's own series render independently of it.
function handleReadyz(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  deps: RouteDeps,
): void {
  const ready = deps.getTargetRegistry()?.allTargetsReady === true;
  sendText(res, ready ? 200 : 503, ready ? "ready\n" : "not ready\n");
}

// Bare /metrics renders the global registry only — build info, target
// count, runtime metrics — and never aggregates per-target data (D§4.3).
// /metrics?target=<name> renders exactly that target's own Registry; an
// unknown name is a 400, never an empty 200, since a scrape-config typo
// must fail loudly rather than silently returning nothing.
async function handleMetrics(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: RouteDeps,
): Promise<void> {
  const targetParam = url.searchParams.get("target");

  if (targetParam === null) {
    const body = await deps.globalRegistry.metrics();
    res.writeHead(200, { "content-type": deps.globalRegistry.contentType });
    res.end(body);
    return;
  }

  const targetRegistry = deps.getTargetRegistry();
  const entry = targetRegistry?.get(targetParam);
  if (entry === undefined) {
    sendText(res, 400, `unknown target "${targetParam}"\n`);
    return;
  }

  const body = await entry.renderMetrics();
  res.writeHead(200, { "content-type": entry.registry.contentType });
  res.end(body);
}

export function createRequestHandler(
  deps: RouteDeps,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const route = ROUTES.get(url.pathname);

    if (route === undefined) {
      sendText(res, 404, "not found\n");
      return;
    }

    if (!route.methods.includes(method)) {
      sendText(res, 405, "method not allowed\n", { allow: route.methods.join(", ") });
      return;
    }

    Promise.resolve(route.handle(req, res, url, deps)).catch((error: unknown) => {
      deps.logger.error(`request handler failed for ${url.pathname}`, {
        error: error instanceof Error ? error.message : String(error),
      });

      // Headers already sent means writeHead()/end() already ran on this
      // response before the rejection — sendText() would throw a second
      // ERR_HTTP_HEADERS_SENT rather than actually inform the client, and
      // leaving the response neither ended nor destroyed hangs the
      // connection until the 60s requestTimeout instead of disconnecting
      // promptly.
      if (res.headersSent) res.destroy();
      else sendText(res, 500, "internal error\n");
    });
  };
}
