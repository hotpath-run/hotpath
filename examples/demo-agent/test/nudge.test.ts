import { describe, expect, it } from "vitest";

import { actionNudge, actionToolNames, deferActions } from "../src/nudge.js";

const tools = [
  { name: "get_emails", annotations: { readOnlyHint: true } },
  { name: "send_message", annotations: { readOnlyHint: false } },
  { name: "archive", annotations: undefined },
];

describe("actionToolNames", () => {
  it("is every tool not marked read-only", () => {
    expect(actionToolNames(tools)).toEqual(["send_message", "archive"]);
  });
});

describe("actionNudge", () => {
  const actions = ["send_message"];

  it("asks the model to act when it answered in text before any action", () => {
    const nudge = actionNudge(actions, ["get_emails"], 0);
    expect(nudge).toMatch(/not done/i);
    expect(nudge).toContain("send_message");
  });

  it("is null once an action tool was called (the model may be finished)", () => {
    expect(actionNudge(actions, ["get_emails", "send_message"], 0)).toBeNull();
  });

  it("gives up after the nudge budget, so a confused model cannot loop forever", () => {
    expect(actionNudge(actions, [], 2)).toBeNull();
  });

  it("is null for servers with no action tools", () => {
    expect(actionNudge([], ["get_emails"], 0)).toBeNull();
  });
});

// A model that plans every call at once writes the action (send_message) with
// placeholder text before it has seen any data. Run the reads, hold the action.
describe("deferActions", () => {
  const actions = ["send_message"];
  const call = (name: string) => ({ id: name, name, arguments: {} });

  it("holds back actions planned in the same turn as reads", () => {
    const { run, deferred } = deferActions(
      [call("get_emails"), call("get_weather"), call("send_message")],
      actions,
    );
    expect(run.map((c) => c.name)).toEqual(["get_emails", "get_weather"]);
    expect(deferred.map((c) => c.name)).toEqual(["send_message"]);
  });

  it("runs a turn of only actions (e.g. two messages after reading)", () => {
    const calls = [call("send_message"), call("send_message")];
    expect(deferActions(calls, actions)).toEqual({ run: calls, deferred: [] });
  });

  it("runs a turn of only reads", () => {
    const calls = [call("get_emails")];
    expect(deferActions(calls, actions)).toEqual({ run: calls, deferred: [] });
  });
});
