// The recorder's log line names the server command without its arguments:
// they can hold a token (docs/SECURITY-REVIEW.md, finding 3).
import { describe, expect, it } from "vitest";

import { TaskNameError } from "@hotpathrun/shared";

import { describeServer, TraceWriter } from "../src/index.js";

describe("recorder log", () => {
  it("shows the command and how many arguments, never their values", () => {
    const line = describeServer([
      "npx",
      "-y",
      "some-server",
      "--api-key",
      ["sk", "test", "0123456789abcdef"].join("-"),
    ]);
    expect(line).toBe("npx (+4 arguments)");
    expect(line).not.toContain("sk-test");
    expect(describeServer(["server"])).toBe("server");
    expect(describeServer(["node", "x.js"])).toBe("node (+1 argument)");
  });
});

describe("trace writer", () => {
  it("refuses a task name that is a path before creating anything", () => {
    expect(() => new TraceWriter("../../outside")).toThrow(TaskNameError);
    expect(() => new TraceWriter("a/b")).toThrow(TaskNameError);
  });
});
