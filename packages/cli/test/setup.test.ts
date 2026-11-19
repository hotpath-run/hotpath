// First steps: `hotpath init` writes .env without losing anything or showing
// the key; `hotpath doctor` says what works and the one thing to do next.
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatDoctor, runDoctor } from "../src/setup/doctor.js";
import { parseEnv, setEnv } from "../src/setup/env-file.js";
import { InitError, runInit, type Ask } from "../src/setup/init.js";

const FAKE_KEY = ["sk", "test", "0123456789abcdef"].join("-");

let dir: string;
let envFile: string;
let logs: string[];
const log = (l: string) => logs.push(l);

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "hotpath-setup-"));
  envFile = path.join(dir, ".env");
  logs = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("env file", () => {
  it("parses KEY=value lines, quotes and export, skipping comments", () => {
    expect(parseEnv("# c\nA=1\nexport B=\"two words\"\n\nC='x'")).toEqual({
      A: "1",
      B: "two words",
      C: "x",
    });
  });

  it("changes only the given keys, keeps comments and order, appends new ones", () => {
    const before = "# provider\r\nLLM_BASE_URL=old\r\nPRICE_AGENT_IN=3\r\n";
    const after = setEnv(before, {
      LLM_BASE_URL: "http://x/v1",
      HOTPATH_CHEAP_MODEL: "m",
    });
    expect(after).toBe(
      "# provider\r\nLLM_BASE_URL=http://x/v1\r\nPRICE_AGENT_IN=3\r\n\r\nHOTPATH_CHEAP_MODEL=m\r\n",
    );
  });

  it("quotes values with spaces or #", () => {
    expect(setEnv("", { A: "a b", B: "x#y" })).toBe('A="a b"\nB="x#y"\n');
  });
});

