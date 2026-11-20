// A guard learned from recordings where every order was delivered said
// `delivered_on` must be a string; an order still in transit has null there,
// and every replay drifted for a field nothing used. Nulls are now let through
// on fields nothing reads, and only there.
import { describe, expect, it, vi } from "vitest";

vi.mock("@hotpathrun/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hotpathrun/shared")>();
  return { ...actual, chat: vi.fn() };
});

import { chat, type Workflow } from "@hotpathrun/shared";
import {
  DriftError,
  relaxedGuards,
  runWorkflow,
  type ToolBackend,
} from "../src/index.js";

process.env.HOTPATH_JOURNAL = "0";

const order = {
  type: "object",
  properties: {
    id: { type: "string" },
    delivered_on: { type: "string" },
    tracking_number: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, note: { type: "string" } },
        required: ["name", "note"],
      },
    },
  },
  required: ["id", "delivered_on", "tracking_number", "items"],
};

function workflow(rest: unknown[]): Workflow {
  return {
    version: 1,
    task: "guard-relax",
    compiledFrom: "test",
    server: "in-process",
    inputs: { id: { type: "string", example: "A1" } },
    steps: [
      {
        id: "s1",
        type: "tool",
        tool: "find_order",
        args: { id: "{{inputs.id}}" },
        sideEffect: false,
        guard: { schema: order },
      },
      ...rest,
    ],
  } as Workflow;
}

const track = {
  id: "s2",
  type: "tool",
  tool: "track",
  args: { number: "{{steps.s1.result.tracking_number}}" },
  sideEffect: false,
  guard: {},
};

function backend(result: unknown) {
  const calls: string[] = [];
  const tools: ToolBackend = {
    async call(tool) {
      calls.push(tool);
      return {
        value: tool === "find_order" ? result : { ok: true },
        isError: false,
      };
    },
  };
  return { tools, calls };
}

const run = (w: Workflow, result: unknown) =>
  runWorkflow(w, {
    inputs: { id: "A1" },
    noFallback: true,
    tools: backend(result).tools,
  });

const fine = {
  id: "A1",
  delivered_on: "2026-10-01",
  tracking_number: "T1",
  items: [{ name: "mug", note: "x" }],
};

describe("guard on fields nothing reads", () => {
  it("lets a null through where the recordings had a value", async () => {
    await run(workflow([track]), { ...fine, delivered_on: null });
  });

  it("lets a null through inside list items", async () => {
    await run(workflow([track]), {
      ...fine,
      items: [{ name: "mug", note: null }],
    });
  });

  it("lets a null through when only a whole-result prompt shows it", async () => {
    const llm = {
      id: "s3",
      type: "llm",
      model: "m",
      prompt: "order:\n{{steps.s1.result}}\nwrite the reply",
      example: "ok",
      guard: {},
    };
    const relaxed = relaxedGuards(workflow([track, llm]));
    const props = (relaxed.get("s1")!.schema as typeof order).properties;
    expect(props.delivered_on.type).toEqual(["string", "null"]);
  });

  it("still stops on a missing field", async () => {
    const without: Record<string, unknown> = { ...fine };
    delete without.delivered_on;
    await expect(run(workflow([track]), without)).rejects.toBeInstanceOf(
      DriftError,
    );
  });

  it("still stops on another type", async () => {
    await expect(
      run(workflow([track]), { ...fine, delivered_on: 20261001 }),
    ).rejects.toBeInstanceOf(DriftError);
  });

  it("does not make the result itself or a list nullable", async () => {
    await expect(run(workflow([track]), null)).rejects.toBeInstanceOf(
      DriftError,
    );
  });
});

