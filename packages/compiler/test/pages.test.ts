// A read recorded page by page ("until there is no next page") compiles to one
// paginated step; anything less certain stays the fixed calls the agent made.
import { describe, expect, it } from "vitest";

import { collapsePages } from "../src/pages.js";

const call = (page: number, next: number | null, extra = {}) => ({
  tool: "list_tickets",
  args: { page, date: "2026-10-01", ...extra },
  result: { page, tickets: [{ id: `T-${page}` }], next_page: next },
});
const readOnly = () => true;

describe("collapsePages", () => {
  it("turns pages 1..3 into one call with every ticket and no next page", () => {
    const { calls, paginate } = collapsePages(
      [call(1, 2), call(2, 3), call(3, null)],
      readOnly,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.result).toEqual({
      page: 1,
      tickets: [{ id: "T-1" }, { id: "T-2" }, { id: "T-3" }],
      next_page: null,
    });
    expect(paginate.get(calls[0]!)).toEqual({ arg: "page", next: "next_page" });
  });

  it("two pages are enough, and other calls around them are kept", () => {
    const other = { tool: "get_x", args: {}, result: { x: 1 } };
    const { calls } = collapsePages(
      [other, call(1, 2), call(2, null), other],
      readOnly,
    );
    expect(calls.map((c) => c.tool)).toEqual([
      "get_x",
      "list_tickets",
      "get_x",
    ]);
  });

  it("leaves a run alone when the agent stopped before the last page", () => {
    const { calls, paginate } = collapsePages(
      [call(1, 2), call(2, 3)],
      readOnly,
    );
    expect(calls).toHaveLength(2);
    expect(paginate.size).toBe(0);
  });

  it("leaves a run alone when a page is skipped or another argument changes", () => {
    expect(
      collapsePages([call(1, 2), call(3, null)], readOnly).calls,
    ).toHaveLength(2);
    expect(
      collapsePages(
        [call(1, 2), call(2, null, { date: "2026-10-02" })],
        readOnly,
      ).calls,
    ).toHaveLength(2);
  });

  it("never touches a tool that is not read-only", () => {
    const { calls } = collapsePages([call(1, 2), call(2, null)], () => false);
    expect(calls).toHaveLength(2);
  });

  it("a single page is not a pattern", () => {
    expect(collapsePages([call(1, null)], readOnly).calls).toHaveLength(1);
  });
});

describe("collapsePages with other reads between the pages", () => {
  const ledger = { tool: "list_ledger", args: {}, result: [] };
  it("takes page 2 and 3 even when the agent read something else in between", () => {
    const { calls, paginate } = collapsePages(
      [call(1, 2), ledger, call(2, 3), call(3, null)],
      readOnly,
    );
    expect(calls.map((c) => c.tool)).toEqual(["list_tickets", "list_ledger"]);
    expect((calls[0]!.result as { tickets: unknown[] }).tickets).toHaveLength(
      3,
    );
    expect(paginate.size).toBe(1);
  });

  it("a side effect between two pages ends the chain", () => {
    const send = { tool: "send", args: {}, result: {} };
    const ro = (t: string) => t !== "send";
    const { calls } = collapsePages([call(1, 2), send, call(2, null)], ro);
    expect(calls).toHaveLength(3);
  });
});
