import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  answerKey,
  mentions,
  readTrace,
  renderTemplate,
  workflowSchema,
  type Workflow,
} from "@hotpathrun/shared";

import {
  collectGrounding,
  compileTaskInMemory,
  compileTrace,
  formatWorkflow,
  lostActions,
  lostReadOnlySteps,
  recordingWarnings,
} from "../src/index.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/morning-brief.jsonl",
);

async function compileFixture(): Promise<Workflow> {
  const trace = await readTrace(fixture);
  return workflowSchema.parse(
    compileTrace(trace, "traces/morning-brief/fixture.jsonl"),
  );
}

describe("compiler (fixture trace)", () => {
  it("produces a workflow that validates against the schema", async () => {
    const wf = await compileFixture();
    expect(wf.version).toBe(1);
    expect(wf.task).toBe("morning-brief");
    expect(wf.server).toBe("pnpm --silent --filter demo-tools start");
    expect(wf.inputs.date).toEqual({ type: "string", example: "2026-10-01" });
  });

  it("carries the server argv and cwd from the trace, when recorded", async () => {
    const trace = await readTrace(fixture);
    await expect(compileFixture()).resolves.not.toHaveProperty("serverArgv");
    const argv = ["C:\\Program Files\\nodejs\\node.exe", "C:\\My Tools\\s.js"];
    const wf = workflowSchema.parse(
      compileTrace(
        { ...trace, meta: { ...trace.meta, serverArgv: argv, cwd: "/srv" } },
        "traces/morning-brief/fixture.jsonl",
      ),
    );
    expect(wf.serverArgv).toEqual(argv);
    expect(wf.cwd).toBe("/srv");
  });

  it("templates input args and keeps constants", async () => {
    const wf = await compileFixture();
    const byId = Object.fromEntries(wf.steps.map((s) => [s.id, s]));

    const emails = byId.s1;
    expect(emails.type).toBe("tool");
    if (emails.type === "tool") {
      expect(emails.args).toEqual({ date: "{{inputs.date}}" });
      expect(emails.sideEffect).toBe(false);
    }

    const weather = byId.s3;
    if (weather.type === "tool") {
      expect(weather.args.city).toBe("Paris"); // constant
      expect(weather.args.date).toBe("{{inputs.date}}");
    }

    const send = byId.s5;
    if (send.type === "tool") {
      expect(send.args.to).toBe("me"); // constant
      expect(send.args.text).toBe("{{steps.s4.output}}");
      expect(send.sideEffect).toBe(true);
    }
  });

  it("inserts exactly one llm step feeding send_message.text", async () => {
    const wf = await compileFixture();
    const llmSteps = wf.steps.filter((s) => s.type === "llm");
    expect(llmSteps).toHaveLength(1);
    const llm = llmSteps[0];
    expect(llm.id).toBe("s4"); // just before send_message
    if (llm.type === "llm") {
      expect(llm.model).toBe("cheap");
      expect(llm.example).toContain("Q3 budget review moved to 14:00");
      expect(llm.prompt).toContain("write the `text` for `send_message`");
      // prompt includes earlier read-only results
      expect(llm.prompt).toContain("get_emails");
      expect(llm.prompt).toContain("get_calendar");
      expect(llm.prompt).toContain("get_weather");
      // results are templates, never baked-in recorded data (else new data is ignored)
      expect(llm.prompt).toContain("{{steps.s1.result}}");
      expect(llm.prompt).toContain("{{steps.s2.result}}");
      expect(llm.prompt).toContain("{{steps.s3.result}}");
      expect(llm.prompt).not.toContain("alice@corp.com");
      // constant sibling args tell the model who the text is for
      expect(llm.prompt).toContain(
        'write the `text` for `send_message` (to="me")',
      );
      expect(llm.guard.nonEmpty).toBe(true);
      expect(llm.guard.maxChars).toBeGreaterThanOrEqual(3 * llm.example.length);
    }
    // order: s1..s3 tools, s4 llm, s5 tool
    expect(wf.steps.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
  });

  it("infers guards from recorded results (get_emails requires subject)", async () => {
    const wf = await compileFixture();
    const emails = wf.steps.find(
      (s) => s.type === "tool" && s.tool === "get_emails",
    )!;
    if (emails.type !== "tool") throw new Error("unreachable");
    const schema = emails.guard.schema as {
      type: string;
      properties: { emails: { items: { required: string[] } } };
    };
    expect(schema.type).toBe("object");
    expect(schema.properties.emails.type).toBe("array");
    expect(schema.properties.emails.items.required).toContain("subject");
  });

  it("is deterministic: two compiles are byte-identical", async () => {
    const trace = await readTrace(fixture);
    const a = compileTrace(trace, "traces/morning-brief/fixture.jsonl");
    const b = compileTrace(trace, "traces/morning-brief/fixture.jsonl");
    expect(JSON.stringify(a, null, 2)).toBe(JSON.stringify(b, null, 2));
  });

  it("show format prints readable steps", async () => {
    const wf = await compileFixture();
    const text = formatWorkflow(wf);
    expect(text).toContain("s1 tool get_emails(date={{inputs.date}})");
    expect(text).toContain("s4 llm (cheap) → s5.text");
    expect(text).toContain("s5 tool send_message(");
    expect(text).toContain("to=me");
  });
});

describe("grounding guard (compile time)", () => {
  async function grounding() {
    const wf = await compileFixture();
    const llm = wf.steps.find((s) => s.type === "llm")!;
    return { llm, entries: llm.guard.grounding ?? [] };
  }
  const pathsOf = (
    entries: Array<{ value: unknown; paths: string[] }>,
    v: unknown,
  ) => entries.find((e) => e.value === v)?.paths;

  it("records result values the example output mentions, with where they came from", async () => {
    const { entries } = await grounding();
    // every email subject and event title is mentioned in the recording, so
    // the whole field is required for every item (see "list fields" below)
    expect(pathsOf(entries, "Q3 budget review moved to 14:00")).toEqual([
      "steps.s1.result.emails.*.subject",
    ]);
    expect(pathsOf(entries, "Standup with Platform team")).toEqual([
      "steps.s2.result.events.*.title",
    ]);
    expect(pathsOf(entries, "Paris")).toEqual(["steps.s3.result.city"]);
    expect(pathsOf(entries, 21)).toEqual(["steps.s3.result.highC"]);
    expect(pathsOf(entries, 11)).toEqual(["steps.s3.result.lowC"]);
  });

  it("only records values the example really mentions", async () => {
    const { llm, entries } = await grounding();
    if (llm.type !== "llm") throw new Error("expected an llm step");
    expect(entries.length).toBeGreaterThan(5);
    for (const e of entries) expect(mentions(llm.example, e.value)).toBe(true);
  });

  it("skips trivial values (short strings, single digits)", async () => {
    const { entries } = await grounding();
    for (const e of entries) {
      if (typeof e.value === "string")
        expect(e.value.trim().length).toBeGreaterThanOrEqual(4);
      else
        expect(Math.abs(e.value) >= 10 || !Number.isInteger(e.value)).toBe(
          true,
        );
    }
  });

  it("tool steps get no grounding", async () => {
    const wf = await compileFixture();
    for (const s of wf.steps) {
      if (s.type === "tool") expect(s.guard.grounding).toBeUndefined();
    }
  });
});

// The recorded example is shown to the replay model for style; small models
// copy its facts (yesterday's temperature, a clash with yesterday's meeting).
// The compiler keeps every fact the example took from the data, item by item,
// so the runtime can reject the ones that are no longer in the data.
describe("example facts (stale-fact check, compile time)", () => {
  async function facts() {
    const wf = await compileFixture();
    const llm = wf.steps.find((s) => s.type === "llm")!;
    if (llm.type !== "llm") throw new Error("expected an llm step");
    return { llm, facts: llm.guard.exampleFacts ?? [] };
  }

  it("records every result value the example mentions, for every item", async () => {
    const { facts: f } = await facts();
    expect(f).toEqual(
      expect.arrayContaining([
        "Q3 budget review moved to 14:00",
        "Standup with Platform team",
        "Dentist appointment",
        "Paris",
        21,
        11,
      ]),
    );
  });

  it("only records values the example really mentions, once each", async () => {
    const { llm, facts: f } = await facts();
    if (llm.type !== "llm") throw new Error("expected an llm step");
    for (const v of f) expect(mentions(llm.example, v)).toBe(true);
    expect(new Set(f).size).toBe(f.length);
  });

  it("tool steps get none", async () => {
    const wf = await compileFixture();
    for (const s of wf.steps) {
      if (s.type === "tool") expect(s.guard.exampleFacts).toBeUndefined();
    }
  });
});

// A replay on the recorded data asks the replay model the question the agent
// already answered: the compiler keys that question so the runtime can skip it.
describe("input key (answer reuse, compile time)", () => {
  it("is the answer key of the example and the prompt rendered on the recorded data", async () => {
    const trace = await readTrace(fixture);
    const wf = await compileFixture();
    const llm = wf.steps.find((s) => s.type === "llm")!;
    if (llm.type !== "llm") throw new Error("expected an llm step");
    const steps: Record<string, { result: unknown }> = {};
    let i = 0;
    for (const s of wf.steps) {
      if (s.type === "tool") steps[s.id] = { result: trace.calls[i++]!.result };
    }
    const rendered = String(
      renderTemplate(llm.prompt, { inputs: trace.meta.inputs, steps }),
    );
    expect(rendered).toContain("Q3 budget review moved to 14:00");
    expect(llm.inputKey).toBe(answerKey(llm.example, rendered));
  });
});

describe("lostReadOnlySteps (recompile safety)", () => {
  const wf = (steps: Array<[string, boolean]>): Workflow =>
    ({
      version: 1,
      task: "t",
      compiledFrom: "x",
      server: "s",
      inputs: {},
      steps: steps.map(([tool, sideEffect], i) => ({
        id: `s${i + 1}`,
        type: "tool",
        tool,
        args: {},
        sideEffect,
        guard: {},
      })),
    }) as Workflow;

  it("is empty when nothing read-only was dropped", () => {
    const old = wf([
      ["get_a", false],
      ["get_b", false],
      ["send", true],
    ]);
    expect(
      lostReadOnlySteps(
        old,
        wf([
          ["get_b", false],
          ["get_a", false],
          ["send", true],
        ]),
      ),
    ).toEqual([]);
  });

  it("lists read-only tools the new workflow no longer calls", () => {
    const old = wf([
      ["get_a", false],
      ["get_b", false],
      ["send", true],
    ]);
    const next = wf([
      ["get_a", false],
      ["send", true],
    ]);
    expect(lostReadOnlySteps(old, next)).toEqual(["get_b"]);
  });

  it("counts repeats: 3 get_commits -> 2 loses one", () => {
    const old = wf([
      ["get_commits", false],
      ["get_commits", false],
      ["get_commits", false],
    ]);
    const next = wf([
      ["get_commits", false],
      ["get_commits", false],
    ]);
    expect(lostReadOnlySteps(old, next)).toEqual(["get_commits (1 of 3)"]);
  });

  it("ignores side-effect steps and extra steps in the new workflow", () => {
    const old = wf([
      ["get_a", false],
      ["send", true],
    ]);
    const next = wf([
      ["get_a", false],
      ["get_c", false],
    ]);
    expect(lostReadOnlySteps(old, next)).toEqual([]);
  });
});

// Small open models often "answer" instead of acting: the recording then has
// the reads but never the action. Those workflows must not be trusted silently.
describe("recordingWarnings (incomplete recordings)", () => {
  it("is empty for a recording that performed its action", async () => {
    const trace = await readTrace(fixture);
    const wf = await compileFixture();
    expect(recordingWarnings(trace, wf)).toEqual([]);
  });

  // Claude Code keeps the recorder running, so a finished task's trace has no
  // end line yet: compile it anyway, and say the agent might not be done.
  it("warns when the trace is still open", async () => {
    const trace = await readTrace(fixture);
    const wf = await compileFixture();
    const warnings = recordingWarnings({ ...trace, open: true }, wf);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/still open/);
    expect(warnings[0]).toMatch(/4 tool calls/);
  });

  it("compileTaskInMemory compiles a trace without an end line", async () => {
    const text = await readFile(fixture, "utf8");
    const withoutEnd = text
      .split("\n")
      .filter((l) => l.trim() && !l.includes('"type":"end"'))
      .join("\n");
    const dir = await mkdtemp(path.join(os.tmpdir(), "hotpath-open-"));
    const file = path.join(dir, "open.jsonl");
    await writeFile(file, withoutEnd + "\n");

    const { workflow, warnings } = await compileTaskInMemory(
      "morning-brief",
      file,
    );
    expect(workflow.steps.map((s) => s.type)).toEqual([
      "tool",
      "tool",
      "tool",
      "llm",
      "tool",
    ]);
    expect(warnings.some((w) => /still open/.test(w))).toBe(true);
  });

  it("warns when action tools were offered but never used", async () => {
    const trace = await readTrace(fixture);
    const readsOnly = {
      ...trace,
      calls: trace.calls.filter((c) => c.tool !== "send_message"),
    };
    const wf = workflowSchema.parse(compileTrace(readsOnly, "x.jsonl"));
    const warnings = recordingWarnings(readsOnly, wf);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/never called an action tool/);
    expect(warnings[0]).toContain("send_message");
    expect(warnings[0]).toMatch(/record again/i);
  });

  it("stays quiet for read-only servers (nothing to act with)", async () => {
    const trace = await readTrace(fixture);
    const readOnlyServer = {
      ...trace,
      meta: {
        ...trace.meta,
        tools: trace.meta.tools.filter((t) => t.name !== "send_message"),
      },
      calls: trace.calls.filter((c) => c.tool !== "send_message"),
    };
    const wf = workflowSchema.parse(compileTrace(readOnlyServer, "x.jsonl"));
    expect(recordingWarnings(readOnlyServer, wf)).toEqual([]);
  });
});

