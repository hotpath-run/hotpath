// Report figures over a loop's results, filtered, counted by a word, and the top
// item: the sales and logs reports of the hard bench, where a free model got every
// regional total wrong because it added 20-60 amounts in its head.
import { describe, expect, it } from "vitest";

import { computeFigures, type TemplateContext } from "@hotpathrun/shared";

import { learnCalculations } from "../src/calculations.js";

type Order = { id: string; customer: string; amount: number; status: string };
const order = (
  id: string,
  customer: string,
  amount: number,
  status = "paid",
): Order => ({ id, customer, amount, status });

function salesDay(byRegion: Record<string, Order[]>): TemplateContext {
  const regions = Object.keys(byRegion);
  return {
    inputs: { date: "2026-11-01" },
    steps: {
      s1: { result: { regions } },
      s2: {
        results: regions.map((region) => ({
          region,
          orders: byRegion[region],
        })),
      },
    },
  };
}

const RECORDED = salesDay({
  NORDICS: [
    order("N-1", "Soylent", 4100),
    order("N-2", "Hooli", 2300),
    order("N-3", "Soylent", 900, "refunded"),
    order("N-4", "Hooli", 1250),
  ],
  DACH: [
    order("D-1", "Hooli", 3200),
    order("D-2", "Wonka", 1800),
    order("D-3", "Wonka", 2600),
    order("D-4", "Hooli", 700, "refunded"),
  ],
  NA: [
    order("A-1", "Stark", 5100),
    order("A-2", "Wayne", 450, "refunded"),
    order("A-3", "Wayne", 2950),
  ],
});
// paid only: NORDICS 7650 (top Soylent 4100), DACH 7600 (top Wonka 4400),
// NA 8050 (top Stark 5100); total 23300
const SALES =
  "Regional sales report (paid orders only)\n\n" +
  "- NORDICS: 7,650 — top customer Soylent (4,100)\n" +
  "- DACH: 7,600 — top customer Wonka (4,400)\n" +
  "- NA: 8,050 — top customer Stark (5,100)\n\n" +
  "Total revenue across all regions: 23,300\nBest region: NA";

describe("figures per group of a loop", () => {
  const calcs = learnCalculations(SALES, RECORDED);

  it("learns the paid revenue of each region: a sum over that region's orders, refunded left out", () => {
    const perRegion = calcs.find((c) => c.group && c.op === "sum");
    expect(perRegion).toMatchObject({
      op: "sum",
      field: "amount",
      list: "steps.s2.results",
      group: { name: "region", path: "orders" },
      where: { field: "status", equals: "paid" },
    });
  });

  it("learns the top customer of each region by paid revenue", () => {
    expect(calcs.find((c) => c.group && c.op === "top")).toMatchObject({
      op: "top",
      by: "customer",
      field: "amount",
      group: { name: "region", path: "orders" },
    });
  });

  it("learns the total across every region's orders", () => {
    expect(calcs.find((c) => c.recorded === 23300)).toMatchObject({
      op: "sum",
      list: "steps.s2.results.*.orders",
      where: { field: "status", equals: "paid" },
    });
  });

  it("computes them on a new day with other regions, one line per region today", () => {
    const today = salesDay({
      APAC: [order("P-1", "Initech", 1000), order("P-2", "Globex", 3000)],
      LATAM: [
        order("L-1", "Wonka", 500),
        order("L-2", "Wonka", 700),
        order("L-3", "Hooli", 9000, "refunded"),
      ],
    });
    const lines = calcs.flatMap((c) =>
      (computeFigures(c, today) ?? []).map((f) => f.text),
    );
    expect(lines).toContain("APAC: 4000");
    expect(lines).toContain("LATAM: 1200");
    expect(lines).toContain("APAC top customer: Globex (3000)");
    expect(lines).toContain("LATAM top customer: Wonka (1200)");
    expect(lines).toContain("Total revenue across all regions: 5200");
    expect(lines.join("\n")).not.toMatch(/NORDICS|DACH/);
  });

  it("learns the top customer when it is its own clause after a semicolon", () => {
    // a free model's recording on the hard bench
    const semi =
      "Regional sales report (2026-11-01; paid orders only):\n" +
      "- NORDICS: revenue 7,650; top customer by revenue Soylent (4,100)\n" +
      "- DACH: revenue 7,600; top customer by revenue Wonka (4,400)\n" +
      "- NA: revenue 8,050; top customer by revenue Stark (5,100)\n" +
      "Total revenue: 23,300.";
    expect(
      learnCalculations(semi, RECORDED).find((c) => c.group && c.op === "top"),
    ).toMatchObject({ op: "top", by: "customer", field: "amount" });
  });

  it("keeps no per-group formula that explains only one region by chance", () => {
    const one =
      "- NORDICS: 7,650\n- DACH: 1,234\n- NA: 99\nTotal revenue across all regions: 23,300";
    expect(
      learnCalculations(one, RECORDED).find((c) => c.group),
    ).toBeUndefined();
  });
});

