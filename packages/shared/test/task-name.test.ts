import { describe, expect, it } from "vitest";

import { traceMetaSchema, workflowSchema } from "../src/schemas.js";
import {
  assertTaskName,
  TaskNameError,
  taskNameProblem,
} from "../src/task-name.js";

describe("task names", () => {
  it("accepts ordinary names, including spaces and accents", () => {
    for (const name of [
      "morning-brief",
      "t",
      "cc-brief",
      "weekly_report.v2",
      "rapport hebdo",
      "résumé du matin",
      "日报",
    ]) {
      expect(taskNameProblem(name), name).toBeNull();
      expect(assertTaskName(name)).toBe(name);
    }
  });

  it("refuses names that would leave the project folder", () => {
    for (const name of [
      "../x",
      "..",
      "a/b",
      "a\\b",
      "C:evil",
      "/etc/passwd",
      ".hidden",
      "x\u0000y",
    ]) {
      expect(taskNameProblem(name), name).not.toBeNull();
      expect(() => assertTaskName(name)).toThrow(TaskNameError);
    }
  });

  it("refuses names that break on Windows or look like a flag", () => {
    for (const name of [
      "nul",
      "CON",
      "com1.txt",
      "name.",
      " name",
      "-rf",
      "",
    ]) {
      expect(taskNameProblem(name), name).not.toBeNull();
    }
    expect(taskNameProblem("x".repeat(101))).toMatch(/longer/);
  });

  it("says what to do next", () => {
    expect(() => assertTaskName("../x")).toThrow(/Use a short name such as/);
  });
});

describe("task names read from files", () => {
  const meta = {
    type: "meta",
    version: 1,
    startedAt: "2026-10-01T07:00:00.000Z",
    server: "x",
    inputs: {},
    tools: [],
  };
  const workflow = {
    version: 1,
    compiledFrom: "t.jsonl",
    server: "x",
    inputs: {},
    steps: [],
  };

  it("a trace or workflow naming a path as its task does not validate", () => {
    expect(traceMetaSchema.safeParse({ ...meta, task: "ok" }).success).toBe(
      true,
    );
    expect(
      traceMetaSchema.safeParse({ ...meta, task: "../../x" }).success,
    ).toBe(false);
    expect(workflowSchema.safeParse({ ...workflow, task: "ok" }).success).toBe(
      true,
    );
    expect(
      workflowSchema.safeParse({ ...workflow, task: "..\\..\\x" }).success,
    ).toBe(false);
  });
});
