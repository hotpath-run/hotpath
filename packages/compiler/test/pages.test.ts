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

describe("a page asked for after the last one", () => {
  // the hard bench's crm: pages 1 and 2 (no next page), 5 lookups, then page 3
  // anyway (empty), then the other lookups: the extra page split them in two
  const lookup = (d: string) => ({
    tool: "get_company",
    args: { domain: d },
    result: { name: d },
  });
  const past = {
    tool: "list_tickets",
    args: { page: 3, date: "2026-10-01" },
    result: { page: 3, tickets: [], next_page: null },
  };

  it("is dropped, so the lookups around it stay one run", () => {
    const { calls } = collapsePages(
      [call(1, 2), call(2, null), lookup("a"), lookup("b"), past, lookup("c")],
      readOnly,
    );
    expect(calls.map((c) => c.tool)).toEqual([
      "list_tickets",
      "get_company",
      "get_company",
      "get_company",
    ]);
  });

  it("is kept when it returned items (it was no page past the end)", () => {
    const full = {
      ...past,
      result: { ...past.result, tickets: [{ id: "T-9" }] },
    };
    const { calls } = collapsePages(
      [call(1, 2), call(2, null), lookup("a"), full],
      readOnly,
    );
    expect(calls).toHaveLength(3);
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

describe("cursor pages", () => {
  // first page without a cursor, then each page with the cursor the last one gave
  const page = (
    cursor: string | undefined,
    next: string | null,
    n: number,
  ) => ({
    tool: "list_invoices",
    args: cursor === undefined ? {} : { cursor },
    result: { invoices: [{ id: `INV-${n}` }], next_cursor: next },
  });

  it("turns a cursor chain into one paginated call with every invoice", () => {
    const { calls, paginate } = collapsePages(
      [
        page(undefined, "c_MTA", 1),
        page("c_MTA", "c_MjA", 2),
        page("c_MjA", null, 3),
      ],
      readOnly,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual({});
    expect(calls[0]!.result).toEqual({
      invoices: [{ id: "INV-1" }, { id: "INV-2" }, { id: "INV-3" }],
      next_cursor: null,
    });
    expect(paginate.get(calls[0]!)).toEqual({
      arg: "cursor",
      next: "next_cursor",
    });
  });

  it("leaves the calls alone when the agent stopped before the last page", () => {
    expect(
      collapsePages([page(undefined, "a", 1), page("a", "b", 2)], readOnly)
        .calls,
    ).toHaveLength(2);
  });

  it("leaves the calls alone when the cursor passed is not the one the page gave", () => {
    expect(
      collapsePages([page(undefined, "a", 1), page("zz", null, 2)], readOnly)
        .calls,
    ).toHaveLength(2);
  });
});