describe("guard on fields a later step reads", () => {
  it("stops on a null the next call is built from", async () => {
    await expect(
      run(workflow([track]), { ...fine, tracking_number: null }),
    ).rejects.toBeInstanceOf(DriftError);
  });

  it("stops on a null read by a condition", async () => {
    const step = {
      ...track,
      when: { kind: "nonEmpty", ref: "steps.s1.result.delivered_on" },
    };
    await expect(
      run(workflow([step]), { ...fine, delivered_on: null }),
    ).rejects.toBeInstanceOf(DriftError);
  });

  it("stops on a null in a grounding path", async () => {
    const llm = {
      id: "s3",
      type: "llm",
      model: "m",
      prompt: "{{steps.s1.result}}",
      example: "A1 delivered",
      guard: {
        grounding: [
          { value: "2026-10-01", paths: ["steps.s1.result.delivered_on"] },
        ],
      },
    };
    await expect(
      run(workflow([llm]), { ...fine, delivered_on: null }),
    ).rejects.toBeInstanceOf(DriftError);
  });

  it("stops on a null in a field a loop body reads, not in one it does not", async () => {
    const loop = {
      id: "s2",
      type: "foreach",
      over: "{{steps.s1.result.items}}",
      as: "it",
      maxItems: 10,
      body: [
        {
          id: "s2.1",
          type: "tool",
          tool: "note",
          args: { text: "{{it.name}}" },
          sideEffect: false,
          guard: {},
        },
      ],
    };
    await run(workflow([loop]), {
      ...fine,
      items: [{ name: "mug", note: null }],
    });
    await expect(
      run(workflow([loop]), { ...fine, items: [{ name: null, note: "x" }] }),
    ).rejects.toBeInstanceOf(DriftError);
  });

  it("keeps the whole result strict when a tool is called with all of it", async () => {
    const step = { ...track, args: { order: "{{steps.s1.result}}" } };
    await expect(
      run(workflow([step]), { ...fine, delivered_on: null }),
    ).rejects.toBeInstanceOf(DriftError);
  });

  it("keeps an item strict when a loop passes the whole item on", async () => {
    const loop = {
      id: "s2",
      type: "foreach",
      over: "{{steps.s1.result.items}}",
      as: "it",
      maxItems: 10,
      body: [
        {
          id: "s2.1",
          type: "tool",
          tool: "note",
          args: { item: "{{it}}" },
          sideEffect: false,
          guard: {},
        },
      ],
    };
    await expect(
      run(workflow([loop]), { ...fine, items: [{ name: "mug", note: null }] }),
    ).rejects.toBeInstanceOf(DriftError);
  });
});

describe("guard and conditions", () => {
  it("lets a null item field through when only the emptiness of the list is read", async () => {
    const step = {
      ...track,
      when: { kind: "nonEmpty", ref: "steps.s1.result.items" },
    };
    await run(workflow([step]), {
      ...fine,
      items: [{ name: "mug", note: null }],
    });
    await expect(
      run(workflow([step]), { ...fine, items: null }),
    ).rejects.toBeInstanceOf(DriftError);
  });

  it("keeps a compared value strict", async () => {
    const step = {
      ...track,
      when: { kind: "equals", ref: "steps.s1.result.delivered_on", value: "x" },
    };
    await expect(
      run(workflow([step]), { ...fine, delivered_on: null }),
    ).rejects.toBeInstanceOf(DriftError);
  });
});

describe("fields recorded as null", () => {
  const schemaOf = (props: Record<string, unknown>) =>
    ({
      type: "object",
      properties: props,
      required: Object.keys(props),
    }) as Record<string, unknown>;
  const withSchema = (schema: Record<string, unknown>) => {
    const w = workflow([]);
    (w.steps[0] as { guard: { schema: unknown } }).guard.schema = schema;
    return w;
  };

  it("never builds a schema with a duplicate type", async () => {
    const w = withSchema(
      schemaOf({
        eta: { type: "null" },
        tag: { type: ["string", "null"] },
        list: {
          type: "array",
          items: schemaOf({ n: { type: "null" }, m: { type: "string" } }),
        },
      }),
    );
    const relaxed = relaxedGuards(w).get("s1")!.schema as {
      properties: Record<string, { type: unknown; items?: unknown }>;
    };
    // recorded only as null and unread: no type constraint any more
    expect(relaxed.properties.eta!.type).toBeUndefined();
    expect(relaxed.properties.tag!.type).toEqual(["string", "null"]);
    await runWorkflow(w, {
      inputs: { id: "A1" },
      noFallback: true,
      tools: backend({
        eta: null,
        tag: null,
        list: [{ n: null, m: null }],
      }).tools,
    });
  });

  it("accepts any type on an unread field recorded only as null, still requires it", async () => {
    const w = withSchema(schemaOf({ eta: { type: "null" } }));
    const run = (value: unknown) =>
      runWorkflow(w, {
        inputs: { id: "A1" },
        noFallback: true,
        tools: backend(value).tools,
      });
    await run({ eta: "2026-11-22" });
    await run({ eta: 5 });
    await run({ eta: null });
    await expect(run({})).rejects.toBeInstanceOf(DriftError);
  });

  it("keeps a read field recorded as null strict", async () => {
    const w = withSchema(schemaOf({ eta: { type: "null" } }));
    w.steps.push({
      id: "s2",
      type: "tool",
      tool: "track",
      args: { eta: "{{steps.s1.result.eta}}" },
      sideEffect: false,
      guard: {},
    } as never);
    await expect(
      runWorkflow(w, {
        inputs: { id: "A1" },
        noFallback: true,
        tools: backend({ eta: "x" }).tools,
      }),
    ).rejects.toBeInstanceOf(DriftError);
  });

  it("falls back to the recorded guard when a schema cannot be relaxed validly", () => {
    const w = withSchema(schemaOf({ a: { type: "string", pattern: "(" } }));
    expect(relaxedGuards(w).get("s1")!.schema).toEqual(
      (w.steps[0] as { guard: { schema: unknown } }).guard.schema,
    );
  });
});

