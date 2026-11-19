import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const actionsFile = path.resolve(packageRoot, "../..", "out", "actions.json");

async function startServer(fixtures: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/triage.ts"],
    cwd: packageRoot,
    env: { ...process.env, DEMO_FIXTURES: fixtures } as Record<string, string>,
  });
  const client = new Client({ name: "test-client", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
) {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text?: string }>;
  };
  const text = result.content.find((c) => c.type === "text")?.text ?? "";
  return { isError: result.isError === true, json: () => JSON.parse(text) };
}

const actions = async () => JSON.parse(await readFile(actionsFile, "utf8"));

beforeEach(() => rm(actionsFile, { force: true }));

describe("triage MCP server", () => {
  it("serves one email whose priority differs per fixture set", async () => {
    for (const [set, priority] of [
      ["triage-urgent", "urgent"],
      ["triage-normal", "normal"],
      ["triage-spam", "spam"],
      ["triage-billing", "billing"],
    ] as const) {
      const client = await startServer(set);
      expect(
        (await call(client, "get_email", { date: "d" })).json().priority,
      ).toBe(priority);
      await client.close();
    }
  });

  it("lists a mailbox where some emails are spam", async () => {
    const client = await startServer("sweep-a");
    const { emails } = (
      await call(client, "get_mailbox", { date: "d" })
    ).json();
    expect(
      emails.filter((e: { category: string }) => e.category === "spam"),
    ).toHaveLength(2);
    await client.close();
  });

  it("writes every action to out/actions.json, in order", async () => {
    const client = await startServer("triage-urgent");
    await call(client, "page_oncall", {
      subject: "Production database is down",
    });
    await call(client, "archive", { id: "e1" });
    expect(await actions()).toEqual([
      { seq: 1, kind: "page_oncall", subject: "Production database is down" },
      { seq: 2, kind: "archive", id: "e1" },
    ]);
    await client.close();
  });
});
