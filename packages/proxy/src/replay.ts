import {
  DriftError,
  runWorkflow,
  type RunMetrics,
  type ToolBackend,
} from "@hotpathrun/runtime";
import {
  toolStepsOf,
  withLlmRoute,
  type LlmRoute,
  type Workflow,
} from "@hotpathrun/shared";

import {
  hotpathId,
  resultValue,
  type ApiFormat,
  type Conversation,
  type ToolCall,
} from "./formats.js";

/** What the replay asks of the agent next. */
export type ReplayEvent =
  | { kind: "tool"; call: ToolCall }
  | { kind: "done"; metrics: RunMetrics }
  | {
      kind: "drift";
      reason: string;
      /** model calls the replay made before it gave up (AI steps) */
      llmCalls: number;
    };

/** The agent did not answer the replay's tool call the way a tool result looks. */
export class HandoverError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "HandoverError";
  }
}

interface Pending {
  call: ToolCall;
  resolve: (result: { value: unknown; isError: boolean }) => void;
  reject: (err: Error) => void;
}

/**
 * One conversation answered from a compiled workflow. The runtime runs the
 * workflow as usual (guards, AI steps, conditions, the crash journal), but its
 * tool backend is the agent: a tool step becomes the model reply "call this
 * tool with these arguments", and the step's result is what the agent sends
 * back in its next request. So the agent keeps running its own tools, and the
 * runtime's guards check every result before the next step.
 */
export class ReplaySession {
  /** tool calls the replay asked the agent to make, in order */
  readonly issued: ToolCall[] = [];
  private pending: Pending | null = null;
  private readonly events: ReplayEvent[] = [];
  private waiter: ((event: ReplayEvent) => void) | null = null;
  private readonly actions: Set<string>;
  private finished = false;

  constructor(
    readonly workflow: Workflow,
    readonly inputs: Record<string, string>,
    readonly format: ApiFormat,
    private readonly route: LlmRoute | null,
  ) {
    this.actions = new Set(
      toolStepsOf(workflow.steps)
        .filter((s) => s.sideEffect)
        .map((s) => s.tool),
    );
  }

  /** Starts the workflow; the first event is the first tool call (or the end). */
  start(): void {
    const backend: ToolBackend = {
      call: (tool, args) =>
        new Promise((resolve, reject) => {
          const call = { id: hotpathId(this.format, "call"), name: tool, args };
          this.issued.push(call);
          this.pending = { call, resolve, reject };
          this.emit({ kind: "tool", call });
        }),
    };
    const run = () =>
      runWorkflow(this.workflow, {
        inputs: this.inputs,
        noFallback: true,
        tools: backend,
      });
    // AI steps go to the agent's own provider with its own key (see llm.ts routes)
    const running = this.route ? withLlmRoute(this.route, run) : run();
    running.then(
      (metrics) => {
        this.finished = true;
        this.emit({ kind: "done", metrics });
      },
      (err: unknown) => {
        this.finished = true;
        this.pending = null;
        this.emit({
          kind: "drift",
          reason: err instanceof Error ? err.message : String(err),
          llmCalls: err instanceof DriftError ? err.metrics.llmCalls : 0,
        });
      },
    );
  }

  /** The next thing to tell the agent. */
  next(): Promise<ReplayEvent> {
    const queued = this.events.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  private emit(event: ReplayEvent): void {
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter(event);
    } else {
      this.events.push(event);
    }
  }

  /** The id of the tool call the replay waits on, if any. */
  get waitingOn(): string | null {
    return this.pending?.call.id ?? null;
  }

  get done(): boolean {
    return this.finished;
  }

  /** Actions (tools that are not read-only) the agent ran on the replay's word. */
  actionsRun(): ToolCall[] {
    return this.issued.filter(
      (c) => this.actions.has(c.name) && c.id !== this.pending?.call.id,
    );
  }

  /**
   * The agent's next request. When its last messages are the result of the
   * call the replay asked for (and nothing else was added), the result goes to
   * the runtime and true is returned; otherwise the replay stops (false) and
   * the conversation goes to the model.
   */
  answer(conversation: Conversation): boolean {
    const pending = this.pending;
    if (!pending) return false;
    const last = conversation.messages[conversation.messages.length - 1];
    if (!last || last.role !== "tool" || last.callId !== pending.call.id) {
      this.stop(
        `the agent's request did not end with the result of ${pending.call.name} ` +
          "(it changed the conversation or added a message)",
      );
      return false;
    }
    this.pending = null;
    pending.resolve({
      value: resultValue(last.content),
      isError: last.isError,
    });
    return true;
  }

  /** Stops the workflow where it is: the model takes the conversation from here. */
  stop(reason: string): void {
    const pending = this.pending;
    this.pending = null;
    pending?.reject(new HandoverError(reason));
  }
}
