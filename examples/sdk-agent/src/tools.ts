import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Tools } from "@hotpathrun/sdk";
import { projectRoot } from "@hotpathrun/shared";

// The agent's tools: ordinary functions in its own code, as most agents built
// inside a company have them. Nothing here knows about Hotpath or MCP.

const fixtures = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/orders.json",
);

interface Day {
  orders: Array<{
    id: string;
    customer: string;
    total: number;
    status: string;
  }>;
  alerts: Array<{ sku: string; name: string; left: number }>;
}

async function day(date: string): Promise<Day> {
  const all = JSON.parse(await readFile(fixtures, "utf8")) as Record<
    string,
    Day
  >;
  return all[date] ?? { orders: [], alerts: [] };
}

/** Where send_report "sends": a file, like every demo tool in this repository. */
export const reportsFile = path.join(projectRoot(), "out", "sdk-reports.json");

const dateParam = {
  type: "object",
  properties: { date: { type: "string", description: "ISO date" } },
  required: ["date"],
};

export const tools = {
  get_orders: {
    description: "The orders placed on a date",
    parameters: dateParam,
    readOnly: true,
    execute: async ({ date }: { date: string }) => ({
      orders: (await day(date)).orders,
    }),
  },
  get_stock_alerts: {
    description: "Products that are low or out of stock on a date",
    parameters: dateParam,
    readOnly: true,
    execute: async ({ date }: { date: string }) => ({
      alerts: (await day(date)).alerts,
    }),
  },
  send_report: {
    description: "Send the daily report to someone",
    parameters: {
      type: "object",
      properties: { to: { type: "string" }, text: { type: "string" } },
      required: ["to", "text"],
    },
    // not readOnly: it sends. A dry run skips it and it never runs twice.
    execute: async ({ to, text }: { to: string; text: string }) => {
      let sent: Array<{ to: string; text: string; at: string }> = [];
      try {
        sent = JSON.parse(await readFile(reportsFile, "utf8")) as typeof sent;
      } catch {
        sent = [];
      }
      sent.push({ to, text, at: new Date().toISOString() });
      await mkdir(path.dirname(reportsFile), { recursive: true });
      await writeFile(reportsFile, JSON.stringify(sent, null, 2));
      return { ok: true, id: `r${sent.length}` };
    },
  },
} satisfies Tools;
