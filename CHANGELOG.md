# Changelog

All notable changes. Versions follow [semantic versioning](https://semver.org); before 1.0 a minor version may change behaviour, and the change is listed here.

## 0.2.2

- `hotpath demo-tools` (the demo's fake MCP server) now works when an MCP client such as Claude Code starts it on its own: it finds its bundled data, and what it "sends" goes to `out/messages.json` in your project folder. Before this, it only worked inside `hotpath demo`.
- README: "Try it in Claude Code", the demo with Claude Code as the agent.

## 0.2.1

- `hotpath init` no longer replaces a key that `.env` already has for another endpoint. With `--yes` it stops and changes nothing; in a terminal it asks first (Enter means no). When it does replace one, it first keeps a copy of the old file as `.env.backup-<date>`. `--force` replaces without asking, still with a copy. Before this, running `init` from a folder inside another project could overwrite that project's key.
- `hotpath scan <file-or-folder>`: a local savings estimate from traces you already have (OpenTelemetry GenAI spans, LangSmith or Langfuse exports). It shows which runs follow repeated paths, the potential hit rate and an estimated monthly saving. It sends nothing anywhere and never shows argument values. See `docs/SCAN.md`.

## 0.2.0

First open-source release (Apache-2.0).

- Packages are published under the `@hotpathrun` scope: `cli` (the `hotpath` command), `sdk`, `proxy`, `recorder`, `compiler`, `runtime`, `learn`, `scheduler`, `viewer`, `shared`. They were called `hotpath-*` before.
- `hotpath demo`: one command that records the bundled demo agent 3 times, learns the repeated path and replays it on new data.
- `hotpath learn`: finds the paths an agent repeats in your local traces and compiles the hot ones, with a shadow check before a path goes live.
- `hotpath proxy`: point an agent's model base URL at Hotpath (OpenAI and Anthropic APIs); conversations are recorded and repeated ones are served from compiled paths.
- Reliability of the replay: fewer false fallbacks; totals, counts, currency and time-zone conversions recomputed by code; drift noticed in 8 of 8 tested kinds of change.
