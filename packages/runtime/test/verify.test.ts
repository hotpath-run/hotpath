import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// a model must never be asked here: fail loudly if it is
vi.mock("@hotpathrun/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hotpathrun/shared")>();
  return {
    ...actual,
    chat: vi.fn(() => {
      throw new Error("verifyOnRecording asked a model");
    }),
  };
});

import { compileTraceDetailed, markCalculations } from "@hotpathrun/compiler";
import { readTrace, type TraceFile, type Workflow } from "@hotpathrun/shared";

import { verifyOnRecording } from "../src/verify.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const fixture = (name: string) =>
  readTrace(path.join(repoRoot, "packages/compiler/test/fixtures", name));

function compile(trace: TraceFile, task: string): Workflow {
  const { workflow, recorded } = compileTraceDetailed(trace, "x");
  return {
    ...markCalculations(workflow, recorded, trace.meta.inputs),
    task,
  };
}
afterEach(async () => {
  for (const t of ["verify-mb", "verify-br"]) {
    await rm(path.join(repoRoot, ".hotpath", "answers", `${t}.json`), {
      force: true,
    });
  }
});

describe("verifyOnRecording", () => {
  it("finds nothing wrong when the workflow reproduces its recording", async () => {
    const mb = await fixture("morning-brief.jsonl");
    expect(await verifyOnRecording(compile(mb, "verify-mb"), mb)).toEqual([]);
    const br = await fixture("bank-reconciliation.jsonl");
    expect(await verifyOnRecording(compile(br, "verify-br"), br)).toEqual([]);
  });

  it("names a step whose arguments do not come out as recorded", async () => {
    const mb = await fixture("morning-brief.jsonl");
    const wf = compile(mb, "verify-mb");
    const weather = wf.steps.find(
      (s) => s.type === "tool" && s.tool === "get_weather",
    );
    if (weather?.type !== "tool") throw new Error("no weather step");
    weather.args = { ...weather.args, city: "Lyon" };
    const problems = await verifyOnRecording(wf, mb);
    expect(problems.join("\n")).toMatch(/get_weather.*Lyon.*never did/);
  });

  it("says when the recorded text fails the workflow's own checks", async () => {
    const br = await fixture("bank-reconciliation.jsonl");
    const send = br.calls.at(-1)!;
    // a recording whose total is wrong: code computes -297.5, the text says -332
    const wrong = {
      ...br,
      calls: [
        ...br.calls.slice(0, -1),
        {
          ...send,
          args: {
            ...send.args,
            text: String(send.args.text).replace(
              "Total unmatched amount: -297.5",
              "Total unmatched amount: -332",
            ),
          },
        },
      ],
    };
    // the workflow learned from the good recording, checked against the wrong one
    const wf = compile(br, "verify-br");
    const step = wf.steps.find((s) => s.type === "llm");
    if (step?.type !== "llm") throw new Error("no llm step");
    step.example = String(wrong.calls.at(-1)!.args.text);
    const problems = await verifyOnRecording(wf, wrong as TraceFile);
    expect(problems.join("\n")).toMatch(
      /does not pass this workflow's own checks.*-297\.5/,
    );
  });
});