describe("a loop whose results are read by path", () => {
  const loop = {
    id: "s2",
    type: "foreach",
    over: "{{steps.s1.result.items}}",
    as: "it",
    maxItems: 10,
    body: [
      {
        id: "s2.1",
        type: "tool",
        tool: "get_note",
        args: { id: "{{it.name}}" },
        sideEffect: false,
        guard: {
          schema: schemaOfNote(),
        },
      },
    ],
  };
  function schemaOfNote() {
    return {
      type: "object",
      properties: { body: { type: "string" }, eta: { type: "string" } },
      required: ["body", "eta"],
    };
  }
  const llm = {
    id: "s3",
    type: "llm",
    model: "m",
    prompt: "{{steps.s2.results}}",
    example: "ok",
    guard: {
      grounding: [{ value: "hello world", paths: ["steps.s2.results.*.body"] }],
    },
  };
  const items = { ...fine, items: [{ name: "a", note: "x" }] };
  const runWith = (note: unknown) =>
    runWorkflow(workflow([loop, llm]), {
      inputs: { id: "A1" },
      noFallback: true,
      tools: {
        async call(tool: string) {
          return {
            value: tool === "find_order" ? items : note,
            isError: false,
          };
        },
      },
    });

  it("lets an unread field of the items be null, not the read one", async () => {
    const unreadNull = relaxedGuards(workflow([loop, llm])).get("s2.1")!
      .schema as { properties: Record<string, { type: unknown }> };
    expect(unreadNull.properties.eta!.type).toEqual(["string", "null"]);
    expect(unreadNull.properties.body!.type).toBe("string");
  });

  it("still stops when the read field is null", async () => {
    await expect(runWith({ body: null, eta: "x" })).rejects.toBeInstanceOf(
      DriftError,
    );
  });
});

// An order still processing has tracking_number null. Only a conditional
// step (track the parcel, if the model says so) reads it, so the order read
// must not stop for it; if the step does run, its own argument check stops it.
describe("a field only a conditional step reads", () => {
  const ask = {
    kind: "ask" as const,
    question: "track_parcel",
    prompt: "{{steps.s1.result}}",
    yes: "a",
    no: "b",
  };
  const conditionalTrack = { ...track, when: ask };
  const processing = { ...fine, tracking_number: null };

  it("lets a null through at the source", () => {
    const props = (
      relaxedGuards(workflow([conditionalTrack])).get("s1")!
        .schema as typeof order
    ).properties;
    expect(props.tracking_number.type).toEqual(["string", "null"]);
  });

  it("stays strict when an unconditional step reads it too", () => {
    const props = (
      relaxedGuards(workflow([conditionalTrack, track])).get("s1")!
        .schema as typeof order
    ).properties;
    expect(props.tracking_number.type).toBe("string");
  });

  it("relaxes a field only a branch case reads (case steps run conditionally)", () => {
    const branch = {
      id: "b1",
      type: "branch",
      cases: [{ when: { kind: "nonEmpty", ref: "inputs.id" }, steps: [track] }],
    };
    const props = (
      relaxedGuards(workflow([branch])).get("s1")!.schema as typeof order
    ).properties;
    expect(props.tracking_number.type).toEqual(["string", "null"]);
  });

  it("the conditional step, if it runs, stops on the null (drift, no call)", async () => {
    vi.mocked(chat).mockResolvedValue({
      text: "yes",
      toolCalls: [],
      promptTokens: 1,
      completionTokens: 1,
      llmCalls: 1,
    });
    const b = backend(processing);
    await expect(
      runWorkflow(workflow([conditionalTrack]), {
        inputs: { id: "A1" },
        noFallback: true,
        tools: b.tools,
      }),
    ).rejects.toMatchObject({ stepId: "s2" });
    expect(b.calls).toEqual(["find_order"]);
  });

  it("the run completes when the model says no", async () => {
    vi.mocked(chat).mockResolvedValue({
      text: "no",
      toolCalls: [],
      promptTokens: 1,
      completionTokens: 1,
      llmCalls: 1,
    });
    const b = backend(processing);
    await runWorkflow(workflow([conditionalTrack]), {
      inputs: { id: "A1" },
      noFallback: true,
      tools: b.tools,
    });
    expect(b.calls).toEqual(["find_order"]);
  });
});