describe("figures per vendor of one list, overdue only", () => {
  const inv = (id: string, vendor: string, amount: number, due: string) => ({
    id,
    vendor,
    amount,
    currency: "EUR",
    due_date: due,
  });
  const day = (date: string, invoices: unknown[]): TemplateContext => ({
    inputs: { date },
    steps: { s1: { result: { invoices, next_cursor: null } } },
  });
  const recorded = day("2026-11-01", [
    inv("I-1", "Acme Cloud", 1200.5, "2026-10-02"),
    inv("I-2", "Bolt Freight", 900.25, "2026-10-20"),
    inv("I-3", "Acme Cloud", 3000.1, "2026-10-28"),
    inv("I-4", "Cedar Office", 5000, "2026-11-20"), // not due: no row
    inv("I-5", "Bolt Freight", 410, "2026-09-30"),
    inv("I-6", "Acme Cloud", 800, "2026-11-15"), // not due
  ]);
  // overdue: Acme 2 / 4200.60, Bolt 2 / 1310.25; total 5510.85 (4 invoices)
  const text =
    "Overdue invoices (due before 2026-11-01), EUR:\n" +
    "- Acme Cloud: 2 overdue invoices, total 4,200.60 EUR\n" +
    "- Bolt Freight: 2 overdue invoices, total 1,310.25 EUR\n\n" +
    "Grand total overdue: 5,510.85 EUR";

  it("learns the total per vendor and the grand total, over invoices due before the run's date", () => {
    const calcs = learnCalculations(text, recorded);
    expect(calcs.find((c) => c.per && c.op === "sum")).toMatchObject({
      op: "sum",
      field: "amount",
      per: "vendor",
      list: "steps.s1.result.invoices",
      where: { field: "due_date", before: "inputs.date" },
    });
    expect(calcs.find((c) => c.recorded === 5510.85)).toMatchObject({
      op: "sum",
      where: { field: "due_date", before: "inputs.date" },
    });
    const today = day("2026-12-01", [
      inv("I-9", "Cedar Office", 100, "2026-11-30"),
      inv("I-8", "Delta Legal", 250.5, "2026-11-01"),
      inv("I-7", "Cedar Office", 50, "2026-11-02"),
      inv("I-6", "Acme Cloud", 999, "2026-12-15"),
    ]);
    const lines = calcs.flatMap((c) =>
      (computeFigures(c, today) ?? []).map((f) => f.text),
    );
    // written with cents, as the recording was
    expect(lines).toEqual(
      expect.arrayContaining([
        "Cedar Office: 150.00",
        "Delta Legal: 250.50",
        "Grand total overdue: 400.50 EUR",
      ]),
    );
    expect(lines.join("\n")).not.toMatch(/Acme Cloud: /);
  });
});

describe("a summary written from the decisions (A.5)", () => {
  // the hard bench's crm: one decision per lead, then "leads in each tier"
  const decisions = (tiers: string[]): TemplateContext => ({
    inputs: { date: "2026-11-04" },
    steps: {
      s1: {
        result: {
          leads: tiers.map((_, i) => ({
            id: `L${100 + i}`,
            email: `a${i}@x.com`,
          })),
        },
      },
      s3: {
        results: tiers.map((tier, i) => ({
          id: `L${100 + i}`,
          action: "update_lead",
          tier,
        })),
      },
    },
  });
  const t = (n: number, tier: string) => Array<string>(n).fill(tier);
  const recorded = decisions([
    ...t(4, "enterprise"),
    ...t(4, "mid"),
    ...t(2, "smb"),
  ]);
  const text =
    "Today's lead tiering is complete (2026-11-04). 10 leads were processed. " +
    "Tier summary: enterprise = 4, mid = 4, smb = 2. Tiers were assigned by employee count.";

  it("learns the count per tier over the decisions, written in one sentence", () => {
    const calcs = learnCalculations(text, recorded);
    const perTier = calcs.find((c) => c.per === "tier");
    expect(perTier).toMatchObject({
      op: "count",
      per: "tier",
      list: "steps.s3.results",
    });
    const today = decisions([
      ...t(1, "mid"),
      ...t(5, "smb"),
      ...t(2, "enterprise"),
    ]);
    expect(computeFigures(perTier!, today)?.map((f) => f.text)).toEqual([
      "mid: 1",
      "smb: 5",
      "enterprise: 2",
    ]);
  });
});