describe("hotpath init", () => {
  it("--provider ollama --yes writes a working local setup, no questions", async () => {
    const result = await runInit({
      envFile,
      provider: "ollama",
      yes: true,
      log,
    });
    const env = parseEnv(await readFile(envFile, "utf8"));
    expect(result.created).toBe(true);
    expect(env).toMatchObject({
      LLM_BASE_URL: "http://localhost:11434/v1",
      LLM_API_KEY: "ollama",
      HOTPATH_CHEAP_MODEL: "qwen3:1.7b",
      HOTPATH_REPAIR_MENTIONS: "1",
      PRICE_CHEAP_OUT: "0",
    });
    expect(logs.join("\n")).toMatch(/ollama pull qwen3:1\.7b/);
    expect(logs.join("\n")).toMatch(/hotpath doctor/);
  });

  // docs/SECURITY-REVIEW.md, finding 2 (Windows protects files with ACLs)
  it.skipIf(process.platform === "win32")(
    "the .env it writes is readable by its owner only, also when it existed",
    async () => {
      await writeFile(envFile, "PRICE_AGENT_IN=3\n", { mode: 0o644 });
      await runInit({ envFile, provider: "ollama", yes: true, log });
      expect((await stat(envFile)).mode & 0o777).toBe(0o600);
    },
  );

  it("asks for what is missing, never echoes or logs the key, and keeps other settings", async () => {
    await writeFile(envFile, "# mine\nPRICE_AGENT_IN=3\nMY_OTHER=keep\n");
    const asked: Array<{ q: string; secret?: boolean }> = [];
    const answers = ["3", "", FAKE_KEY, "", ""]; // groq, default URL, key, default models
    const ask: Ask = async (q, opts) => {
      asked.push({ q, secret: opts?.secret });
      return answers.shift() ?? "";
    };
    await runInit({ envFile, ask, log });
    const text = await readFile(envFile, "utf8");
    const env = parseEnv(text);
    expect(env.LLM_BASE_URL).toBe("https://api.groq.com/openai/v1");
    expect(env.LLM_API_KEY).toBe(FAKE_KEY);
    expect(env.MY_OTHER).toBe("keep");
    expect(text.startsWith("# mine\n")).toBe(true);
    expect(asked.find((a) => /API key/.test(a.q))?.secret).toBe(true);
    expect(logs.join("\n")).not.toContain(FAKE_KEY);
    expect(asked.map((a) => a.q).join("\n")).not.toContain(FAKE_KEY);
  });

  it("re-running keeps the current key when Enter is pressed", async () => {
    await runInit({
      envFile,
      provider: "groq",
      apiKey: FAKE_KEY,
      yes: true,
      log,
    });
    const ask: Ask = async () => "";
    await runInit({ envFile, provider: "groq", ask, log });
    expect(parseEnv(await readFile(envFile, "utf8")).LLM_API_KEY).toBe(
      FAKE_KEY,
    );
  });

  // 2026-11-19: `init --provider ollama --yes` run from a folder inside another
  // project replaced that project's paid key with "ollama", with no copy left.
  describe("an .env that already has a key for another setup", () => {
    const OTHER_KEY = ["sk", "other", "fedcba9876543210"].join("-");
    const original = [
      "# Claude (paid)",
      "LLM_BASE_URL=https://api.example-llm.com/v1/",
      `LLM_API_KEY=${OTHER_KEY}`,
      "HOTPATH_AGENT_MODEL=big-model",
      "PRICE_AGENT_IN=2",
      "",
    ].join("\n");
    const backups = async () =>
      (await readdir(dir)).filter((f) => f.startsWith(".env.backup-"));

    beforeEach(async () => {
      await writeFile(envFile, original);
    });

    it("--yes refuses to replace it, leaves the file untouched, and says what to do", async () => {
      const err = await runInit({
        envFile,
        provider: "ollama",
        yes: true,
        log,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InitError);
      const message = (err as Error).message;
      expect(message).toContain(envFile);
      expect(message).toMatch(/--force/);
      expect(message).toMatch(/--home/);
      expect(message).not.toContain(OTHER_KEY);
      expect(await readFile(envFile, "utf8")).toBe(original);
      expect(await backups()).toEqual([]);
    });

    it("asks before replacing it; Enter means no", async () => {
      const asked: string[] = [];
      const ask: Ask = async (q) => {
        asked.push(q);
        return "";
      };
      await expect(
        runInit({ envFile, provider: "ollama", ask, log }),
      ).rejects.toThrow(InitError);
      expect(asked.some((q) => /replace/i.test(q))).toBe(true);
      expect(asked.join("\n")).not.toContain(OTHER_KEY);
      expect(await readFile(envFile, "utf8")).toBe(original);
    });

    it("on yes, keeps a copy of the old file first, and says where", async () => {
      const ask: Ask = async (q) => (/replace/i.test(q) ? "y" : "");
      await runInit({ envFile, provider: "ollama", ask, log });
      expect(parseEnv(await readFile(envFile, "utf8")).LLM_API_KEY).toBe(
        "ollama",
      );
      const [backup] = await backups();
      expect(backup).toBeDefined();
      expect(await readFile(path.join(dir, backup!), "utf8")).toBe(original);
      const out = logs.join("\n");
      expect(out).toContain(backup!);
      expect(out).not.toContain(OTHER_KEY);
    });

    it("--force replaces it without asking, also with a copy", async () => {
      await runInit({
        envFile,
        provider: "ollama",
        yes: true,
        force: true,
        log,
      });
      expect(parseEnv(await readFile(envFile, "utf8")).LLM_API_KEY).toBe(
        "ollama",
      );
      expect(await backups()).toHaveLength(1);
    });

    it("re-running for the same setup needs no confirmation and makes no copy", async () => {
      await writeFile(
        envFile,
        "LLM_BASE_URL=http://localhost:11434/v1\nLLM_API_KEY=ollama\n",
      );
      await runInit({ envFile, provider: "ollama", yes: true, log });
      expect(await backups()).toEqual([]);
    });
  });

  it("explains what to pass when it can't ask", async () => {
    await expect(
      runInit({ envFile, provider: "groq", yes: true, log }),
    ).rejects.toThrow(/--api-key/);
    await expect(
      runInit({ envFile, provider: "nope", yes: true, log }),
    ).rejects.toThrow(InitError);
    await expect(
      runInit({ envFile, provider: "nope", yes: true, log }),
    ).rejects.toThrow(/use one of: ollama/);
  });
});

describe("hotpath doctor", () => {
  const dirs = () => ({
    workflowsDir: path.join(dir, "workflows"),
    tracesDir: path.join(dir, "traces"),
  });
  const home = () => path.join(dir, "home");
  const agentOptions = () => ({
    home: home(),
    cwd: path.join(dir, "proj"),
    env: {},
    platform: "linux" as const,
  });

  it("with nothing set up: says to run init first", async () => {
    const result = await runDoctor({
      envFile,
      ...dirs(),
      env: {},
      offline: true,
      agentOptions: agentOptions(),
    });
    expect(result.checks.find((c) => c.name === "Settings")?.status).toBe(
      "fail",
    );
    expect(result.next).toBe("run hotpath init");
    expect(formatDoctor(result)).toMatch(/✗ Settings/);
  });

  it("a working setup: lists agents and recording servers, and points to the next step", async () => {
    await writeFile(
      envFile,
      `LLM_BASE_URL=https://x/v1\nLLM_API_KEY=${FAKE_KEY}\nHOTPATH_AGENT_MODEL=a\nHOTPATH_CHEAP_MODEL=c\n`,
    );
    const cursor = path.join(home(), ".cursor", "mcp.json");
    await mkdir(path.dirname(cursor), { recursive: true });
    await writeFile(
      cursor,
      JSON.stringify({
        mcpServers: {
          gmail: {
            command: "node",
            args: ["/cli.js", "record", "--task", "t", "--", "gmail-mcp"],
          },
          github: { command: "gh-mcp" },
        },
      }),
    );
    const result = await runDoctor({
      envFile,
      ...dirs(),
      env: {},
      listModels: async () => ["a", "c", "z"],
      agentOptions: agentOptions(),
    });
    const text = formatDoctor(result);
    expect(text).toMatch(/✓ Provider\s+answered, 3 models listed/);
    expect(text).toMatch(/cursor \(2 servers, recording: gmail\)/);
    expect(text).not.toContain(FAKE_KEY);
    expect(result.next).toMatch(/do the task once in your agent/);
  });

  it("a missing model or an unreachable provider is reported with a fix", async () => {
    await writeFile(
      envFile,
      "LLM_BASE_URL=http://localhost:11434/v1\nLLM_API_KEY=ollama\nHOTPATH_AGENT_MODEL=a\nHOTPATH_CHEAP_MODEL=qwen3:1.7b\n",
    );
    const missing = await runDoctor({
      envFile,
      ...dirs(),
      env: {},
      listModels: async () => ["a"],
      agentOptions: agentOptions(),
    });
    expect(formatDoctor(missing)).toMatch(
      /does not list qwen3:1\.7b\n {2}→ ollama pull qwen3:1\.7b/,
    );
    const down = await runDoctor({
      envFile,
      ...dirs(),
      env: {},
      listModels: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      agentOptions: agentOptions(),
    });
    expect(formatDoctor(down)).toMatch(
      /✗ Provider\s+no answer from http:\/\/localhost:11434\/v1: connect ECONNREFUSED/,
    );
    expect(down.next).toMatch(/ollama serve/);
  });

  it("old Node and replay thinking are flagged", async () => {
    const result = await runDoctor({
      envFile,
      ...dirs(),
      env: { HOTPATH_CHEAP_REASONING: "high" },
      nodeVersion: "20.11.0",
      offline: true,
      agentOptions: agentOptions(),
    });
    expect(result.checks.find((c) => c.name === "Node")?.status).toBe("fail");
    expect(result.checks.find((c) => c.name === "Thinking")?.status).toBe(
      "warn",
    );
  });

  it("with compiled workflows: suggests a test run", async () => {
    await writeFile(
      envFile,
      "LLM_BASE_URL=u\nLLM_API_KEY=k\nHOTPATH_AGENT_MODEL=a\nHOTPATH_CHEAP_MODEL=c\n",
    );
    await mkdir(dirs().workflowsDir, { recursive: true });
    await writeFile(path.join(dirs().workflowsDir, "morning-brief.json"), "{}");
    await writeFile(
      path.join(dirs().workflowsDir, "morning-brief.2026.bak.json"),
      "{}",
    );
    const result = await runDoctor({
      envFile,
      ...dirs(),
      env: {},
      offline: true,
      agentOptions: agentOptions(),
    });
    expect(result.next).toBe("hotpath run morning-brief --dry-run");
    expect(formatDoctor(result)).toMatch(/1 compiled \(morning-brief\)/);
  });
});
