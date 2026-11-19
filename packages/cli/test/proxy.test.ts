import { describe, expect, it } from "vitest";

import { createProgram } from "../src/program.js";
import { proxyBanner, proxyOptions } from "../src/proxy.js";

describe("hotpath proxy", () => {
  it("is a command with its flags", () => {
    const proxy = createProgram().commands.find((c) => c.name() === "proxy")!;
    const help = proxy.helpInformation();
    for (const flag of [
      "--port",
      "--host",
      "--openai",
      "--anthropic",
      "--read-only",
      "--record-only",
    ]) {
      expect(help).toContain(flag);
    }
  });

  it("turns flags into proxy options", () => {
    const options = proxyOptions({
      port: "9000",
      host: "127.0.0.1",
      openai: "http://localhost:11434/v1",
      anthropic: "https://api.anthropic.com",
      readOnly: "get_orders, get_stock_alerts",
      recordOnly: true,
    });
    expect(options).toEqual({
      port: 9000,
      host: "127.0.0.1",
      openaiUpstream: "http://localhost:11434/v1",
      anthropicUpstream: "https://api.anthropic.com",
      mode: "record",
      readOnly: ["get_orders", "get_stock_alerts"],
    });
    expect(proxyBanner("http://127.0.0.1:9000", options)).toContain(
      'baseURL: "http://127.0.0.1:9000/v1"',
    );
  });
});
