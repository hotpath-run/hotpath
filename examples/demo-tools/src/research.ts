import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { errorResult, jsonResult, registerSendMessage } from "./common.js";
import { BATCH_DATES, capText, htmlToText, leadsFor } from "./research-lib.js";

// Lead research on real websites: the heavy, repeated kind of agent work
// (two long pages per company, every day). Reads are live HTTP GETs of public
// pages; the only side effect is send_message, which writes a local file.
const server = new McpServer({ name: "demo-tools-research", version: "0.1.0" });

// ~6k tokens per page: long enough to be real, short enough for free tiers
const MAX_CHARS = Number(process.env.RESEARCH_MAX_CHARS ?? 24_000);

server.registerTool(
  "get_leads",
  {
    description:
      "Today's leads to research: company name, homepage and pricing page",
    inputSchema: { date: z.string().describe("ISO date, e.g. 2026-11-02") },
    annotations: { readOnlyHint: true },
  },
  async ({ date }) => {
    const leads = leadsFor(date);
    return leads
      ? jsonResult({ leads })
      : errorResult(
          `no leads for ${date}; dates with leads: ${BATCH_DATES.join(", ")}`,
        );
  },
);

server.registerTool(
  "fetch_page",
  {
    description: "Fetch a web page and return its readable text",
    inputSchema: { url: z.string().describe("Full https URL") },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ url }) => {
    if (!/^https:\/\//.test(url)) return errorResult("only https URLs");
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0 (research demo)" },
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      });
      const text = htmlToText(await response.text());
      return jsonResult({
        url,
        status: response.status,
        text: capText(text, MAX_CHARS),
      });
    } catch (err) {
      return errorResult(
        `could not fetch ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
);

registerSendMessage(server);

const transport = new StdioServerTransport();
await server.connect(transport);
