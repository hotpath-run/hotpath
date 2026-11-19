// Writes the drift-suite fixture sets for bank-reconciliation, each one a copy
// of the new-data day with one kind of change. Run: node scripts/make-drift-fixtures.mjs
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const dir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures",
);
const base = JSON.parse(
  await readFile(path.join(dir, "new-data/finance.json"), "utf8"),
);
const baseExpected = JSON.parse(
  await readFile(
    path.join(dir, "new-data/bank-reconciliation.expected.json"),
    "utf8",
  ),
);
const clone = (x) => JSON.parse(JSON.stringify(x));
const mapLines = (f, fn) => ({ ...f, pages: f.pages.map((p) => p.map(fn)) });

const sets = {
  // a field the recording used is gone
  "drift-removed-field": {
    finance: mapLines(clone(base), (l) => {
      const rest = { ...l };
      delete rest.description;
      return rest;
    }),
    expected: baseExpected,
  },
  // amounts come as strings
  "drift-type-change": {
    finance: mapLines(clone(base), (l) => ({ ...l, amount: String(l.amount) })),
    expected: baseExpected,
  },
  // a currency the recording never saw (CHF), on an unmatched line
  "drift-new-enum": {
    finance: {
      ...mapLines(clone(base), (l) =>
        l.ref === "BK-2007" ? { ...l, currency: "CHF" } : l,
      ),
      rates: { ...base.rates, CHF: 1.05 },
    },
    expected: {
      ...baseExpected,
      mustMention: ["BK-2002", "BK-2006", "BK-2007", "432.75"],
      exact: {
        ...baseExpected.exact,
        total: { value: -432.75, tolerance: 0.01 },
        lines: [
          { ref: "BK-2002", amount: -108 },
          { ref: "BK-2006", amount: -225 },
          { ref: "BK-2007", amount: -99.75 },
        ],
      },
    },
  },
  // nothing on the statement today
  "drift-empty-list": {
    finance: { ...clone(base), pages: [[]], ledger: [] },
    expected: {
      date: base.date,
      mustMention: [],
      exact: { total: { value: 0 } },
    },
  },
  // the ledger answers with an error object instead of entries
  "drift-error-payload": {
    finance: {
      ...clone(base),
      errorPayload: { list_ledger: "ledger service unavailable" },
    },
    expected: { date: base.date, mustMention: [], noReport: true },
  },
  // the lines sit one level deeper
  "drift-extra-nesting": {
    finance: { ...clone(base), nest: "data" },
    expected: baseExpected,
  },
  // the rate tool has a new name
  "drift-renamed-tool": {
    finance: { ...clone(base), rename: { get_fx_rate: "get_exchange_rate" } },
    expected: baseExpected,
  },
};

for (const [name, { finance, expected }] of Object.entries(sets)) {
  await mkdir(path.join(dir, name), { recursive: true });
  await writeFile(
    path.join(dir, name, "finance.json"),
    `${JSON.stringify(finance, null, 2)}\n`,
  );
  await writeFile(
    path.join(dir, name, "bank-reconciliation.expected.json"),
    `${JSON.stringify(expected, null, 2)}\n`,
  );
}
process.stdout.write(`wrote ${Object.keys(sets).length} drift sets\n`);
