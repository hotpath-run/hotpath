// A.5: the summary after per-item decisions is written from those decisions. On the
// hard bench's crm, a free model's tiers disagreed between its two passes on every
// day (so every replay went to the agent), and the counts per tier were left to it.
// Now code decides the tiers from the recorded bands and counts them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@hotpathrun/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hotpathrun/shared")>();
  return { ...actual, chat: vi.fn() };
});

import { compileRecording } from "@hotpathrun/compiler";
import { chat, type TraceFile, type Workflow } from "@hotpathrun/shared";
import { DriftError, runWorkflow, type ToolBackend } from "../src/index.js";

const chatMock = vi.mocked(chat);
const tierOf = (e: number) =>
  e >= 1000 ? "enterprise" : e >= 100 ? "mid" : "smb";

type Lead = { id: string; company_domain: string };
const day = (employees: number[]) => {
  const leads: Lead[] = employees.map((_, i) => ({
    id: `L${100 + i}`,
    company_domain: `c${i}.com`,
  }));
  const companies = Object.fromEntries(
    leads.map((l, i) => [
      l.company_domain,
      { name: `C${i} Inc`, employees: employees[i]!, country: "FR" },
    ]),
  );
  return { leads, companies };
};
const summary = (date: string, employees: number[]) => {
  const n = (t: string) => employees.filter((e) => tierOf(e) === t).length;
  return (
    `Lead tiering done (${date}). ${employees.length} leads were processed. ` +
    `Tier summary: enterprise = ${n("enterprise")}, mid = ${n("mid")}, smb = ${n("smb")}. ` +
    "Tiers were assigned by employee count: enterprise ≥1000, mid 100–999, smb <100."
  );
};

const RECORDED = [12, 5000, 100, 999, 40, 1200, 350, 8];
const TODAY = [3, 150, 2500, 99, 1000, 640, 17, 7];

function recording(): TraceFile {
  const at = "2026-11-01T10:00:00.000Z";
  const { leads, companies } = day(RECORDED);
  let seq = 0;
  const call = (
    tool: string,
    args: Record<string, unknown>,
    result: unknown,
  ) => ({
    type: "tool_call" as const,
    seq: ++seq,
    tool,
    args,
    result,
    isError: false,
    startedAt: at,
    durationMs: 1,
  });
  return {
    meta: {
      type: "meta",
      version: 1,
      task: "crm-summary",
      startedAt: at,
      server: "in-process",
      inputs: { date: "2026-11-01" },
      tools: [
        {
          name: "list_leads",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
        {
          name: "get_company",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
        { name: "update_lead", inputSchema: { type: "object" } },
        { name: "send_message", inputSchema: { type: "object" } },
      ],
    },
    calls: [
      call("list_leads", { page: 1 }, { leads, next_page: null }),
      ...leads.map((l) =>
        call(
          "get_company",
          { domain: l.company_domain },
          companies[l.company_domain],
        ),
      ),
      ...leads.map((l) =>
        call(
          "update_lead",
          { id: l.id, tier: tierOf(companies[l.company_domain]!.employees) },
          { ok: true },
        ),
      ),
      call(
        "send_message",
        { to: "sales", text: summary("2026-11-01", RECORDED) },
        { ok: true },
      ),
    ],
    end: { type: "end", endedAt: at, toolCalls: seq },
  };
}

let workflow: Workflow;
let updates: Array<Record<string, unknown>>;
function tools(employees: number[]): ToolBackend {
  const { leads, companies } = day(employees);
  return {
    async call(tool, args) {
      const a = args as Record<string, unknown>;
      if (tool === "list_leads")
        return { value: { leads, next_page: null }, isError: false };
      if (tool === "get_company")
        return { value: companies[String(a.domain)], isError: false };
      if (tool === "update_lead") updates.push(a);
      return { value: { ok: true }, isError: false };
    },
  };
}

beforeEach(() => {
  process.env.HOTPATH_REUSE = "0";
  workflow = compileRecording(recording(), "test").workflow;
  updates = [];
  chatMock.mockReset();
  chatMock.mockResolvedValue({
    text: summary("2026-11-04", TODAY),
    toolCalls: [],
    promptTokens: 1,
    completionTokens: 1,
    llmCalls: 1,
    rateLimitWaitMs: 0,
  } as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.HOTPATH_REUSE;
  vi.restoreAllMocks();
});

describe("a summary after per-item decisions", () => {
  it("decides every tier by the recorded bands and hands the summary code's counts", async () => {
    await runWorkflow(workflow, {
      inputs: { date: "2026-11-04" },
      tools: tools(TODAY),
    });
    expect(updates).toEqual(
      TODAY.map((e, i) => ({ id: `L${100 + i}`, tier: tierOf(e) })),
    );
    // one model call: the summary; no question about the tiers
    expect(chatMock).toHaveBeenCalledTimes(1);
    const prompt = String(chatMock.mock.calls[0]![0].messages.at(-1)!.content);
    expect(prompt).toContain("enterprise: 2");
    expect(prompt).toContain("mid: 2");
    expect(prompt).toContain("smb: 4");
  });

  it("goes to the agent, before any update, when a lead falls between bands the recording never closed", async () => {
    // a recording with no company between 999 and 1500 employees and no
    // threshold written: on the hard bench the model put 1000 in "mid" twice
    const open = structuredClone(workflow);
    const loop = open.steps.find((s) => s.type === "foreach" && s.decide);
    if (loop?.type !== "foreach" || !loop.decide?.bands)
      throw new Error("no bands");
    loop.decide.bands.bands = [
      { value: "smb", lt: 100 },
      { value: "mid", gte: 100, lte: 999 },
      { value: "enterprise", gte: 1500 },
    ];
    const err = await runWorkflow(open, {
      inputs: { date: "2026-11-04" },
      tools: tools(TODAY),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriftError);
    expect((err as DriftError).reason).toMatch(
      /1 lead \(L104: employees 1000\) fall between bands the recording never closed/,
    );
    expect((err as DriftError).sideEffectRan).toBe(false);
    expect(updates).toEqual([]);
    expect(chatMock).not.toHaveBeenCalled();
  });
});
