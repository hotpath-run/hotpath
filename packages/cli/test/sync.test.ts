// What the CLI sends to hotpath.run: summaries only, queued, never blocking.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { syncAfterCommand } from "../src/sync/background.js";
import {
  enqueue,
  enqueueChangedWorkflows,
  flushQueue,
  readQueue,
  syncDisabled,
} from "../src/sync/queue.js";
import { summarizeRun, summarizeWorkflow } from "../src/sync/summary.js";

const SECRETS = {
  arg: "SECRET-ARG-VALUE-123",
  prompt: "SECRET prompt: summarise the payroll",
  example: "SECRET model text about Jane Doe",
  path: "D:\\private\\jane\\notes.txt",
  env: "sk-live-ENVVALUE999",
  input: "SECRET-INPUT-VALUE",
};

const workflow = {
  version: 1,
  task: "issue-triage",
  compiledFrom: `traces/issue-triage/${SECRETS.path}.jsonl`,
  server: "github",
  serverArgv: ["node", SECRETS.path],
  cwd: SECRETS.path,
  inputs: { who: { type: "string", example: SECRETS.input } },
  steps: [
    {
      id: "s1",
      type: "tool",
      tool: "get_issues",
      args: { repo: SECRETS.arg, token: SECRETS.env },
      sideEffect: false,
      guard: {},
    },
    {
      id: "s2",
      type: "foreach",
      over: "steps.s1.result.issues",
      as: "issue",
      maxItems: 50,
      body: [
        {
          id: "s2a",
          type: "tool",
          tool: "get_comments",
          args: { id: SECRETS.arg },
          sideEffect: false,
          guard: {},
        },
      ],
    },
    {
      id: "s3",
      type: "llm",
      model: "m",
      prompt: SECRETS.prompt,
      example: SECRETS.example,
      guard: {},
    },
    {
      id: "s4",
      type: "tool",
      tool: "send_message",
      args: { to: SECRETS.arg, text: SECRETS.example },
      sideEffect: true,
      guard: {},
    },
  ],
  baseline: { durationMs: 12400, costUsd: 0.0176 },
};

let dir: string;
let wfDir: string;
let stateDir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "hotpath-sync-"));
  wfDir = path.join(dir, "workflows");
  stateDir = path.join(dir, ".hotpath");
  await mkdir(wfDir, { recursive: true });
  await writeFile(
    path.join(wfDir, "issue-triage.json"),
    JSON.stringify(workflow),
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function recordingFetch(status = 200) {
  const bodies: string[] = [];
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return new Response(
      JSON.stringify(status === 200 ? { ok: true } : { error: "x" }),
      { status },
    );
  }) as typeof fetch;
  return { fetch: fetchImpl, bodies };
}

describe("summaries", () => {
  it("counts steps and keeps tool names and step kinds only", async () => {
    await enqueueChangedWorkflows(wfDir, stateDir);
    const [w] = (await readQueue(stateDir)).workflows;
    expect(w).toMatchObject({
      name: "issue-triage",
      steps: 4,
      modelSteps: 1,
      toolSteps: 3,
      sideEffects: 1,
    });
    expect(w!.graph.nodes.map((n) => [n.id, n.kind, n.label])).toEqual([
      ["s1", "tool", "get_issues"],
      ["s2", "foreach", "foreach"],
      ["s2a", "tool", "get_comments"],
      ["s3", "llm", "llm"],
      ["s4", "tool", "send_message"],
    ]);
    expect(w!.graph.edges).toContainEqual({ from: "s1", to: "s2" });
    expect(w!.graph.edges).toContainEqual({ from: "s2", to: "s2a" });
    expect(w!.graph.edges).toContainEqual({ from: "s2", to: "s3" });
    expect(w!.graph.edges).toContainEqual({ from: "s3", to: "s4" });
  });

  it("a run carries numbers and the workflow's baseline", () => {
    const r = summarizeRun({
      workflow: "issue-triage",
      kind: "replay",
      ok: true,
      dryRun: true,
      metrics: {
        durationMs: 2600.4,
        llmCalls: 1,
        costUsd: 0.0006,
        fallback: false,
      },
      baseline: workflow.baseline,
      startedAt: new Date("2026-11-19T10:00:00Z"),
      id: "r1",
    });
    expect(r).toEqual({
      id: "r1",
      workflow: "issue-triage",
      kind: "replay",
      ok: true,
      fallback: false,
      dryRun: true,
      durationMs: 2600,
      llmCalls: 1,
      costUsd: 0.0006,
      baselineCostUsd: 0.0176,
      baselineDurationMs: 12400,
      startedAt: "2026-11-19T10:00:00.000Z",
    });
  });

  it("the sync body never holds an argument, model text, path or .env value", async () => {
    const api = recordingFetch();
    // a run whose metrics object carries more than it should: only named fields travel
    const metrics = {
      durationMs: 10,
      llmCalls: 1,
      costUsd: 0.001,
      fallback: false,
      toolCalls: [{ tool: "x", args: { a: SECRETS.arg } }],
      reason: SECRETS.example,
      rejectedOutputs: [SECRETS.example],
    };
    await enqueueChangedWorkflows(wfDir, stateDir);
    await enqueue(stateDir, {
      runs: [
        summarizeRun({
          workflow: "issue-triage",
          kind: "replay",
          ok: true,
          metrics,
          startedAt: new Date(),
        }),
      ],
    });
    await flushQueue({
      fetch: api.fetch,
      stateDir,
      token: "hp_t",
      client: "hotpath-cli/0.3.0",
    });
    expect(api.bodies).toHaveLength(1);
    for (const secret of Object.values(SECRETS)) {
      expect(api.bodies[0]).not.toContain(secret);
    }
    expect(api.bodies[0]).toContain("get_issues");
    // not the folder names either
    expect(api.bodies[0]).not.toContain(dir);
  });
});

