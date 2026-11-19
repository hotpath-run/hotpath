import { describe, expect, it } from "vitest";

import {
  hostedMode,
  isRemoteServer,
  remoteServerUrl,
} from "../src/tool-backends.js";

describe("remoteServerUrl", () => {
  it("runs a local command outside hosted mode", () => {
    expect(remoteServerUrl("node tools.js", false)).toBeNull();
  });

  it("refuses a local command in hosted mode", () => {
    expect(() => remoteServerUrl("node tools.js", true)).toThrow(
      /hosted mode runs only remote tools.*"node"/,
    );
  });

  it("accepts a public https endpoint in both modes", () => {
    expect(remoteServerUrl("https://tools.example.com/mcp", true)?.href).toBe(
      "https://tools.example.com/mcp",
    );
    expect(
      remoteServerUrl("https://tools.example.com/mcp", false),
    ).not.toBeNull();
  });

  it("refuses plain http and private addresses, hosted or not", () => {
    for (const hosted of [true, false]) {
      expect(() =>
        remoteServerUrl("http://tools.example.com/", hosted),
      ).toThrow(/only https/);
      expect(() => remoteServerUrl("https://169.254.169.254/", hosted)).toThrow(
        /metadata/,
      );
    }
  });
});

describe("hostedMode / isRemoteServer", () => {
  it("is on only with HOTPATH_HOSTED=1", () => {
    expect(hostedMode({ HOTPATH_HOSTED: "1" })).toBe(true);
    expect(hostedMode({})).toBe(false);
  });
  it("tells a URL from a command", () => {
    expect(isRemoteServer("https://x.example.com")).toBe(true);
    expect(isRemoteServer("node dist/index.js")).toBe(false);
  });
});

describe("runWorkflow in hosted mode", () => {
  it("refuses to start the workflow's local server command", async () => {
    const { runWorkflow } = await import("../src/runtime.js");
    process.env.HOTPATH_HOSTED = "1";
    try {
      await expect(
        runWorkflow(
          {
            task: "hosted-check",
            server: "node examples/demo-tools/dist/finance.js",
            inputs: {},
            steps: [],
          } as never,
          { inputs: {} },
        ),
      ).rejects.toThrow(/hosted mode runs only remote tools/);
    } finally {
      delete process.env.HOTPATH_HOSTED;
    }
  });

  it("refuses a remote server on a private address before connecting", async () => {
    const { runWorkflow } = await import("../src/runtime.js");
    await expect(
      runWorkflow(
        {
          task: "hosted-check",
          server: "https://10.0.0.8/mcp",
          inputs: {},
          steps: [],
        } as never,
        { inputs: {} },
      ),
    ).rejects.toThrow(/private address/);
  });
});
