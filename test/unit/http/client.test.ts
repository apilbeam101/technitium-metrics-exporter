import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterEach, describe, it } from "node:test";
import { Agent, MockAgent } from "undici";
import { Secret } from "../../../src/config/secret.ts";
import { HttpClient, type RawResponse } from "../../../src/http/client.ts";
import { systemClock } from "../../../src/http/clock.ts";
import { TechnitiumHttpError } from "../../../src/http/errors.ts";
import { FakeClock } from "../../support/fake-clock.ts";

const BASE_URL = "http://dns-a.example.com:53443";

function makeMockAgent(): MockAgent {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  return mockAgent;
}

let activeMockAgent: MockAgent | undefined;

afterEach(async () => {
  await activeMockAgent?.close();
  activeMockAgent = undefined;
});

function client(
  mockAgent: MockAgent,
  overrides: {
    baseUrl?: string;
    budgetMs?: number;
    onRawResponse?: (r: RawResponse) => void;
    clock?: typeof systemClock;
  } = {},
) {
  activeMockAgent = mockAgent;
  return new HttpClient({
    baseUrl: overrides.baseUrl ?? BASE_URL,
    apiToken: new Secret("test-token"),
    dispatcher: mockAgent,
    clock: overrides.clock ?? (overrides.budgetMs === undefined ? systemClock : new FakeClock()),
    budgetMs: overrides.budgetMs ?? 15000,
    ...(overrides.onRawResponse === undefined ? {} : { onRawResponse: overrides.onRawResponse }),
  });
}

