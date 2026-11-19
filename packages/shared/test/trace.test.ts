import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { readTrace } from "../src/index.js";

const meta = {
  type: "meta",
  version: 1,
  task: "t",
  startedAt: "2026-10-01T08:00:00.000Z",
  server: "node tools.js",
  inputs: {},
  tools: [],
};
const call = (seq: number, startedAt: string, durationMs: number) => ({
  type: "tool_call",
  seq,
  tool: "get_emails",
  args: {},
  result: { ok: true },
  isError: false,
  startedAt,
  durationMs,
});

async function traceFile(lines: unknown[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hotpath-trace-"));
  const file = path.join(dir, "trace.jsonl");
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

// A client like Claude Code keeps the MCP server (and so the recorder) running
// for its whole session, so the trace of a finished task has no `end` line yet.
describe("readTrace on a trace that is still being written", () => {
  const open = [
    meta,
    call(1, "2026-10-01T08:00:01.000Z", 40),
    call(2, "2026-10-01T08:00:05.000Z", 250),
  ];

  it("rejects it by default", async () => {
    await expect(readTrace(await traceFile(open))).rejects.toThrow(
      /missing a meta or end line/,
    );
  });

  it("with allowOpen, reads it and marks it open, ending at the last call", async () => {
    const trace = await readTrace(await traceFile(open), { allowOpen: true });
    expect(trace.open).toBe(true);
    expect(trace.calls).toHaveLength(2);
    expect(trace.end).toEqual({
      type: "end",
      endedAt: "2026-10-01T08:00:05.250Z",
      toolCalls: 2,
    });
  });

  it("with allowOpen, a closed trace is read as closed", async () => {
    const closed = [
      ...open,
      { type: "end", endedAt: "2026-10-01T08:01:00.000Z", toolCalls: 2 },
    ];
    const trace = await readTrace(await traceFile(closed), { allowOpen: true });
    expect(trace.open).toBeFalsy();
    expect(trace.end.endedAt).toBe("2026-10-01T08:01:00.000Z");
  });

  it("with allowOpen, still needs the meta line", async () => {
    await expect(
      readTrace(await traceFile(open.slice(1)), { allowOpen: true }),
    ).rejects.toThrow(/missing a meta/);
  });

  it("ignores a half-written last line of an open trace", async () => {
    const file = await traceFile(open);
    await writeFile(file, '{"type":"tool_call","seq":3,"tool":"get_', {
      flag: "a",
    });
    const trace = await readTrace(file, { allowOpen: true });
    expect(trace.calls).toHaveLength(2);
  });
});