describe("the queue", () => {
  it("queues a workflow once, and again only when it changes", async () => {
    expect(await enqueueChangedWorkflows(wfDir, stateDir)).toBe(1);
    expect(await enqueueChangedWorkflows(wfDir, stateDir)).toBe(0);
    await writeFile(
      path.join(wfDir, "issue-triage.json"),
      JSON.stringify({ ...workflow, steps: workflow.steps.slice(0, 1) }),
    );
    expect(await enqueueChangedWorkflows(wfDir, stateDir)).toBe(1);
    expect((await readQueue(stateDir)).workflows).toHaveLength(1);
    expect((await readQueue(stateDir)).workflows[0]!.steps).toBe(1);
  });

  it("ignores backups and files that are not workflows", async () => {
    await writeFile(
      path.join(wfDir, "issue-triage.2026.bak.json"),
      JSON.stringify(workflow),
    );
    await writeFile(path.join(wfDir, "junk.json"), "{ not json");
    expect(await enqueueChangedWorkflows(wfDir, stateDir)).toBe(1);
  });

  it("keeps what it could not send, and sends it with the next call", async () => {
    await enqueueChangedWorkflows(wfDir, stateDir);
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const first = await flushQueue({
      fetch: down,
      stateDir,
      token: "t",
      client: "c",
    });
    expect(first.sent).toBe(false);
    expect((await readQueue(stateDir)).workflows).toHaveLength(1);

    const up = recordingFetch();
    const second = await flushQueue({
      fetch: up.fetch,
      stateDir,
      token: "t",
      client: "c",
    });
    expect(second.sent).toBe(true);
    expect(up.bodies).toHaveLength(1);
    expect(await readQueue(stateDir)).toEqual({ workflows: [], runs: [] });
  });

  it("keeps the queue on a 401", async () => {
    await enqueueChangedWorkflows(wfDir, stateDir);
    const api = recordingFetch(401);
    await flushQueue({ fetch: api.fetch, stateDir, token: "bad", client: "c" });
    expect((await readQueue(stateDir)).workflows).toHaveLength(1);
  });

  it("drops a batch the server refuses as invalid, so it cannot block the queue", async () => {
    await enqueueChangedWorkflows(wfDir, stateDir);
    const api = recordingFetch(400);
    await flushQueue({ fetch: api.fetch, stateDir, token: "t", client: "c" });
    expect(await readQueue(stateDir)).toEqual({ workflows: [], runs: [] });
  });

  it("sends at most 500 runs per call", async () => {
    const runs = Array.from({ length: 1200 }, (_, i) =>
      summarizeRun({
        workflow: "w",
        kind: "replay",
        ok: true,
        metrics: { durationMs: 1, llmCalls: 0, costUsd: 0, fallback: false },
        startedAt: new Date(),
        id: `r${i}`,
      }),
    );
    await enqueue(stateDir, { runs });
    const api = recordingFetch();
    await flushQueue({ fetch: api.fetch, stateDir, token: "t", client: "c" });
    expect(api.bodies.map((b) => JSON.parse(b).runs.length)).toEqual([
      500, 500, 200,
    ]);
  });
});

describe("after a command", () => {
  const ctx = (env: NodeJS.ProcessEnv, started: { n: number }) => ({
    stateDir,
    workflowsDir: wfDir,
    env,
    startFlush: () => {
      started.n++;
    },
  });

  it("queues, starts the background send and returns without touching the network", async () => {
    const started = { n: 0 };
    await syncAfterCommand(ctx({}, started), [
      summarizeRun({
        workflow: "issue-triage",
        kind: "replay",
        ok: true,
        metrics: { durationMs: 1, llmCalls: 0, costUsd: 0, fallback: false },
        startedAt: new Date(),
      }),
    ]);
    expect(started.n).toBe(1);
    const q = await readQueue(stateDir);
    expect(q.runs).toHaveLength(1);
    expect(q.workflows).toHaveLength(1);
    expect(
      JSON.parse(
        await readFile(path.join(stateDir, "sync-queue.json"), "utf8"),
      ),
    ).toBeTruthy();
  });

  it("HOTPATH_NO_SYNC=1 turns it off completely", async () => {
    const started = { n: 0 };
    await syncAfterCommand(ctx({ HOTPATH_NO_SYNC: "1" }, started));
    expect(started.n).toBe(0);
    expect(await readQueue(stateDir)).toEqual({ workflows: [], runs: [] });
    expect(syncDisabled({ HOTPATH_NO_SYNC: "1" })).toBe(true);
    expect(syncDisabled({})).toBe(false);
  });

  it("never throws, even when the project folder cannot be written", async () => {
    const blocked = path.join(dir, "file-not-folder");
    await writeFile(blocked, "x");
    await expect(
      syncAfterCommand({
        stateDir: path.join(blocked, "nope"),
        workflowsDir: wfDir,
        env: {},
        startFlush: () => {
          throw new Error("boom");
        },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("workflow summary on its own", () => {
  it("handles a branch", () => {
    const w = summarizeWorkflow(
      {
        ...workflow,
        steps: [
          {
            id: "b1",
            type: "branch",
            cases: [
              {
                when: {
                  kind: "contains",
                  path: "x",
                  value: SECRETS.arg,
                } as never,
                steps: [workflow.steps[0] as never],
              },
            ],
          },
        ],
      } as never,
      new Date(0),
    );
    expect(w.graph.nodes.map((n) => n.label)).toEqual(["branch", "get_issues"]);
    expect(JSON.stringify(w)).not.toContain(SECRETS.arg);
  });
});
