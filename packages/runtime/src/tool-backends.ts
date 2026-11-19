// Where a workflow's tools run. Locally, the recorded server command is started
// (stdio). In hosted mode (HOTPATH_HOSTED=1) that would let any workflow file run
// any program on our machines, so only a remote MCP server over https is
// allowed, through the egress rules of egress.ts.
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { checkUrl, EgressError, guardedFetch } from "./egress.js";

export const hostedMode = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.HOTPATH_HOSTED === "1";

/** A workflow `server` that names a remote MCP endpoint instead of a command. */
export const isRemoteServer = (server: string): boolean =>
  /^https?:\/\//i.test(server.trim());

/**
 * Refuses, in hosted mode, anything but a remote https server. Returns the URL
 * to connect to, or null for a local command (local mode only).
 */
export function remoteServerUrl(server: string, hosted: boolean): URL | null {
  if (isRemoteServer(server)) {
    // the same rules apply locally: a URL in a workflow file from someone else
    // should not reach into the owner's own network either
    return checkUrl(server.trim());
  }
  if (hosted) {
    throw new EgressError(
      "hosted mode runs only remote tools: this workflow starts a local program " +
        `(${JSON.stringify(server.split(/\s+/)[0])}). Point its "server" at an https:// MCP endpoint.`,
    );
  }
  return null;
}

/** MCP over streamable HTTP, every request through the guarded fetch. */
export function remoteTransport(
  url: URL,
  headers: Record<string, string> = {},
): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(url, {
    fetch: guardedFetch() as never,
    requestInit: { headers },
  });
}
