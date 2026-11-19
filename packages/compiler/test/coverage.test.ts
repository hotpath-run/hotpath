// task 02: a workflow is only as good as the recording it was learned
// from. The compiler says what the recorded message covers, `--require` makes a
// field required for every item, and several recordings teach more than one.
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  projectRoot,
  workflowSchema,
  type LlmStep,
  type TraceFile,
  type TraceToolCall,
  type Workflow,
} from "@hotpathrun/shared";

import {
  applyRequirements,
  compileTaskInMemory,
  compileTraceDetailed,
  compileTraces,
  coverageWarnings,
  inferSchema,
  listCoverage,
  lostGrounding,
  parseRequirement,
  recordingWarnings,
  RequireError,
} from "../src/index.js";

const tools = [
  { name: "get_emails", inputSchema: {}, annotations: { readOnlyHint: true } },
  {
    name: "get_calendar",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  { name: "send_message", inputSchema: {} },
];

const EMAILS = [
  { id: "e1", from: "alice@corp.com", subject: "Q3 budget review moved" },
  { id: "e2", from: "bob@corp.com", subject: "Team offsite agenda" },
  { id: "e3", from: "news@city.io", subject: "Metro line 4 closed" },
];
const EVENTS = [
  { time: "09:30", title: "Standup with Platform team" },
  { time: "14:00", title: "Dentist appointment" },
];

function trace(
  text: string,
  options: { date?: string; task?: string; emails?: unknown[] } = {},
): TraceFile {
  const date = options.date ?? "2026-10-01";
  const calls: Array<Pick<TraceToolCall, "tool" | "args" | "result">> = [
    {
      tool: "get_emails",
      args: { date },
      result: { emails: options.emails ?? EMAILS },
    },
    {
      tool: "get_calendar",
      args: { date },
      result: { events: EVENTS, owner: "Marguerite Dupont" },
    },
    { tool: "send_message", args: { to: "me", text }, result: { ok: true } },
  ];
  return {
    meta: {
      type: "meta",
      version: 1,
      task: options.task ?? "brief",
      startedAt: `${date}T08:00:00Z`,
      server: "node tools.js",
      inputs: { date },
      tools,
    },
    calls: calls.map((c, i) => ({
      type: "tool_call",
      seq: i + 1,
      isError: false,
      startedAt: `${date}T08:00:0${i}Z`,
      durationMs: 5,
      ...c,
    })),
    end: { type: "end", endedAt: `${date}T08:01:00Z`, toolCalls: calls.length },
  };
}

const FULL =
  "Morning brief.\nEmails: Q3 budget review moved; Team offsite agenda; Metro line 4 closed.\n" +
  "Calendar: Standup with Platform team, then Dentist appointment.";
const ONE_EMAIL =
  "Morning brief.\nEmails: Q3 budget review moved, and two more.\n" +
  "Calendar: Standup with Platform team, then Dentist appointment.";
const NO_EMAILS =
  "Morning brief for today, nothing special in the inbox.\n" +
  "Calendar: Standup with Platform team, then Dentist appointment.";
const PLACEHOLDER =
  "Morning brief.\nEmails: [Subject1, Subject2]\nCalendar: [Event1, Event2]";

const compile = (t: TraceFile) =>
  compileTraceDetailed(t, "traces/brief/x.jsonl");
const llm = (w: Workflow) =>
  w.steps.find((s): s is LlmStep => s.type === "llm")!;
const wildcards = (w: Workflow) =>
  (llm(w).guard.grounding ?? [])
    // `positions` entries ask for some items, not every item: not a requirement per item
    .filter((g) => g.positions === undefined)
    .flatMap((g) => g.paths)
    .filter((p) => p.includes("*"))
    .sort();

describe("coverage of the recorded message", () => {
  it("a message that covers every item: every list is required, no warning", () => {
    const { workflow, recorded } = compile(trace(FULL));
    const coverage = listCoverage(workflow, recorded);
    expect(coverage).toEqual([
      {
        step: "s3",
        list: "steps.s1.result.emails",
        items: 3,
        field: "subject",
        mentioned: 3,
        required: true,
      },
      {
        step: "s3",
        list: "steps.s2.result.events",
        items: 2,
        field: "title",
        mentioned: 2,
        required: true,
      },
    ]);
    expect(coverageWarnings(coverage)).toEqual([]);
  });

  it("warns when the message mentions few items, and says how to require them all", () => {
    const { workflow, recorded } = compile(trace(ONE_EMAIL));
    const warnings = coverageWarnings(listCoverage(workflow, recorded));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("mentions 1 of 3 emails");
    expect(warnings[0]).toContain("only required to mention that one");
    expect(warnings[0]).toContain("--require steps.s1.result.emails.*.subject");
    expect(warnings[0]).toContain("record the task again");
  });

  it("warns when a whole list is left out, naming the field a reader would expect", () => {
    const { workflow, recorded } = compile(trace(NO_EMAILS));
    const warnings = coverageWarnings(listCoverage(workflow, recorded));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("mentions none of the 3 emails");
    expect(warnings[0]).toContain("will not check for them");
    expect(warnings[0]).toContain("--require steps.s1.result.emails.*.subject");
  });

  it("most items mentioned (2 of 3) is already required for every item: no warning", () => {
    const text = FULL.replace("; Metro line 4 closed", "");
    const { workflow, recorded } = compile(trace(text));
    expect(wildcards(workflow)).toContain("steps.s1.result.emails.*.subject");
    expect(coverageWarnings(listCoverage(workflow, recorded))).toEqual([]);
  });

  it("counts lists of the same shape together (the items of every loop result)", () => {
    const workflow = workflowSchema.parse({
      version: 1,
      task: "report",
      compiledFrom: "x",
      server: "x",
      inputs: {},
      steps: [
        {
          id: "s5",
          type: "llm",
          model: "cheap",
          prompt: "s2 results:\n{{steps.s2.results}}",
          example: "Report: fix login bug.",
          guard: {},
        },
      ],
    });
    const coverage = listCoverage(workflow, [
      {
        id: "s2",
        field: "results",
        result: [
          { commits: [{ message: "fix login bug" }, { message: "add tests" }] },
          { commits: [{ message: "bump version" }] },
        ],
      },
    ]);
    expect(coverage).toContainEqual({
      step: "s5",
      list: "steps.s2.results.*.commits",
      items: 3,
      field: "message",
      mentioned: 1,
      required: false,
    });
  });

  it("recordingWarnings: a message that mentions nothing it read is called a placeholder", () => {
    const t = trace(PLACEHOLDER);
    const { workflow, recorded } = compile(t);
    const warnings = recordingWarnings(t, workflow, recorded);
    expect(warnings.some((w) => w.includes("mentions nothing"))).toBe(true);
    // one clear warning instead of one per list
    expect(warnings.filter((w) => w.includes("mentions none of"))).toEqual([]);
    // and a complete recording stays quiet
    const good = trace(FULL);
    const ok = compile(good);
    expect(recordingWarnings(good, ok.workflow, ok.recorded)).toEqual([]);
  });
});

describe("--require", () => {
  it("makes a field required for every item, and is kept in the workflow", () => {
    const { workflow, recorded } = compile(trace(NO_EMAILS));
    expect(wildcards(workflow)).not.toContain(
      "steps.s1.result.emails.*.subject",
    );
    const result = applyRequirements(
      workflow,
      recorded,
      ["steps.s1.result.emails.*.subject"],
      true,
    );
    expect(wildcards(result.workflow)).toContain(
      "steps.s1.result.emails.*.subject",
    );
    expect(result.workflow.require).toEqual([
      "steps.s1.result.emails.*.subject",
    ]);
    expect(result.applied).toEqual([
      "s3 must mention steps.s1.result.emails.*.subject (3 items in the recording)",
    ]);
    expect(workflowSchema.parse(result.workflow)).toEqual(result.workflow);
    // the warning for that list is gone
    expect(coverageWarnings(listCoverage(result.workflow, recorded))).toEqual(
      [],
    );
    // applying it twice changes nothing
    const again = applyRequirements(
      result.workflow,
      recorded,
      ["steps.s1.result.emails.*.subject"],
      true,
    );
    expect(again.workflow.steps).toEqual(result.workflow.steps);
  });

  it("can name the AI step, and refuses one that does not read the data", () => {
    const { workflow, recorded } = compile(trace(NO_EMAILS));
    expect(parseRequirement("s3:steps.s1.result.emails.*.subject")).toEqual({
      step: "s3",
      path: "steps.s1.result.emails.*.subject",
    });
    const ok = applyRequirements(
      workflow,
      recorded,
      ["s3:steps.s1.result.emails.*.subject"],
      true,
    );
    expect(wildcards(ok.workflow)).toContain(
      "steps.s1.result.emails.*.subject",
    );
    expect(() =>
      applyRequirements(
        workflow,
        recorded,
        ["s9:steps.s1.result.emails.*.subject"],
        true,
      ),
    ).toThrow(/s9 is not an AI step that reads s1/);
  });

  it("says what to do for a path that does not fit the recording", () => {
    const { workflow, recorded } = compile(trace(NO_EMAILS));
    const bad = (p: string) => () =>
      applyRequirements(workflow, recorded, [p], true);
    expect(bad("emails.subject")).toThrow(RequireError);
    expect(bad("emails.subject")).toThrow(/steps\.<id>\.result/);
    expect(bad("steps.s7.result.emails.*.subject")).toThrow(/no step s7/);
    expect(bad("steps.s1.result.emails.*")).toThrow(/no text or number/);
    expect(bad("steps.s1.result.emails.*.nope")).toThrow(
      /no text or number|no items/,
    );
  });

  it("carried over from an earlier workflow: a path that no longer fits is a warning", () => {
    const { workflow, recorded } = compile(trace(NO_EMAILS));
    const result = applyRequirements(
      workflow,
      recorded,
      ["steps.s7.result.rows.*.name", "steps.s1.result.emails.*.subject"],
      false,
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("not applied");
    // both stay listed, so the user sees what was asked for
    expect(result.workflow.require).toEqual([
      "steps.s7.result.rows.*.name",
      "steps.s1.result.emails.*.subject",
    ]);
    expect(wildcards(result.workflow)).toContain(
      "steps.s1.result.emails.*.subject",
    );
  });
});

describe("--require through compileTaskInMemory", () => {
  const task = `require-${Date.now()}`;
  const tracesDir = path.join(projectRoot(), "traces", task);
  const workflowFile = path.join(projectRoot(), "workflows", `${task}.json`);
  const toJsonl = (t: TraceFile) =>
    [t.meta, ...t.calls, t.end].map((l) => JSON.stringify(l)).join("\n") + "\n";

  afterAll(async () => {
    await rm(tracesDir, { recursive: true, force: true });
    await rm(workflowFile, { force: true });
  });

  it("applies it, and a recompile without the flag keeps it", async () => {
    await mkdir(tracesDir, { recursive: true });
    const file = path.join(tracesDir, "2026-10-01T08-00-00-000Z.jsonl");
    await writeFile(file, toJsonl(trace(NO_EMAILS, { task })));

    const first = await compileTaskInMemory(task, file, {
      require: ["steps.s1.result.emails.*.subject"],
    });
    expect(wildcards(first.workflow)).toContain(
      "steps.s1.result.emails.*.subject",
    );
    expect(first.notes).toContain(
      "s3 must mention steps.s1.result.emails.*.subject (3 items in the recording)",
    );
    expect(first.warnings.join("\n")).not.toContain("mentions none of");

    await mkdir(path.dirname(workflowFile), { recursive: true });
    await writeFile(workflowFile, JSON.stringify(first.workflow));
    // what a fallback does: compile again, no flags
    const second = await compileTaskInMemory(task);
    expect(second.workflow.require).toEqual([
      "steps.s1.result.emails.*.subject",
    ]);
    expect(wildcards(second.workflow)).toContain(
      "steps.s1.result.emails.*.subject",
    );
  });

  it("a mistyped path stops the compile with what to type instead", async () => {
    const file = path.join(tracesDir, "2026-10-01T08-00-00-000Z.jsonl");
    await expect(
      compileTaskInMemory(task, file, { require: ["subject"] }),
    ).rejects.toThrow(RequireError);
  });
});

describe("learning from several recordings", () => {
  it("a field any recording mentioned for most items is required", () => {
    const older = trace(FULL, { date: "2026-09-30" });
    const newest = trace(NO_EMAILS, { date: "2026-10-01" });
    const alone = compileTraces([newest], "x").workflow;
    expect(wildcards(alone)).toEqual(["steps.s2.result.events.*.title"]);

    const both = compileTraces([older, newest], "x");
    expect(wildcards(both.workflow)).toEqual([
      "steps.s1.result.emails.*.subject",
      "steps.s2.result.events.*.title",
    ]);
    // the newest recording is still the one that is replayed
    expect(llm(both.workflow).example).toBe(NO_EMAILS);
    expect(both.notes.join("\n")).toContain("steps.s1.result.emails.*.subject");
  });

  it("a field mentioned for one item only is not learned from the other recording either", () => {
    const older = trace(ONE_EMAIL, { date: "2026-09-30" });
    const newest = trace(NO_EMAILS, { date: "2026-10-01" });
    expect(wildcards(compileTraces([older, newest], "x").workflow)).toEqual([
      "steps.s2.result.events.*.title",
    ]);
  });

  it("a plain value another recording mentioned is learned; one item of a list is not", () => {
    const older = trace(`${ONE_EMAIL} Calendar of Marguerite Dupont.`, {
      date: "2026-09-30",
    });
    const newest = trace(NO_EMAILS, { date: "2026-10-01" });
    const paths = (
      llm(compileTraces([older, newest], "x").workflow).guard.grounding ?? []
    ).flatMap((g) => g.paths);
    expect(paths).toContain("steps.s2.result.owner");
    // the older run's first email is that day's email
    expect(paths).not.toContain("steps.s1.result.emails.0.subject");
  });

  it("recordings from before a tool changed still teach nothing", () => {
    const older = trace(FULL, {
      date: "2026-09-30",
      emails: EMAILS.map(({ subject, ...rest }) => ({
        ...rest,
        title: subject,
      })),
    });
    const newest = trace(NO_EMAILS, { date: "2026-10-01" });
    expect(wildcards(compileTraces([older, newest], "x").workflow)).toEqual([
      "steps.s2.result.events.*.title",
    ]);
  });
});

describe("lostGrounding (recompile safety)", () => {
  it("a recompile whose message mentions nothing from the data is reported", () => {
    const old = compile(trace(FULL)).workflow;
    const junk = compile(trace(PLACEHOLDER)).workflow;
    expect(lostGrounding(old, junk)).toEqual([
      "what the AI step s3 must mention",
    ]);
  });

  it("a recompile that still mentions some of the data is accepted", () => {
    const old = compile(trace(FULL)).workflow;
    expect(lostGrounding(old, compile(trace(NO_EMAILS)).workflow)).toEqual([]);
    expect(lostGrounding(old, old)).toEqual([]);
    // nothing to lose
    const junk = compile(trace(PLACEHOLDER)).workflow;
    expect(lostGrounding(junk, junk)).toEqual([]);
  });
});

describe("tool guard for lists", () => {
  it("requires only the keys every recorded item has", () => {
    const schema = inferSchema({
      emails: [
        { id: "e1", subject: "a", attachment: "x.pdf" },
        { id: "e2", subject: "b" },
      ],
    }) as {
      properties: { emails: { items: { required: string[] } } };
    };
    expect(schema.properties.emails.items.required).toEqual(["id", "subject"]);
  });

  it("an empty list still says nothing about its items", () => {
    expect(inferSchema({ emails: [] })).toEqual({
      type: "object",
      properties: { emails: { type: "array", items: {} } },
      required: ["emails"],
    });
  });
});
