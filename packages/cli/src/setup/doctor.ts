import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { openAgentConfig, type ConfigOptions } from "../wrap/agents.js";
import { AGENTS, isWrapped } from "../wrap/entry.js";
import { parseEnv } from "./env-file.js";

export type Status = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  status: Status;
  detail: string;
  /** what to do about a warn or fail */
  fix?: string;
}

export interface DoctorOptions {
  envFile: string;
  workflowsDir: string;
  tracesDir: string;
  /** process.env after .env was loaded */
  env: NodeJS.ProcessEnv;
  nodeVersion?: string;
  /** asks the provider for its models; skipped when offline */
  listModels?: () => Promise<string[]>;
  offline?: boolean;
  /** where agent configs are looked up (tests) */
  agentOptions?: ConfigOptions;
}

export interface DoctorResult {
  checks: Check[];
  /** the one thing to do next */
  next: string;
}

const MIN_NODE = 22;

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

async function count(
  dir: string,
  filter: (name: string) => boolean,
): Promise<string[]> {
  try {
    return (await readdir(dir)).filter(filter);
  } catch {
    return [];
  }
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const checks: Check[] = [];
  const env = options.env;

  const major = Number(
    (options.nodeVersion ?? process.versions.node).split(".")[0],
  );
  checks.push(
    major >= MIN_NODE
      ? {
          name: "Node",
          status: "ok",
          detail: `v${options.nodeVersion ?? process.versions.node}`,
        }
      : {
          name: "Node",
          status: "fail",
          detail: `v${options.nodeVersion ?? process.versions.node}`,
          fix: `install Node ${MIN_NODE} or newer (nodejs.org)`,
        },
  );

  const hasEnvFile = await exists(options.envFile);
  const fileEnv = hasEnvFile
    ? parseEnv(await readFile(options.envFile, "utf8"))
    : {};
  const key = env.LLM_API_KEY ?? env.MOONSHOT_API_KEY ?? fileEnv.LLM_API_KEY;
  const baseUrl = env.LLM_BASE_URL ?? fileEnv.LLM_BASE_URL;
  const cheap = env.HOTPATH_CHEAP_MODEL ?? fileEnv.HOTPATH_CHEAP_MODEL;
  const agent = env.HOTPATH_AGENT_MODEL ?? fileEnv.HOTPATH_AGENT_MODEL;
  checks.push(
    key && baseUrl
      ? {
          name: "Settings",
          status: "ok",
          detail: `${hasEnvFile ? options.envFile : "environment"} · ${baseUrl} · key set (not shown)`,
        }
      : {
          name: "Settings",
          status: "fail",
          detail: !hasEnvFile
            ? "no .env file"
            : !baseUrl
              ? "LLM_BASE_URL is not set"
              : "LLM_API_KEY is not set",
          fix: "run hotpath init",
        },
  );
  checks.push(
    agent && cheap
      ? {
          name: "Models",
          status: "ok",
          detail: `agent ${agent} · replay ${cheap}`,
        }
      : {
          name: "Models",
          status: "fail",
          detail: "HOTPATH_AGENT_MODEL or HOTPATH_CHEAP_MODEL is not set",
          fix: "run hotpath init",
        },
  );

  if (options.offline || !options.listModels) {
    checks.push({
      name: "Provider",
      status: "warn",
      detail: "not checked (--offline)",
    });
  } else if (key && baseUrl) {
    try {
      const ids = await options.listModels();
      const missing = [agent, cheap].filter(
        (m): m is string => !!m && ids.length > 0 && !ids.includes(m),
      );
      checks.push(
        missing.length === 0
          ? {
              name: "Provider",
              status: "ok",
              detail: `answered, ${ids.length} models listed`,
            }
          : {
              name: "Provider",
              status: "warn",
              detail: `answered, but does not list ${missing.join(" and ")}`,
              fix: baseUrl.includes("11434")
                ? `ollama pull ${missing[0]}`
                : "check the exact model id on your provider and run hotpath init again",
            },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      checks.push({
        name: "Provider",
        status: "fail",
        detail: `no answer from ${baseUrl}: ${msg.slice(0, 120)}`,
        fix: baseUrl.includes("11434")
          ? "start Ollama (ollama serve) or check the port"
          : "check the URL and the key (hotpath init)",
      });
    }
  }

  if (
    env.HOTPATH_CHEAP_REASONING &&
    !["none", ""].includes(env.HOTPATH_CHEAP_REASONING.toLowerCase())
  ) {
    checks.push({
      name: "Thinking",
      status: "warn",
      detail: `HOTPATH_CHEAP_REASONING=${env.HOTPATH_CHEAP_REASONING}: replay steps think before answering`,
      fix: "remove it unless you measured a gain: thinking made replays 4-14x slower (docs/BENCHMARK.md)",
    });
  }

  // agents and their MCP servers
  let wrappedTotal = 0;
  const found: string[] = [];
  for (const name of AGENTS) {
    try {
      const config = await openAgentConfig(name, "", {
        openclaw: false,
        ...options.agentOptions,
      });
      const servers = config.names();
      const wrapped = servers.filter((s) => {
        const e = config.get(s);
        return e ? isWrapped(e) : false;
      });
      wrappedTotal += wrapped.length;
      found.push(
        `${name} (${servers.length} server${servers.length === 1 ? "" : "s"}${wrapped.length ? `, recording: ${wrapped.join(", ")}` : ""})`,
      );
    } catch {
      // not installed or no MCP config: fine
    }
  }
  checks.push(
    found.length
      ? { name: "Agents", status: "ok", detail: found.join(" · ") }
      : {
          name: "Agents",
          status: "warn",
          detail:
            "no agent MCP config found (Claude Code, Cursor, Claude Desktop, VS Code, OpenClaw)",
          fix: "use hotpath record -- <server command> by hand (README: Use it with your own agent)",
        },
  );

  const traces = await count(options.tracesDir, () => true);
  const workflows = await count(
    options.workflowsDir,
    (f) => f.endsWith(".json") && !f.includes(".bak."),
  );
  checks.push({
    name: "Your tasks",
    status: "ok",
    detail: `${traces.length} recorded · ${workflows.length} compiled${
      workflows.length
        ? ` (${workflows
            .map((w) => path.basename(w, ".json"))
            .slice(0, 5)
            .join(", ")})`
        : ""
    }`,
  });

  const firstProblem = checks.find((c) => c.status === "fail");
  let next: string;
  if (firstProblem) next = firstProblem.fix ?? `fix: ${firstProblem.name}`;
  else if (workflows.length > 0)
    next = `hotpath run ${path.basename(workflows[0]!, ".json")} --dry-run`;
  else if (traces.length > 0) next = `hotpath compile ${traces[0]}`;
  else if (wrappedTotal > 0)
    next = "do the task once in your agent, then: hotpath compile <task>";
  else
    next =
      "hotpath wrap <agent> <server> --task <name>   (see the servers above)";
  return { checks, next };
}

export function formatDoctor(result: DoctorResult): string {
  const mark = { ok: "✓", warn: "!", fail: "✗" } as const;
  const lines = result.checks.map((c) => {
    const head = `${mark[c.status]} ${c.name.padEnd(11)} ${c.detail}`;
    return c.fix && c.status !== "ok" ? `${head}\n  → ${c.fix}` : head;
  });
  return [...lines, "", `Next: ${result.next}`].join("\n");
}
