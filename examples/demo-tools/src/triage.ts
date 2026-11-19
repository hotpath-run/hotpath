import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { appendAction } from "./actions.js";
import { errorResult, jsonResult } from "./common.js";
import { loadFixture } from "./fixtures.js";

// Demo tools for the branching tasks (task 03). `mail-triage`: one email
// whose priority picks the action (urgent → page the on-call, normal → add to
// the digest, spam → archive, billing → forward to finance). `inbox-sweep`: a
// mailbox where only the spam is archived. Every action is written to
// out/actions.json; nothing touches the real world.
const server = new McpServer({ name: "demo-tools-triage", version: "0.1.0" });

const readOnly = { readOnlyHint: true };
const act = { readOnlyHint: false, destructiveHint: false };
const date = z.string().describe("Day, ISO, e.g. 2026-10-01");

interface Triage {
  email: Record<string, unknown>;
  mailbox: Array<Record<string, unknown>>;
}

server.registerTool(
  "get_email",
  {
    description: "Get today's incoming email (sender, subject, priority, body)",
    inputSchema: { date },
    annotations: readOnly,
  },
  async () => jsonResult((await loadFixture<Triage>("triage")).email),
);

server.registerTool(
  "get_mailbox",
  {
    description:
      "List the mailbox: every email with its id, sender, subject and category",
    inputSchema: { date },
    annotations: readOnly,
  },
  async () =>
    jsonResult({ emails: (await loadFixture<Triage>("triage")).mailbox }),
);

const subject = z.string().describe("Subject of the email");
for (const [name, description, input] of [
  ["page_oncall", "Page the on-call engineer about an email", { subject }],
  ["add_to_digest", "Add an email to today's digest", { subject }],
  ["forward_to_finance", "Forward an email to the finance team", { subject }],
] as const) {
  server.registerTool(
    name,
    { description, inputSchema: input, annotations: act },
    async (args) => {
      const done = await appendAction({ kind: name, ...args });
      return jsonResult({ ok: true, seq: done.seq });
    },
  );
}

server.registerTool(
  "archive",
  {
    description: "Archive an email by its id",
    inputSchema: { id: z.string().describe("Email id") },
    annotations: act,
  },
  async ({ id }) => {
    if (!id.trim()) return errorResult("an email id is needed");
    const done = await appendAction({ kind: "archive", id });
    return jsonResult({ ok: true, seq: done.seq });
  },
);

await server.connect(new StdioServerTransport());
