# Agents without MCP: `@hotpathrun/sdk`

Most agents built inside a company call tools that are functions in their own code
(OpenAI or Anthropic SDK tool calling, LangChain, LlamaIndex, the Vercel AI SDK, a
hand-written loop). There is no MCP server to put a recorder in front of. `@hotpathrun/sdk`
(`packages/sdk`) records and replays those agents in process.

## Use

```ts
import { recordTools, runWorkflow } from "@hotpathrun/sdk";

const tools = {
  get_orders: {
    description: "The orders placed on a date",
    parameters: { type: "object", properties: { date: { type: "string" } } },
    readOnly: true, // only reads
    execute: async ({ date }) => db.orders(date),
  },
  send_report: {
    description: "Send the daily report",
    // not readOnly: it sends. Skipped in a dry run, never run twice.
    execute: async ({ to, text }) => mailer.send(to, text),
  },
};

// 1. Record: give your agent the wrapped tools, once.
const recording = recordTools(tools, {
  task: "orders-report",
  inputs: { date: "2026-10-01" }, // what changes between runs
});
await myAgent(recording.tools);
await recording.finish(); // traces/orders-report/<time>.jsonl

// 2. Compile: `hotpath compile orders-report` (the same compiler as for MCP).

// 3. Replay: the workflow calls the same functions; a model writes only the text.
await runWorkflow("orders-report", {
  tools,
  inputs: { date: "2026-10-02" },
  // on drift, your agent does the task again and a new recording is compiled
  agent: async ({ task, inputs }) => {
    const r = recordTools(tools, { task, inputs });
    await myAgent(r.tools);
    await r.finish();
  },
});
```

- **`readOnly: true`** marks a tool that only reads, like MCP's `readOnlyHint`. A tool
  without it is treated as acting: skipped in a dry run (`dryRun: true`), and after it
  ran, drift never starts the agent (it would act twice). Forgetting the mark on a read
  costs a skipped step in dry runs; forgetting it on a send would be the dangerous
  mistake, so acting is the default.
- **A tool that throws** is recorded as an error (and the compiler leaves errored calls
  out, as for MCP). In a replay it is drift at that step.
- **Results are recorded as JSON makes them** (a `Date` becomes a string), which is also
  what the replay's guards and the AI step see.
- **Without `agent`**, drift throws a `DriftError` instead of falling back.
- Guards, grounding, the stale-fact check, `--require`, answer reuse, loops and
  conditions are the runtime's own: they behave as they do over MCP.
- `hotpath show`, `hotpath view`, `hotpath forget` and `hotpath report` work on such a
  task. `hotpath run` and the scheduler cannot run it (the functions live in your
  process) and say so; schedule your own script that calls `runWorkflow`.

The example in `examples/sdk-agent` is an agent with three function tools:

```bash
pnpm --filter sdk-agent start -- record --date 2026-10-01
pnpm --filter sdk-agent start -- run --date 2026-10-02 --dry-run
```

## How the integration could have been done, and why a wrapper

| Way in                                                                             | Sees                                                                                            | Cost to adopt                              | Loses                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Wrap the tool functions** (this package)                                         | The real arguments and the real return values, in the agent's process                           | One call around the tools object           | Nothing the compiler needs. Tools must be reachable as functions.                                                                                                                                                                                                    |
| A framework callback or middleware (LangChain callbacks, Vercel AI SDK middleware) | The same, through the framework's events                                                        | One adapter per framework, kept up to date | Nothing, but each framework needs its own adapter, and replay still has to call the functions.                                                                                                                                                                       |
| An OpenAI-compatible HTTP proxy between the agent and the model                    | Tool calls the model asks for, and the tool results as the agent reports them back to the model | Change one base URL; any language          | The **real** function results (only the text the agent chose to send the model, often cut or reformatted), which tools only read, and any way to **run** a tool on replay: the proxy cannot call a function inside someone else's process. It can cache, not replay. |

A wrapper is the only one of the three that can replay, because replay means calling the
tool. The adapters are thin layers over it and can be added per framework when a customer
asks: each turns the framework's tool list into the `Tools` object above. A Python
package with the same two functions is the natural next step; it is a new language in
this repository and waits for a decision.
