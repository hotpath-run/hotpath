// task 07: a server that lives in a folder with spaces and non-ASCII
// letters ("C:\Users\Zoé Müller\My Tools") is recorded and replayed like any
// other, on every OS. Nothing is ever joined into a string a shell would split.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const fixtureTrace = path.join(
  repoRoot,
  "packages/compiler/test/fixtures/morning-brief.jsonl",
);

vi.mock("@hotpathrun/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hotpathrun/shared")>();
  return { ...actual, chat: vi.fn() };
});

import { chat, readTrace } from "@hotpathrun/shared";
import { compileTrace } from "@hotpathrun/compiler";
import { runWorkflow } from "../src/index.js";

const chatMock = vi.mocked(chat);
const task = `odd-paths-${Date.now()}`;
let dir: string;
let serverFile: string;
let serverArgv: string[];

beforeAll(async () => {
  process.env.HOTPATH_REUSE = "0";
  dir = await mkdtemp(path.join(os.tmpdir(), "hotpath Zoé Müller 日本-"));
  const tools = path.join(dir, "My Tools (v2)");
  await mkdir(tools, { recursive: true });
  serverFile = path.join(tools, "démo server.mjs");
  // the demo tools, started from a file whose path needs quoting everywhere
  await writeFile(
    serverFile,
    `await import(${JSON.stringify(
      pathToFileURL(path.join(repoRoot, "examples/demo-tools/src/index.ts"))
        .href,
    )});\n`,
  );
  // tsx by its own location: the server's folder has no node_modules
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  serverArgv = [process.execPath, "--import", tsx, serverFile];
});

afterAll(async () => {
  delete process.env.HOTPATH_REUSE;
  await rm(dir, { recursive: true, force: true });
  await rm(path.join(repoRoot, "traces", task), {
    recursive: true,
    force: true,
  });
});

async function latestTrace() {
  const folder = path.join(repoRoot, "traces", task);
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const files = (await readdir(folder)).filter((f) => f.endsWith(".jsonl"));
      return await readTrace(path.join(folder, files.sort().at(-1)!));
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

describe("paths with spaces and non-ASCII letters", () => {
  it("record: the recorder starts the server and keeps its path intact", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        "packages/recorder/src/cli.ts",
        "--task",
        task,
        "--",
        ...serverArgv,
      ],
      cwd: repoRoot,
      env: { ...process.env, DEMO_FIXTURES: "default" } as Record<
        string,
        string
      >,
    });
    const client = new Client({ name: "agent", version: "0.1.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("get_emails");
    await client.callTool({
      name: "get_emails",
      arguments: { date: "2026-10-01" },
    });
    await client.close();

    const trace = await latestTrace();
    expect(trace.meta.serverArgv).toEqual(serverArgv);
    expect(trace.calls.map((c) => c.tool)).toEqual(["get_emails"]);
    expect(trace.calls[0]!.isError).toBe(false);
  }, 60_000);

  it("run: the runtime starts that server from the recorded argv, in a folder with spaces", async () => {
    const workflow = compileTrace(
      await readTrace(fixtureTrace),
      "fixtures/morning-brief.jsonl",
    );
    workflow.task = task;
    workflow.serverArgv = serverArgv;
    workflow.cwd = path.dirname(serverFile);
    const llm = workflow.steps.find((s) => s.type === "llm");
    chatMock.mockResolvedValue({
      text: llm?.type === "llm" ? llm.example : "",
      toolCalls: [],
      promptTokens: 1,
      completionTokens: 1,
      llmCalls: 1,
    });
    const saved = process.env.DEMO_FIXTURES;
    process.env.DEMO_FIXTURES = "default";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const metrics = await runWorkflow(workflow, {
        inputs: { date: "2026-10-01" },
        dryRun: true,
      });
      expect(metrics.toolCalls.map((c) => c.tool)).toEqual([
        "get_emails",
        "get_calendar",
        "get_weather",
      ]);
      expect(metrics.steps.every((s) => s.ok)).toBe(true);
    } finally {
      log.mockRestore();
      if (saved === undefined) delete process.env.DEMO_FIXTURES;
      else process.env.DEMO_FIXTURES = saved;
    }
  }, 60_000);
});