describe("lostActions (recompile safety)", () => {
  it("is empty when the recompile kept every action and AI step", async () => {
    const wf = await compileFixture();
    expect(lostActions(wf, wf)).toEqual([]);
  });

  it("names the dropped action and AI step", async () => {
    const old = await compileFixture();
    const trace = await readTrace(fixture);
    const readsOnly = {
      ...trace,
      calls: trace.calls.filter((c) => c.tool !== "send_message"),
    };
    const next = workflowSchema.parse(compileTrace(readsOnly, "x.jsonl"));
    expect(lostActions(old, next)).toEqual(["send_message", "AI step"]);
  });
});

// A small agent's recorded text often mentions most items of a list but not
// all, and tomorrow's list can be longer. When the text mentions a field for at
// least half the items, require that field for every item (path with `*`).
describe("collectGrounding: list fields", () => {
  const emails = {
    emails: [
      { subject: "Q3 budget review moved to 14:00", from: "ana@corp.com" },
      { subject: "Team offsite: draft agenda", from: "bo@corp.com" },
      { subject: "Metro line 4 closed this weekend", from: "news@city.fr" },
    ],
  };

  it("generalizes a field mentioned for most items to every item", () => {
    const example =
      "Q3 budget review moved to 14:00, and Team offsite: draft agenda.";
    const entries = collectGrounding(example, [{ id: "s1", result: emails }]);
    expect(entries).toEqual([
      {
        value: "Q3 budget review moved to 14:00",
        paths: ["steps.s1.result.emails.*.subject"],
      },
    ]);
  });

  it("a minority of items mentioned asks for that many items, not for those positions", () => {
    // The recording cites the 3rd email only. Tomorrow's 3rd email is another
    // one, so "the 3rd email must be cited" would reject a report that cites the
    // email that matters that day. What stays required: one item, as before.
    const example = "Heads-up: Metro line 4 closed this weekend.";
    const entries = collectGrounding(example, [{ id: "s1", result: emails }]);
    expect(entries).toEqual([
      {
        value: "Metro line 4 closed this weekend",
        paths: ["steps.s1.result.emails.*.subject"],
        positions: [2],
      },
    ]);
  });

  it("leaves non-list values as they were", () => {
    const entries = collectGrounding("Sunny, 21.5C", [
      { id: "s3", result: { summary: "Sunny", high: 21.5 } },
    ]);
    expect(entries.map((e) => e.paths)).toEqual([
      ["steps.s3.result.summary"],
      ["steps.s3.result.high"],
    ]);
  });
});

describe("collectGrounding: coincidences", () => {
  it("one matching item never generalizes a field (14:00 is a subject AND a start time)", () => {
    const result = {
      events: [
        { title: "Standup", start: "09:30" },
        { title: "Budget review", start: "14:00" },
      ],
    };
    const entries = collectGrounding("Q3 budget review moved to 14:00", [
      { id: "s2", result },
    ]);
    // the one event it mentions is not required for every event: one event,
    // by title or start time, whichever event it is
    expect(entries).toEqual([
      {
        value: "Budget review",
        paths: [
          "steps.s2.result.events.*.title",
          "steps.s2.result.events.*.start",
        ],
        positions: [1],
      },
    ]);
  });
});
