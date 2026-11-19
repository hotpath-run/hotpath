import { describe, expect, it, vi } from "vitest";

import { splitIdleMs } from "../src/recorder.js";

describe("splitIdleMs (HOTPATH_SPLIT_IDLE_MS)", () => {
  it("defaults to 10 minutes", () => {
    expect(splitIdleMs(undefined)).toBe(600_000);
    expect(splitIdleMs("")).toBe(600_000);
  });

  it("reads a positive number of milliseconds", () => {
    expect(splitIdleMs("400")).toBe(400);
  });

  it("falls back to the default, with a warning, on a bad value", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(splitIdleMs("soon")).toBe(600_000);
    expect(splitIdleMs("0")).toBe(600_000);
    expect(err).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });
});
