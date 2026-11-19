import crossSpawn from "cross-spawn";

import {
  enqueue,
  enqueueChangedWorkflows,
  flushQueue,
  syncDisabled,
} from "./queue.js";
import type { Fetch } from "../account/api.js";
import { currentToken } from "../account/gate.js";
import type { RunSummary } from "./summary.js";

/** Called after run, demo, learn and compile with the run summaries they made. */
export type AfterCommand = (runs?: RunSummary[]) => Promise<void>;

export interface SyncContext {
  stateDir: string;
  workflowsDir: string;
  env: NodeJS.ProcessEnv;
  /** starts `hotpath sync-flush` detached, so the command that queued does not wait for the network */
  startFlush: () => void;
}

/**
 * After run, demo, learn and compile: queue what is new and hand the sending
 * to a detached process. It never throws and never waits for the network: a
 * failure here must not touch the command's own result.
 */
export async function syncAfterCommand(
  ctx: SyncContext,
  runs: RunSummary[] = [],
): Promise<void> {
  try {
    if (syncDisabled(ctx.env)) return;
    await enqueueChangedWorkflows(ctx.workflowsDir, ctx.stateDir);
    if (runs.length > 0) await enqueue(ctx.stateDir, { runs });
    ctx.startFlush();
  } catch {
    // sync is a courtesy
  }
}

export function detachedFlush(
  self: string[],
  env: NodeJS.ProcessEnv,
): () => void {
  return () => {
    try {
      const child = crossSpawn(self[0]!, [...self.slice(1), "sync-flush"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env,
      });
      child.on("error", () => undefined);
      child.unref();
    } catch {
      // the queue is still on disk for the next call
    }
  };
}

/** The body of the hidden `sync-flush` command. */
export async function runFlush(opts: {
  stateDir: string;
  dir: string;
  env: NodeJS.ProcessEnv;
  fetch: Fetch;
  client: string;
}): Promise<void> {
  if (syncDisabled(opts.env)) return;
  const token = await currentToken(opts.env, opts.dir);
  if (!token) return;
  await flushQueue({
    fetch: opts.fetch,
    stateDir: opts.stateDir,
    token,
    client: opts.client,
  });
}
