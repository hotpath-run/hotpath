// Crash safety for side effects. A run that dies between two actions (the
// process is killed, the machine sleeps, a tool hangs) must not repeat the
// first action when it is run again. The journal keeps, per task and inputs,
// the run in progress: which action steps were started and which finished.
//
// Rerun with the same inputs after an unfinished run:
//  - an action that finished is not repeated: its recorded result is reused;
//  - an action that started and never confirmed may or may not have happened:
//    the run stops and says so (a person checks), unless the step is marked
//    `repeatable` in the workflow.
// A run that finished clears its entry, so the next run is a new one.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface JournalEntry {
  task: string;
  inputsKey: string;
  startedAt: string;
  /** action step id → its state in the unfinished run */
  actions: Record<
    string,
    { state: "started" | "done"; at: string; result?: unknown }
  >;
}

/** One key per task and inputs: the same scheduled day, the same customer… */
export function inputsKey(
  task: string,
  inputs: Record<string, string>,
): string {
  const sorted = Object.fromEntries(
    Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b)),
  );
  return createHash("sha256")
    .update(JSON.stringify([task, sorted]))
    .digest("hex")
    .slice(0, 32);
}

/** A value tools that dedupe can use: the same for every retry of this action. */
export function idempotencyKey(inputs: string, stepId: string): string {
  return `hp-${createHash("sha256").update(`${inputs}:${stepId}`).digest("hex").slice(0, 32)}`;
}

export class Journal {
  private constructor(
    private readonly file: string,
    readonly previous: JournalEntry | null,
    private entry: JournalEntry,
  ) {}

  static async open(
    dir: string,
    task: string,
    inputs: Record<string, string>,
  ): Promise<Journal> {
    const key = inputsKey(task, inputs);
    const file = path.join(dir, `${key}.json`);
    let previous: JournalEntry | null = null;
    try {
      previous = JSON.parse(await readFile(file, "utf8")) as JournalEntry;
    } catch {
      previous = null; // none: the last run with these inputs finished, or none ran
    }
    // an unfinished run's finished actions carry over into this one
    const entry: JournalEntry = {
      task,
      inputsKey: key,
      startedAt: new Date().toISOString(),
      actions: Object.fromEntries(
        Object.entries(previous?.actions ?? {}).filter(
          ([, a]) => a.state === "done",
        ),
      ),
    };
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return new Journal(file, previous, entry);
  }

  get key(): string {
    return this.entry.inputsKey;
  }

  /** The earlier, unfinished run already did this action: its result. */
  done(stepId: string): { result: unknown } | null {
    const a = this.previous?.actions[stepId];
    return a?.state === "done" ? { result: a.result } : null;
  }

  /** The earlier run started this action and never confirmed it. */
  unconfirmed(stepId: string): boolean {
    return this.previous?.actions[stepId]?.state === "started";
  }

  async started(stepId: string): Promise<void> {
    this.entry.actions[stepId] = {
      state: "started",
      at: new Date().toISOString(),
    };
    await this.save();
  }

  async finished(stepId: string, result: unknown): Promise<void> {
    this.entry.actions[stepId] = {
      state: "done",
      at: new Date().toISOString(),
      result,
    };
    await this.save();
  }

  /** The run reached its end (or stopped before any action): nothing to resume. */
  async close(): Promise<void> {
    await rm(this.file, { force: true });
  }

  // write-then-rename: a crash mid-write never leaves a half journal
  private async save(): Promise<void> {
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.entry, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }
}
