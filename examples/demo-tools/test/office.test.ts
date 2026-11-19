import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function startServer(fixtures: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/office.ts"],
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
  return {
    isError: result.isError === true,
    text,
    json: () => JSON.parse(text),
  };
}

describe("office MCP server", () => {
  it("pages tickets: two pages by default, three with new data", async () => {
    const a = await startServer("default");
    expect(
      (await call(a, "list_tickets", { page: 1, date: "d" })).json().next_page,
    ).toBe(2);
    expect(
      (await call(a, "list_tickets", { page: 2, date: "d" })).json().next_page,
    ).toBeNull();
    expect(
      (await call(a, "list_tickets", { page: 3, date: "d" })).isError,
    ).toBe(true);
    await a.close();
    const b = await startServer("new-data");
    expect(
      (await call(b, "list_tickets", { page: 2, date: "d" })).json().next_page,
    ).toBe(3);
    await b.close();
  });

  it("chains order -> customer -> shipping", async () => {
    const c = await startServer("default");
    const order = (await call(c, "get_latest_order", { date: "d" })).json();
    const customer = (
      await call(c, "get_customer", { id: order.customer_id })
    ).json();
    const shipping = (
      await call(c, "get_shipping", { order_id: order.id })
    ).json();
    expect(customer.name).toBe("Fabienne Marchetti");
    expect(shipping.carrier).toBe("Colissimo");
    expect((await call(c, "get_customer", { id: "C-000" })).isError).toBe(true);
    await c.close();
  });

  it("serves a project's status, risks and budget separately (22 calls in all)", async () => {
    const c = await startServer("default");
    const projects = (await call(c, "list_projects", { date: "d" })).json();
    expect(projects).toHaveLength(7);
    expect(
      (await call(c, "get_project_status", { id: "P-02" })).json(),
    ).toEqual({
      id: "P-02",
      status: "at risk",
      progress: 35,
    });
    expect(
      (await call(c, "get_project_risks", { id: "P-02" })).json().risks[0]
        .title,
    ).toMatch(/Tax/);
    expect(
      (await call(c, "get_project_budget", { id: "P-02" })).json().budget,
    ).toBe(70);
    await c.close();
  });

  it("fails the first sales read and answers the retry", async () => {
    const c = await startServer("default");
    const first = await call(c, "get_sales", { date: "d" });
    expect(first.isError).toBe(true);
    expect(first.text).toMatch(/retry/);
    expect((await call(c, "get_sales", { date: "d" })).json()).toHaveLength(3);
    await c.close();
  });

  it("returns the incident, invoices and meetings", async () => {
    const c = await startServer("default");
    expect((await call(c, "get_incident", { date: "d" })).json().id).toBe(
      "INC-3391",
    );
    expect((await call(c, "list_invoices", { date: "d" })).json()).toHaveLength(
      3,
    );
    expect(
      (await call(c, "list_meetings", { date: "d" })).json().utc_offset,
    ).toBe("+02:00");
    await c.close();
  });

  it("renames one field of each first tool in the drift set", async () => {
    const c = await startServer("drift");
    expect(
      (await call(c, "list_tickets", { page: 1, date: "d" })).json().tickets[0],
    ).toHaveProperty("summary");
    expect(
      (await call(c, "get_latest_order", { date: "d" })).json(),
    ).toHaveProperty("client_id");
    expect(
      (await call(c, "get_incident", { date: "d" })).json(),
    ).toHaveProperty("name");
    await c.close();
  });
});
