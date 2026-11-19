import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  findProject,
  projectRoot,
  resolveProjectRoot,
  runningFromSource,
  sourceRoot,
} from "../src/paths.js";

const abs = (...parts: string[]) => path.resolve("/", ...parts);

describe("project root", () => {
  it("in a checkout it is the repository, as before", () => {
    expect(runningFromSource()).toBe(true);
    expect(projectRoot()).toBe(path.resolve(import.meta.dirname, "../../.."));
  });

  it("knows a checkout from an installed build by where the file sits", () => {
    expect(sourceRoot(path.join("/repo", "packages", "shared", "src"))).toBe(
      path.normalize("/repo"),
    );
    expect(sourceRoot("C:\\repo\\packages\\shared\\dist")).toBe("C:\\repo");
    expect(
      sourceRoot(path.join("/usr/lib/node_modules/hotpath", "dist")),
    ).toBeNull();
  });

  it("HOTPATH_HOME wins over everything", () => {
    expect(
      resolveProjectRoot({
        env: { HOTPATH_HOME: abs("my project") },
        source: abs("repo"),
        cwd: abs("elsewhere"),
      }),
    ).toBe(abs("my project"));
  });

  it("installed: the nearest folder above the working folder that is a project", () => {
    const project = abs("home", "me", "hot");
    const exists = (file: string) =>
      file === path.join(project, ".hotpath") ||
      file === path.join(abs("other"), "hotpath.config.json");
    expect(
      resolveProjectRoot({
        env: {},
        source: null,
        cwd: path.join(project, "a", "b"),
        exists,
      }),
    ).toBe(project);
    expect(findProject(abs("other"), exists)).toBe(abs("other"));
  });

  // 0.3.0 before release kept the sign-in in ~/.hotpath, and every folder under
  // the home folder then counted as part of a project at the home folder.
  it("the home folder is a project only with hotpath.config.json, not .hotpath", () => {
    const home = abs("Users", "me");
    const work = path.join(home, "code", "agent");
    const onlyDotHotpath = (file: string) =>
      file === path.join(home, ".hotpath");
    expect(findProject(work, onlyDotHotpath, home)).toBeNull();
    expect(
      resolveProjectRoot({
        env: {},
        source: null,
        cwd: work,
        exists: onlyDotHotpath,
        home,
      }),
    ).toBe(work);
    const withConfig = (file: string) =>
      file === path.join(home, "hotpath.config.json");
    expect(findProject(work, withConfig, home)).toBe(home);
  });

  it("installed, in a folder that is not a project yet: that folder", () => {
    expect(
      resolveProjectRoot({
        env: { HOTPATH_HOME: "  " },
        source: null,
        cwd: abs("new place"),
        exists: () => false,
      }),
    ).toBe(abs("new place"));
  });
});
