import type { LookupAddress } from "node:dns";
import { describe, expect, it } from "vitest";

import {
  checkUrl,
  EgressError,
  forbiddenAddress,
  guardedFetch,
  guardedLookup,
} from "../src/egress.js";

describe("forbiddenAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd00:ec2::254", // AWS metadata over IPv6
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "64:ff9b::a9fe:a9fe",
  ])("refuses %s", (ip) => {
    expect(forbiddenAddress(ip)).not.toBeNull();
  });

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"])(
    "allows %s",
    (ip) => {
      expect(forbiddenAddress(ip)).toBeNull();
    },
  );
});

describe("checkUrl", () => {
  it("allows a public https URL", () => {
    expect(checkUrl("https://tools.example.com/mcp").host).toBe(
      "tools.example.com",
    );
  });
  it.each([
    ["http://tools.example.com/mcp", /only https/],
    ["https://127.0.0.1/mcp", /loopback/],
    ["https://[::1]/mcp", /loopback/],
    ["https://169.254.169.254/latest/meta-data", /metadata/],
    ["https://localhost:8443/", /local name/],
    ["https://metadata.google.internal/", /local name/],
    ["https://user:pw@tools.example.com/", /credentials/],
    ["file:///etc/passwd", /only https/],
    ["not a url", /not a valid URL/],
  ])("refuses %s", (url, why) => {
    expect(() => checkUrl(url)).toThrow(why);
  });
});

describe("guardedLookup (DNS rebinding)", () => {
  const fakeDns =
    (answers: LookupAddress[]) =>
    (_h: string, _o: unknown, cb: (e: null, a: LookupAddress[]) => void) =>
      cb(null, answers);

  it("refuses a public name that resolves to a private address", async () => {
    const lookup = guardedLookup(
      fakeDns([{ address: "10.0.0.5", family: 4 }]) as never,
    );
    const err = await new Promise((resolve) =>
      lookup("tools.example.com", {}, (e) => resolve(e)),
    );
    expect(err).toBeInstanceOf(EgressError);
    expect(String(err)).toMatch(/resolves to 10.0.0.5/);
  });

  it("refuses when any one of several answers is private", async () => {
    const lookup = guardedLookup(
      fakeDns([
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]) as never,
    );
    const err = await new Promise((resolve) =>
      lookup("tools.example.com", { all: true }, (e) => resolve(e)),
    );
    expect(err).toBeInstanceOf(EgressError);
  });

  it("passes public answers through", async () => {
    const lookup = guardedLookup(
      fakeDns([{ address: "93.184.216.34", family: 4 }]) as never,
    );
    const address = await new Promise((resolve) =>
      lookup("tools.example.com", {}, (_e, a) => resolve(a)),
    );
    expect(address).toBe("93.184.216.34");
  });
});

describe("guardedFetch", () => {
  it("refuses before connecting when the URL is not allowed", async () => {
    const f = guardedFetch();
    await expect(f("http://example.com/")).rejects.toThrow(/only https/);
    await expect(f("https://127.0.0.1/")).rejects.toThrow(/loopback/);
  });

  it("refuses at connect time when the name resolves to a private address", async () => {
    const f = guardedFetch({
      lookup: ((
        _h: string,
        _o: unknown,
        cb: (e: null, a: LookupAddress[]) => void,
      ) => cb(null, [{ address: "169.254.169.254", family: 4 }])) as never,
    });
    await expect(f("https://rebind.example.com/")).rejects.toThrow(
      /resolves to 169.254.169.254/,
    );
  });
});
