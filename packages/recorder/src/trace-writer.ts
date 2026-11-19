import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import path from "node:path";

import {
  assertTaskName,
  projectRoot,
  traceLineSchema,
  type TraceMeta,
} from "@hotpathrun/shared";

// the project's traces/, wherever the recorder was started from (an agent
// starts it from its own folder)
const tracesDir = path.join(projectRoot(), "traces");

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export class TraceWriter {
  readonly file: string;
  private stream: WriteStream;
  private seq = 0;

  constructor(task: string) {
    const dir = path.join(tracesDir, assertTaskName(task));
    // private to this user (security finding 7): traces hold the tools' real data
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, `${timestamp()}.jsonl`);
    this.stream = createWriteStream(this.file, { flags: "a", mode: 0o600 });
  }

  write(line: unknown): void {
    this.stream.write(JSON.stringify(traceLineSchema.parse(line)) + "\n");
  }

  writeMeta(meta: Omit<TraceMeta, "type">): void {
    this.write({ type: "meta", ...meta });
  }

  nextSeq(): number {
    return ++this.seq;
  }

  /** tool calls started in this trace so far */
  calls(): number {
    return this.seq;
  }

  writeEnd(endedAt: string): Promise<void> {
    this.write({ type: "end", endedAt, toolCalls: this.seq });
    return new Promise((resolve) => this.stream.end(resolve));
  }
}
