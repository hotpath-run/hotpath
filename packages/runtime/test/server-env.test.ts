import { describe, expect, it } from "vitest";

import { toolServerEnv } from "../src/runtime.js";

describe("toolServerEnv", () => {
  it("never hands Hotpath's model keys to a tool server", () => {
    const env = toolServerEnv({
      PATH: "/usr/bin",
      DEMO_FIXTURES: "new-data",
      LLM_API_KEY: ["sk", "secret"].join("-"),
      MOONSHOT_API_KEY: "sk-old",
      GEMINI_KEY_SAVED: "g-secret",
      SERVER_OWN_TOKEN: "kept",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      DEMO_FIXTURES: "new-data",
      SERVER_OWN_TOKEN: "kept",
    });
  });
});
