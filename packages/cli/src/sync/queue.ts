// .hotpath/sync-queue.json: summaries waiting to be sent. Anything that cannot
// be sent stays here and goes with the next call. Idempotent on the server
// (runs by id, workflows by name), so sending twice is harmless.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { workflowSchema } from "@hotpathrun/shared";

import { HttpError, post, type Fetch } from "../account/api.js";
import {
  summarizeWorkflow,
  type RunSummary,
  type WorkflowSummary,
} from "./summary.js";

export const MAX_RUNS_PER_CALL = 500;
export const MAX_WORKFLOWS_PER_CALL = 100;
/** A queue that never drains (an offline machine) must not grow without end. */
const MAX_QUEUED_RUNS = 5000;

export interface Queue {
  workflows: WorkflowSummary[];
  runs: RunSummary[];
}

const queueFile = (stateDir: string) => path.join(stateDir, "sync-queue.json");
const stateFile = (stateDir: string) => path.join(stateDir, "sync-state.json");

export function syncDisabled(env: NodeJS.ProcessEnv): boolean {
  const v = env.HOTPATH_NO_SYNC?.trim();
  return v === "1" || v?.toLowerCase() === "true";
}

export async function readQueue(stateDir: string): Promise<Queue> {
  try {
    const q = JSON.parse(
      await readFile(queueFile(stateDir), "utf8"),
    ) as Partial<Queue>;
    return {
      workflows: Array.isArray(q.workflows) ? q.workflows : [],
      runs: Array.isArray(q.runs) ? q.runs : [],
    };
  } catch {
    return { workflows: [], runs: [] };
  }
}

async function writeQueue(stateDir: string, q: Queue): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(queueFile(stateDir), JSON.stringify(q) + "\n");
}

export async function enqueue(
  stateDir: string,
  add: { workflows?: WorkflowSummary[]; runs?: RunSummary[] },
): Promise<void> {
  const q = await readQueue(stateDir);
  // the newest summary of a workflow replaces an older queued one
  const byName = new Map(q.workflows.map((w) => [w.name, w]));
  for (const w of add.workflows ?? []) byName.set(w.name, w);
  const runs = [...q.runs, ...(add.runs ?? [])].slice(-MAX_QUEUED_RUNS);
  await writeQueue(stateDir, { workflows: [...byName.values()], runs });
}

/**
 * Summaries of every workflow file that is new or changed since it was last
 * queued. `compile`, `learn` and `demo` write workflows; this notices them
 * all without those commands knowing about sync.
 */
export async function enqueueChangedWorkflows(
  workflowsDir: string,
  stateDir: string,
): Promise<number> {
  let files: string[];
  try {
    files = (await readdir(workflowsDir)).filter(
      (f) => f.endsWith(".json") && !f.endsWith(".bak.json"),
    );
  } catch {
    return 0;
  }
  let seen: Record<string, string> = {};
  try {
    seen = JSON.parse(await readFile(stateFile(stateDir), "utf8")) as Record<
      string,
      string
    >;
  } catch {
    // first time
  }
  const changed: WorkflowSummary[] = [];
  for (const f of files) {
    const file = path.join(workflowsDir, f);
    try {
      const raw = await readFile(file, "utf8");
      const hash = createHash("sha256").update(raw).digest("hex");
      if (seen[f] === hash) continue;
      const parsed = workflowSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) continue;
      changed.push(summarizeWorkflow(parsed.data, (await stat(file)).mtime));
      seen[f] = hash;
    } catch {
      // unreadable or half-written: the next call sees it again
    }
  }
  if (changed.length === 0) return 0;
  await enqueue(stateDir, { workflows: changed });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(stateFile(stateDir), JSON.stringify(seen) + "\n");
  return changed.length;
}

export interface FlushDeps {
  fetch: Fetch;
  stateDir: string;
  token: string;
  client: string;
  timeoutMs?: number;
}

/** Sends the queue in batches; what the server did not accept stays queued. Never throws. */
export async function flushQueue(deps: FlushDeps): Promise<{ sent: boolean }> {
  try {
    let q = await readQueue(deps.stateDir);
    let sentAny = false;
    while (q.workflows.length > 0 || q.runs.length > 0) {
      const workflows = q.workflows.slice(0, MAX_WORKFLOWS_PER_CALL);
      const runs = q.runs.slice(0, MAX_RUNS_PER_CALL);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? 10_000);
      try {
        await post(
          deps.fetch,
          "cli-sync",
          { client: deps.client, workflows, runs },
          deps.token,
          ctl.signal,
        );
      } catch (err) {
        // a request the server refuses outright (400/413) would block the queue for ever
        if (
          err instanceof HttpError &&
          (err.status === 400 || err.status === 413)
        ) {
          q = {
            workflows: q.workflows.slice(workflows.length),
            runs: q.runs.slice(runs.length),
          };
          await writeQueue(deps.stateDir, q);
          continue;
        }
        return { sent: sentAny };
      } finally {
        clearTimeout(timer);
      }
      sentAny = true;
      // re-read: another command may have queued more while this one was in flight
      const now = await readQueue(deps.stateDir);
      const sentIds = new Set(runs.map((r) => r.id));
      const sentNames = new Map(workflows.map((w) => [w.name, w.updatedAt]));
      q = {
        runs: now.runs.filter((r) => !sentIds.has(r.id)),
        workflows: now.workflows.filter(
          (w) => sentNames.get(w.name) !== w.updatedAt,
        ),
      };
      await writeQueue(deps.stateDir, q);
    }
    return { sent: sentAny };
  } catch {
    return { sent: false };
  }
}
