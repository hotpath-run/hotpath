// An installed hotpath has no Vite: it serves the viewer from built files.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { builtViewerDir, startStaticViewer } from "../src/server.js";

let dir: string;
let close: (() => Promise<void>) | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "hotpath viewer é-"));
  await mkdir(path.join(dir, "viewer", "assets"), { recursive: true });
  await writeFile(
    path.join(dir, "viewer", "index.html"),
    "<html>viewer</html>",
  );
  await writeFile(
    path.join(dir, "viewer", "assets", "app.js"),
    "console.log(1)",
  );
  await writeFile(path.join(dir, "secret.txt"), "outside the viewer folder");
});
afterEach(async () => {
  await close?.();
  close = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe("built viewer", () => {
  it("is found next to the bundle, and not in a checkout", () => {
    expect(builtViewerDir(path.join(dir, "dist"))).toBe(
      path.join(dir, "viewer"),
    );
    expect(builtViewerDir()).toBeNull();
  });

  it("serves the page, its assets and the workflow, on 127.0.0.1", async () => {
    let calls = 0;
    const viewer = await startStaticViewer(
      path.join(dir, "viewer"),
      async () => ({ task: "t", n: ++calls }),
      0,
    );
    close = viewer.close;
    expect(viewer.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    const page = await fetch(viewer.url);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toBe("<html>viewer</html>");

    const asset = await fetch(`${viewer.url}assets/app.js`);
    expect(asset.headers.get("content-type")).toContain("javascript");

    // read again on every request: a recompile shows up on refresh
    expect(await (await fetch(`${viewer.url}api/workflow`)).json()).toEqual({
      task: "t",
      n: 1,
    });
    expect(await (await fetch(`${viewer.url}api/workflow`)).json()).toEqual({
      task: "t",
      n: 2,
    });
  });

  it("never serves a file outside the viewer folder", async () => {
    const viewer = await startStaticViewer(
      path.join(dir, "viewer"),
      async () => ({}),
      0,
    );
    close = viewer.close;
    for (const attempt of [
      "..%2Fsecret.txt",
      "%2e%2e/secret.txt",
      "assets/..%2F..%2Fsecret.txt",
      "..%5Csecret.txt",
    ]) {
      const res = await fetch(`${viewer.url}${attempt}`);
      expect(res.status, attempt).toBe(404);
      expect(await res.text()).not.toContain("outside the viewer folder");
    }
    expect((await fetch(`${viewer.url}missing.js`)).status).toBe(404);
  });

  it("reports a workflow that can't be read as a 500 with the reason", async () => {
    const viewer = await startStaticViewer(
      path.join(dir, "viewer"),
      async () => {
        throw new Error("no workflow for task");
      },
      0,
    );
    close = viewer.close;
    const res = await fetch(`${viewer.url}api/workflow`);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("no workflow for task");
  });
});
