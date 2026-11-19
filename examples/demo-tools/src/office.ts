import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { errorResult, jsonResult, registerSendMessage } from "./common.js";
import { loadFixture } from "./fixtures.js";
import type { Office } from "./office-data.js";

// One server for the benchmark suite's seven "office" tasks (task 06):
// pagination, lookups that feed each other, a long report, a read that fails
// once, two places to write to, numbers to add up, and times across zones.
// Each task uses a different subset of the tools; all data is in office.json.
const server = new McpServer({ name: "demo-tools-office", version: "0.1.0" });

const readOnly = { readOnlyHint: true };
const date = z.string().describe("Day, ISO, e.g. 2026-10-01");
const office = () => loadFixture<Office>("office");

// ticket-pages: pagination
server.registerTool(
  "list_tickets",
  {
    description:
      "List open support tickets, one page at a time. Pages start at 1; next_page is null on the last page",
    inputSchema: {
      page: z.number().int().min(1).describe("Page number"),
      date,
    },
    annotations: readOnly,
  },
  async ({ page }) => {
    const { pages } = (await office()).tickets;
    const tickets = pages[page - 1];
    if (!tickets) return errorResult(`no such page: ${page}`);
    return jsonResult({
      page,
      tickets,
      next_page: page < pages.length ? page + 1 : null,
    });
  },
);

// customer-lookup: each call needs the result of the one before
server.registerTool(
  "get_latest_order",
  {
    description: "Get the most recent order of the day",
    inputSchema: { date },
    annotations: readOnly,
  },
  async () => jsonResult((await office()).order),
);

server.registerTool(
  "get_customer",
  {
    description: "Get a customer by id (e.g. C-204)",
    inputSchema: { id: z.string().describe("Customer id") },
    annotations: readOnly,
  },
  async ({ id }) => {
    const customer = (await office()).customers[id];
    return customer
      ? jsonResult(customer)
      : errorResult(`unknown customer: ${id}`);
  },
);

server.registerTool(
  "get_shipping",
  {
    description:
      "Get the shipping status of an order by its id (e.g. ORD-7731)",
    inputSchema: { order_id: z.string().describe("Order id") },
    annotations: readOnly,
  },
  async ({ order_id }) => {
    const shipping = (await office()).shipping[order_id];
    return shipping
      ? jsonResult(shipping)
      : errorResult(`unknown order: ${order_id}`);
  },
);

// long-report: 22 calls
server.registerTool(
  "list_projects",
  {
    description: "List the company's active projects",
    inputSchema: { date },
    annotations: readOnly,
  },
  async () => jsonResult((await office()).projects),
);

const projectId = z.string().describe("Project id, e.g. P-01");
for (const [name, description, pick] of [
  [
    "get_project_status",
    "Get a project's status and progress",
    ["status", "progress"],
  ],
  ["get_project_risks", "Get a project's open risks", ["risks"]],
  [
    "get_project_budget",
    "Get a project's budget and spend so far",
    ["spent", "budget"],
  ],
] as const) {
  server.registerTool(
    name,
    { description, inputSchema: { id: projectId }, annotations: readOnly },
    async ({ id }) => {
      const detail = (await office()).project_details[id] as
        Record<string, unknown> | undefined;
      if (!detail) return errorResult(`unknown project: ${id}`);
      return jsonResult({
        id,
        ...Object.fromEntries(pick.map((key) => [key, detail[key]])),
      });
    },
  );
}

// flaky-sales: the first read of a server process fails, the retry works
let salesReads = 0;
server.registerTool(
  "get_sales",
  {
    description:
      "Get the day's sales by region (the service is sometimes briefly unavailable: try again)",
    inputSchema: { date },
    annotations: readOnly,
  },
  async () => {
    salesReads++;
    if (salesReads === 1) {
      return errorResult(
        "503 sales service temporarily unavailable, please retry",
      );
    }
    return jsonResult((await office()).sales);
  },
);

// two-places
server.registerTool(
  "get_incident",
  {
    description: "Get the day's main production incident",
    inputSchema: { date },
    annotations: readOnly,
  },
  async () => jsonResult((await office()).incident),
);

// invoice-total: the sum is for the model to work out
server.registerTool(
  "list_invoices",
  {
    description: "List the day's unpaid invoices",
    inputSchema: { date },
    annotations: readOnly,
  },
  async () => jsonResult((await office()).invoices),
);

// meeting-times: UTC in, local time out
server.registerTool(
  "list_meetings",
  {
    description:
      "List the day's meetings with start times in UTC, and the user's time zone and UTC offset",
    inputSchema: { date },
    annotations: readOnly,
  },
  async () => jsonResult((await office()).meetings),
);

registerSendMessage(server);

await server.connect(new StdioServerTransport());
