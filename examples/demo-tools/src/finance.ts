import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { errorResult, jsonResult, registerSendMessage } from "./common.js";
import { loadFixture } from "./fixtures.js";

// A finance team's bank reconciliation (benchmark suite): bank lines that come
// in pages, in several currencies; ledger entries to match them against; an
// exchange rate per currency. Nothing here touches a real bank.
interface Finance {
  date: string;
  pages: Array<Array<Record<string, unknown>>>;
  ledger: Array<Record<string, unknown>>;
  rates: Record<string, number>;
  // drift suite: how this day's tools differ from the recorded ones
  /** a tool answers {error: "…"} as a normal result (no isError) */
  errorPayload?: Record<string, string>;
  /** list_bank_lines wraps its lines one level deeper: {page, <nest>: {lines}} */
  nest?: string;
  /** tools registered under another name */
  rename?: Record<string, string>;
}

const server = new McpServer({ name: "demo-tools-finance", version: "0.1.0" });
const readOnly = { readOnlyHint: true };
const date = z.string().describe("Day, ISO, e.g. 2026-10-01");
const finance = () => loadFixture<Finance>("finance");
// names are fixed when the server starts, so a renamed tool is read once here
const { rename = {} } = await finance();
const named = (tool: string) => rename[tool] ?? tool;
const failing = async (tool: string) => (await finance()).errorPayload?.[tool];

server.registerTool(
  named("list_bank_lines"),
  {
    description:
      "List the day's bank statement lines, one page at a time. Pages start at 1; next_page is null on the last page. Amounts are in the line's own currency",
    inputSchema: {
      page: z.number().int().min(1).describe("Page number"),
      date,
    },
    annotations: readOnly,
  },
  async ({ page }) => {
    const error = await failing("list_bank_lines");
    if (error) return jsonResult({ error });
    const { pages, nest } = await finance();
    const lines = pages[page - 1];
    if (!lines) return errorResult(`no such page: ${page}`);
    const next_page = page < pages.length ? page + 1 : null;
    return jsonResult(
      nest
        ? { page, [nest]: { lines }, next_page }
        : { page, lines, next_page },
    );
  },
);

server.registerTool(
  named("list_ledger"),
  {
    description:
      "List the day's ledger entries (what the books say was paid or received), in EUR, each with the bank reference it belongs to",
    inputSchema: { date },
    annotations: readOnly,
  },
  async () => {
    const error = await failing("list_ledger");
    return jsonResult(error ? { error } : (await finance()).ledger);
  },
);

server.registerTool(
  named("get_fx_rate"),
  {
    description:
      "Get the exchange rate of a currency: how many EUR one unit is worth (e.g. USD)",
    inputSchema: { currency: z.string().describe("Currency code, e.g. USD") },
    annotations: readOnly,
  },
  async ({ currency }) => {
    const { rates } = await finance();
    const rate = rates[currency];
    if (rate === undefined) return errorResult(`no rate for ${currency}`);
    return jsonResult({ currency, eur_per_unit: rate });
  },
);

registerSendMessage(server);

await server.connect(new StdioServerTransport());
