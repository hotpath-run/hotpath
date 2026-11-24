# Changelog

All notable changes. Versions follow [semantic versioning](https://semver.org); before 1.0 a minor version may change behaviour, and the change is listed here.

## 0.4.0

Replays you can trust: a workflow now says when it is not sure instead of acting wrong, and works out more of its figures and decisions with code. Measured on a new benchmark of 11 real-world workflows, each recorded once and replayed on 4 new days (a normal day, another, a big day, an empty day): with a free model as both agent and replay model, replays went from 21/44 right with 16 silently wrong to **43/44 right with none silently wrong**; with Claude (Sonnet records, Haiku replays) 24/24 on the 6 workflows tried.

- **Check a recording before it goes live.** `hotpath compile` shows what the recorded run did (its actions, its message, its per-item decisions) and asks "is this right?". An unconfirmed workflow does not replay on its own: `hotpath confirm <task>` later, or `--yes` in CI. A wrong recording is otherwise replayed wrong every day.
- **Half-done recordings are refused.** When the agent stopped (an error, a time-out) before its first action, compile says what went wrong instead of saving a workflow that does nothing. `--read-only` for tasks that only read.
- **Per-item decisions are asked twice**, the second time with the items in reverse order. Any answer that differs goes to your agent before anything is done. `HOTPATH_DECIDE_TWICE=0` asks once.
- **Decisions by code when the recording shows the rule.** A choice that follows one number in bands (a lead's tier from its company's size) or a small rulebook (a ticket's category, then its priority or an amount: "refund up to 50, forward above") is learned from the recorded items and made by code, with no model call. An item between two recorded bands (no evidence for either side) goes to your agent, whose recording closes the gap; a value never seen (a new category) is asked of the model.
- **Report figures by code.** Totals per group (per region, per service, per vendor), filtered sums ("paid orders only", "due before today"), counts of lines holding a word, the top item, the most frequent message and counts per decided value are computed on each day's data; the model writes around them and the text must state them. Money keeps its cents.
- **Number rules from two recordings.** Record a calm and an alert day: "page only if the error rate is above 2" is learned from the agent's own words.
- **Cursor pages** (`next_cursor`, `next_token`) are followed like page numbers; a page read past the last one no longer splits a loop.
- **Replay cost guard.** Long lists the code fully accounts for (a day of log lines) are no longer sent to the model: on the benchmark's log report a replay went from $0.024 to $0.0016. A step whose data is over 3× the recording's prints a warning. `HOTPATH_TRIM=0` sends everything.
- **Safer loops.** A list longer than a loop's `maxItems` now goes to your agent instead of being silently cut short.
- **Fixed:** a link followed by full-width punctuation was read as a planted link; a threshold the agent wrote ("mid 100–999") was taken for a copied fact.

## 0.3.1

Replays are more reliable and safer. Found by a new fuzzer (generated workflows replayed on changed data) and by a support-bot test with 100 customers.

- **A step never runs with a missing value.** If today's data lacks something a step needs (item 2 on a day with one item, an empty field), the run stops before calling the tool instead of calling it with the value left out.
- **Workflows learned from several recordings are right on all of them.** A message that differs between recordings is written at run time, not frozen to one recording's text; a list read item by item becomes a loop even when one day had a single item; an action some recordings made and others didn't becomes a condition; data checks are learned from every recorded result.
- **Fewer needless fallbacks.** A field nothing in the workflow reads may be empty or change type; a field read only by a conditional step may be empty; values the run's own tool calls were made with count as today's data.
- **Different inputs, different paths.** When recordings differ in which input they had (an order number or an email), the workflow branches on the input instead of asking the model before any data has arrived. Inputs not every recording had are optional.
- **Replies fit the request.** The replay model sees the request (free-text inputs) after the recorded example and answers in the request's language; a saved answer is only reused for the same request. For lists with dates, the newest item is given as a fact.
- **Rate limits:** when a provider's "too many requests" answer has no readable wait time, retries now cover a full minute instead of giving up after about 20 seconds.

## 0.3.0

- **A free hotpath.run account is now required.** `hotpath login` (device flow: it shows a code and opens your browser), `hotpath logout` and `hotpath whoami`. Every other command asks you to sign in first; `--help`, `--version` and the internal `demo-tools` do not. For CI, set `HOTPATH_TOKEN`. The sign-in is kept in your settings folder (`%APPDATA%\hotpath` on Windows, `~/.config/hotpath` elsewhere), checked online at most once a day, and works offline for up to 7 days.
- **Run summaries sync to your dashboard** after `run`, `demo`, `learn` and `compile`, in the background (it never slows or fails the command; what cannot be sent waits in `.hotpath/sync-queue.json`). Only summaries are sent: workflow names, step counts, a graph of tool names and step kinds, and per run the time, cost, model calls and fallback. Never arguments, results, prompts, model output, inputs, paths or `.env` values. `HOTPATH_NO_SYNC=1` turns it off.

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