describe("HttpClient.get", () => {
  it("sends a bearer token and returns the raw response", async () => {
    const mockAgent = makeMockAgent();
    mockAgent
      .get(BASE_URL)
      .intercept({
        path: "/api/user/session/get",
        method: "GET",
        headers: { authorization: "Bearer test-token" },
      })
      .reply(200, JSON.stringify({ status: "ok", response: { version: "15.4" } }));

    const response = await client(mockAgent).get("/api/user/session/get");
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), { status: "ok", response: { version: "15.4" } });
  });

  it("rejects a path outside the allowlist without making a request", async () => {
    const mockAgent = makeMockAgent();
    await assert.rejects(() => client(mockAgent).get("/api/zones/delete"));
  });

  it("preserves a base URL path prefix rather than discarding it (D§6.1: opaque prefix, never reconstructed)", async () => {
    const baseUrl = `${BASE_URL}/technitium`;
    const mockAgent = makeMockAgent();
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/technitium/api/user/session/get", method: "GET" })
      .reply(200, "under-the-prefix");

    const response = await client(mockAgent, { baseUrl }).get("/api/user/session/get");
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, "under-the-prefix");
  });

  it("does not trust the HTTP status code: a 401 body is returned as-is, not thrown", async () => {
    const mockAgent = makeMockAgent();
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/api/user/session/get", method: "GET" })
      .reply(401, JSON.stringify({ status: "invalid-token" }));

    const response = await client(mockAgent).get("/api/user/session/get");
    assert.equal(response.statusCode, 401);
    assert.deepEqual(JSON.parse(response.body), { status: "invalid-token" });
  });

  it("never follows a redirect: a 3xx response is returned as-is", async () => {
    const mockAgent = makeMockAgent();
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/api/user/session/get", method: "GET" })
      .reply(302, "", { headers: { location: "/api/zones/delete" } });

    const response = await client(mockAgent).get("/api/user/session/get");
    assert.equal(response.statusCode, 302);
  });

  it("invokes onRawResponse for every attempt, including ones that end up retried", async () => {
    const mockAgent = makeMockAgent();
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/api/user/session/get", method: "GET" })
      .reply(503, "unavailable-1")
      .times(1);
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/api/user/session/get", method: "GET" })
      .reply(200, "ok-2")
      .times(1);

    const seen: RawResponse[] = [];
    const response = await client(mockAgent, {
      budgetMs: 5000,
      onRawResponse: (r) => seen.push(r),
    }).get("/api/user/session/get");

    assert.equal(response.statusCode, 200);
    assert.deepEqual(seen, [
      { statusCode: 503, body: "unavailable-1" },
      { statusCode: 200, body: "ok-2" },
    ]);
  });

  it("classifies a failure while streaming the response body the same as a connect-time failure", async () => {
    // A MockAgent failure surfaces before headers, which the request/error
    // path already covered before the P1 fix. This reproduces the gap that
    // fix closed: headers arrive successfully (statusCode 200), then the
    // socket is destroyed mid-body, against a real server and a real
    // (non-mock) dispatcher. budgetMs is comfortably larger than the
    // immediate socket destroy needs, so the assertion can't flip from
    // network to timeout on a loaded CI box racing the two — but still
    // below what a single retry (200ms backoff + MIN_ATTEMPT_BUDGET_MS)
    // would need, so this asserts on the first failure, not a retry storm
    // against a server that would destroy every subsequent attempt's
    // socket too.
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-length": "1000" });
      res.write("only-part-of-the-promised-body");
      res.socket?.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const agent = new Agent();

    try {
      await assert.rejects(
        new HttpClient({
          baseUrl: `http://127.0.0.1:${port}`,
          apiToken: new Secret("test-token"),
          dispatcher: agent,
          clock: systemClock,
          budgetMs: 300,
        }).get("/api/user/session/get"),
        (error: unknown) => error instanceof TechnitiumHttpError && error.reason === "network",
      );
    } finally {
      await agent.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("classifies a budget expiring while still reading the response body as timeout", async () => {
    // The other half of the same gap: headers arrive (statusCode 200), then
    // the server simply never finishes the body, so the budget itself — not
    // a socket error — is what ends the wait.
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-length": "1000" });
      res.write("only-part-of-the-promised-body");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const agent = new Agent();

    try {
      await assert.rejects(
        new HttpClient({
          baseUrl: `http://127.0.0.1:${port}`,
          apiToken: new Secret("test-token"),
          dispatcher: agent,
          clock: systemClock,
          budgetMs: 20,
        }).get("/api/user/session/get"),
        (error: unknown) => error instanceof TechnitiumHttpError && error.reason === "timeout",
      );
    } finally {
      server.closeAllConnections();
      await agent.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("retries a 5xx response using the injected clock, then throws http_5xx once the budget is spent", async () => {
    const mockAgent = makeMockAgent();
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/api/user/session/get", method: "GET" })
      .reply(503, "unavailable")
      .persist();

    await assert.rejects(
      client(mockAgent, { budgetMs: 1000 }).get("/api/user/session/get"),
      (error: unknown) => error instanceof TechnitiumHttpError && error.reason === "http_5xx",
    );
  });

  it("clamps a negative remainingMs from a retry-timer overshoot to 0, instead of RangeError-ing out of AbortSignal.timeout", async () => {
    // retry.ts reasons about the backoff it intends to sleep, not what
    // actually elapses, so a slow-timer overshoot (a stalled event loop, a
    // GC pause) can hand back a negative remainingMs on the attempt that
    // follows. Neither FakeClock (sleep is exact) nor systemClock (no real
    // stall) can produce this on their own — this clock deliberately
    // advances further than the backoff it was asked to sleep for.
    //
    // MockAgent resolves synchronously, so a zero-delay signal can still
    // lose the race to it — this asserts against the actual regression
    // (a RangeError from a negative delay, misclassified as "network")
    // rather than pinning down which honest outcome (timeout, if the abort
    // wins; http_5xx, if the reply does) results from that race.
    const mockAgent = makeMockAgent();
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/api/user/session/get", method: "GET" })
      .reply(503, "unavailable")
      .persist();

    let elapsedMs = 0;
    const overshootingClock = {
      now: () => 0,
      elapsed: () => elapsedMs,
      sleep: async (ms: number) => {
        elapsedMs += ms + 1000;
      },
    };

    await assert.rejects(
      new HttpClient({
        baseUrl: BASE_URL,
        apiToken: new Secret("test-token"),
        dispatcher: mockAgent,
        clock: overshootingClock,
        budgetMs: 1000,
      }).get("/api/user/session/get"),
      (error: unknown) =>
        error instanceof TechnitiumHttpError &&
        (error.reason === "timeout" || error.reason === "http_5xx"),
    );
  });

  it("never reports a persistent 5xx as timeout, across a range of budgets, against a real clock", async () => {
    // A FakeClock can't catch a retry taken with too little real budget
    // left for its attempt to finish before the budget expires — every
    // attempt costs it zero simulated time. This sweeps the same real
    // wall-clock/MockAgent combination the withBudgetedRetry fix was
    // regression-tested against, at budgets known to have masked http_5xx
    // as timeout before that fix.
    for (const budgetMs of [180, 205, 260, 1000, 1430]) {
      const mockAgent = makeMockAgent();
      mockAgent
        .get(BASE_URL)
        .intercept({ path: "/api/user/session/get", method: "GET" })
        .reply(503, "unavailable")
        .persist();

      await assert.rejects(
        new HttpClient({
          baseUrl: BASE_URL,
          apiToken: new Secret("test-token"),
          dispatcher: mockAgent,
          clock: systemClock,
          budgetMs,
        }).get("/api/user/session/get"),
        (error: unknown) => error instanceof TechnitiumHttpError && error.reason === "http_5xx",
        `budgetMs=${budgetMs}`,
      );

      await mockAgent.close();
    }
  });

  it("retries a network failure, then throws network once the budget is spent", async () => {
    const mockAgent = makeMockAgent();
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/api/user/session/get", method: "GET" })
      .replyWithError(new Error("connection refused"))
      .persist();

    await assert.rejects(
      client(mockAgent, { budgetMs: 1000 }).get("/api/user/session/get"),
      (error: unknown) => error instanceof TechnitiumHttpError && error.reason === "network",
    );
  });

  it("throws timeout when the wall-clock budget is exhausted waiting on a slow response", async () => {
    const mockAgent = makeMockAgent();
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/api/user/session/get", method: "GET" })
      .reply(200, "too-slow")
      .delay(500);

    await assert.rejects(
      client(mockAgent, { budgetMs: 20, clock: systemClock }).get("/api/user/session/get"),
      (error: unknown) => error instanceof TechnitiumHttpError && error.reason === "timeout",
    );
  });
});