describe("counting log lines by a word", () => {
  const logs = (bySvc: Record<string, string[]>): TemplateContext => ({
    inputs: {},
    steps: {
      s1: {
        results: Object.entries(bySvc).map(([service, lines]) => ({
          service,
          lines,
        })),
      },
    },
  });
  const L = (level: string, n: number, svc: string) =>
    Array.from(
      { length: n },
      (_, i) => `2026-11-01T00:0${i % 10}:00Z ${level} ${svc}: something ${i}`,
    );
  const recorded = logs({
    payments: [...L("INFO", 30, "payments"), ...L("ERROR", 7, "payments")],
    search: [...L("ERROR", 12, "search"), ...L("WARN", 9, "search")],
    auth: [...L("INFO", 5, "auth"), ...L("ERROR", 3, "auth")],
  });
  const text =
    "Error summary\n- payments: 7 errors\n- search: 12 errors\n- auth: 3 errors";

  it("learns the ERROR count of each service and computes it on new logs", () => {
    const calcs = learnCalculations(text, recorded);
    const calc = calcs.find((c) => c.group);
    expect(calc).toMatchObject({
      op: "count",
      match: "ERROR",
      group: { name: "service", path: "lines" },
    });
    const today = logs({
      payments: [...L("ERROR", 2, "payments"), ...L("WARN", 40, "payments")],
      search: L("INFO", 10, "search"),
    });
    expect(computeFigures(calc!, today)?.map((f) => f.text)).toEqual([
      "payments: 2",
      "search: 0",
    ]);
  });

  it("also when every service is written in one paragraph", () => {
    // a free model's recording on the hard bench, one line for all services
    const paragraph =
      '2026-11-01 error summary: payments — 7 ERROR lines; most frequent: "timeout" (4 occurrences). ' +
      'search — 12 ERROR lines; most frequent: "rate limit" (8 occurrences). ' +
      'auth — 3 ERROR lines; most frequent: "bad token" (2 occurrences).';
    expect(
      learnCalculations(paragraph, recorded).find((c) => c.group),
    ).toMatchObject({ op: "count", match: "ERROR" });
  });

  it("learns each service's most frequent error message, written after its count", () => {
    const M = (n: number, svc: string, msg: string) =>
      Array.from(
        { length: n },
        (_, i) => `2026-11-01T00:0${i % 10}:00Z ERROR ${svc}: ${msg}`,
      );
    const day = (bySvc: Record<string, string[]>): TemplateContext => ({
      inputs: {},
      steps: {
        s1: {
          results: Object.entries(bySvc).map(([service, lines]) => ({
            service,
            lines,
          })),
        },
      },
    });
    const rec = day({
      payments: [
        ...L("INFO", 20, "payments"),
        ...M(5, "payments", "db connection reset"),
        ...M(2, "payments", "timeout calling upstream"),
      ],
      search: [
        ...M(8, "search", "rate limit exceeded"),
        ...M(4, "search", "timeout calling upstream"),
      ],
      auth: [...M(3, "auth", "invalid token signature")],
    });
    const report =
      'payments — 7 ERROR lines; most frequent: "db connection reset" (5 occurrences). ' +
      'search — 12 ERROR lines; most frequent: "rate limit exceeded" (8 occurrences). ' +
      'auth — 3 ERROR lines; most frequent: "invalid token signature" (3 occurrences).';
    const calcs = learnCalculations(report, rec);
    const top = calcs.find((c) => c.group && c.op === "top");
    expect(top).toMatchObject({ op: "top", match: "ERROR" });
    const today = day({
      payments: M(2, "payments", "disk quota reached"),
      search: [
        ...M(1, "search", "db connection reset"),
        ...M(6, "search", "timeout calling upstream"),
      ],
      auth: L("INFO", 4, "auth"),
    });
    const figs = computeFigures(top!, today)!;
    expect(figs.map((f) => f.text)).toEqual([
      "payments most frequent ERROR message: disk quota reached (2)",
      "search most frequent ERROR message: timeout calling upstream (6)",
      "auth most frequent ERROR message: none (0)",
    ]);
    expect(figs[1]).toMatchObject({ name: "timeout calling upstream" });
  });

  it("also when the same tool was called once per service, as separate steps", () => {
    const steps: TemplateContext["steps"] = {
      s1: {
        result: {
          service: "payments",
          lines: [...L("INFO", 30, "payments"), ...L("ERROR", 7, "payments")],
        },
      },
      s2: {
        result: {
          service: "search",
          lines: [...L("ERROR", 12, "search"), ...L("WARN", 9, "search")],
        },
      },
      s3: {
        result: {
          service: "auth",
          lines: [...L("INFO", 5, "auth"), ...L("ERROR", 3, "auth")],
        },
      },
    };
    const calc = learnCalculations(text, { inputs: {}, steps }).find(
      (c) => c.group,
    );
    expect(calc).toMatchObject({
      op: "count",
      match: "ERROR",
      group: {
        name: "service",
        path: "lines",
        refs: ["steps.s1.result", "steps.s2.result", "steps.s3.result"],
      },
    });
    const today: TemplateContext["steps"] = {
      s1: { result: { service: "payments", lines: L("ERROR", 4, "payments") } },
      s2: { result: { service: "search", lines: L("ERROR", 11, "search") } },
      s3: { result: { service: "auth", lines: L("WARN", 2, "auth") } },
    };
    expect(
      computeFigures(calc!, { inputs: {}, steps: today })?.map((f) => f.text),
    ).toEqual(["payments: 4", "search: 11", "auth: 0"]);
  });
});
