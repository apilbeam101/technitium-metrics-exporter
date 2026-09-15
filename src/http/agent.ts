import { readFileSync } from "node:fs";
import { Agent } from "undici";

export interface AgentOptions {
  readonly caBundlePath: string | undefined;
  readonly tlsInsecureSkipVerify: boolean;
}

export function createAgent(options: AgentOptions): Agent {
  const ca =
    options.caBundlePath === undefined ? undefined : readFileSync(options.caBundlePath, "utf8");

  return new Agent({
    connect: {
      ca,
      rejectUnauthorized: !options.tlsInsecureSkipVerify,
    },
  });
}
