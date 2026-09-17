import * as http from "node:http";

// A real HTTP server, not an in-process stub: this exists specifically for
// tests that exercise the exporter as a separate OS process (a built
// container) rather than by calling into src/ directly, so it has to be
// reachable over an actual socket.
export interface MockTechnitiumServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

export function startMockTechnitiumServer(sessionGetBody: string): Promise<MockTechnitiumServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/api/user/session/get") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(sessionGetBody);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}
