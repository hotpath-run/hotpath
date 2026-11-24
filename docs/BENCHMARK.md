# Benchmark

`pnpm bench` runs the end-to-end loop against a real LLM for each demo task and checks
that the compiled workflow matches the agent's behavior, generalizes to new data and
recovers from drift. This page holds the full results, how to read them, and the
limitations of the measurements.

## Setup

- **Date:** 2026-10-01
- **Code:** commit `f914cb4` for the table below (grounding guard, recompile safety check
  and honest timings included); the second run in the pass-rate table used `87dd5f0`,
  which only adds the rate-limit wait cap and setup-failure handling to the bench
- **Provider:** Groq (OpenAI-compatible API)
- **Agent model:** `qwen/qwen3.8-27b`
- **Cheap model (workflow `llm` steps):** `openai/gpt-oss-20b` with
  `HOTPATH_CHEAP_REASONING=low`
- **Tasks:** `morning-brief` (4 tool calls, 1 LLM step) and `weekly-report` (13 tool
  calls, 2 LLM steps, data passed between steps)

The agent model was changed from `openai/gpt-oss-120b` to `qwen/qwen3.8-27b` because the
account's daily token limit for the former was exhausted before the benchmark finished.

## Results

Output of one complete run, unedited:

```
scenario                 agent time / cost                        hotpath time / cost                             startup + tools + llm  speedup  cheaper  match  fallback
morning-brief/same-data  3.7s / $0.0206                           0.9s / $0.0021                                  224ms + 37ms + 612ms   4x       10x      ✅      no
morning-brief/new-data   3.3s / $0.0175 (+15.0s rate-limit wait)  1.0s / $0.0018                                  241ms + 37ms + 746ms   3x       10x      ✅      no
morning-brief/drift      -                                        4.4s / $0.0175 (+28.0s rate-limit wait) → 0.7s  216ms + 39ms + 416ms   -        -        ✅      yes → recompiled
weekly-report/same-data  6.7s / $0.0503 (+61.0s rate-limit wait)  1.6s / $0.0039                                  219ms + 54ms + 1.3s    4x       13x      ✅      no
weekly-report/new-data   6.7s / $0.0438 (+74.0s rate-limit wait)  1.3s / $0.0038                                  216ms + 54ms + 986ms   5x       12x      ✅      no
weekly-report/drift      -                                        7.6s / $0.0499 (+54.0s rate-limit wait) → 1.1s  222ms + 55ms + 781ms   -        -        ✅      yes → recompiled
```

## Scenarios

| Scenario      | What it checks                                                                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **same-data** | The workflow, run on the data it was recorded on, makes the same tool calls as the recorded trace (ignoring LLM-written text), mentions every expected item, and does not fall back.                                                                                                  |
| **new-data**  | The same workflow on different data (other emails, other repositories and incident) mentions every expected item with no agent involved and no recompilation. The agent also runs once on this data, only to provide a time and cost comparison.                                      |
| **drift**     | A field is renamed in the tool output (`subject` → `title` for morning-brief, repository `name` → `slug` for weekly-report). The guard must catch it at step `s1`, the agent runs once, the workflow is recompiled, and a second run passes with no fallback and every expected item. |

Expected items are listed per fixture set in `examples/demo-tools/fixtures/`
(`expected.json`, `weekly-report.expected.json`). Matching ignores case and folds
typographic variants (non-breaking hyphens, curly quotes, narrow spaces); a missing item
still fails the scenario.

## Reading the table

- **agent time / cost** — the comparison agent run (setup run for same-data, a run on the
  new data for new-data). Not shown for drift, where the fallback run is the comparison.
- **hotpath time / cost** — the workflow run. For drift, the first figure is the fallback
  run including the agent, and the time after the arrow is the following clean run.
- **startup + tools + llm** — where the workflow's time goes: starting and connecting to
  the MCP server, all deterministic tool steps together, and the LLM steps. For drift it
  shows the clean run.
- **(+N s rate-limit wait)** — time spent sleeping between retries after the provider
  answered HTTP 429. It is measured by the client (`rateLimitWaitMs`), included in the
  wall-clock duration, and **excluded from the time shown** next to it.
- **speedup** — agent time ÷ hotpath time, both without rate-limit waits.
- **cheaper** — agent cost ÷ hotpath cost.
- **match** — the scenario's checks all passed.

## Notes and limitations

### Rate-limit waiting

The provider's free tier limits tokens per minute. When a limit is hit the client waits
and retries; that waiting is real elapsed time but says nothing about the model or the
workflow, so it is reported separately. In this run it reached 74 s on a single agent
run. Without it, the agent took about 3–4 s for `morning-brief` and about 6.7 s for
`weekly-report`, and the workflow is roughly 3–5x faster. Figures that included the
waiting (as in earlier runs) overstated the speedup, in some cases by an order of
magnitude.

A retry-after of more than about 65 s is treated as a quota (for example a daily token
limit) and fails immediately instead of waiting.

### Where the workflow's time goes

Starting and connecting to the MCP server takes about 220 ms. The deterministic tool
steps take 37–55 ms in total for 4 and 13 tool calls respectively. The remaining time is
the cheap model's response. With the model call being the only part that varies, speedups
depend mostly on how fast the agent model is on the provider used.

### Costs

Costs are computed from the per-token prices configured in `.env` (`PRICE_*`), not from
the provider's invoice. The run used the defaults from `.env.example` (agent $3 / $15,
cheap $0.95 / $4 per million input / output tokens), which are placeholders and not the
provider's actual prices. The "cheaper" ratio is therefore only as meaningful as those
prices.

### Sample size and nondeterminism

Each figure is a single run on small fake tasks. The LLM parts are not deterministic, so
individual scenarios have occasionally failed in development when the cheap model left an
item out of its output. The grounding guard was added to catch this: the compiler records
which values from earlier results the example output mentions, and at run time the output
must mention what the same fields hold now. If items are missing, the step is retried
once with the missing items listed, and if they are still missing the guard fails.

## Pass rates

`pnpm bench --runs N` repeats the whole benchmark N times and prints per-scenario pass
rates. Two complete runs were possible on the final code, with the same models on the
same day:

| Scenario                | Passed |
| ----------------------- | ------ |
| morning-brief/same-data | 2/2    |
| morning-brief/new-data  | 2/2    |
| morning-brief/drift     | 2/2    |
| weekly-report/same-data | 2/2    |
| weekly-report/new-data  | 2/2    |
| weekly-report/drift     | 1/1    |

This is a very small sample and not a statistical result. A third run was intended but
could not be completed:

- In the second run, the `weekly-report/drift` agent call was refused by the provider's
  daily token limit (200,000 tokens per day on the account used). A full benchmark spends
  roughly 85,000 agent tokens, so the limit ended the series. That scenario is excluded
  (1/1) and counted as neither a pass nor a failure.
- Earlier runs on the same day used code from before the grounding guard and the
  recompile check, and some missed an item in the output. They are not included.
- Runs that failed during setup because of the token limit are infrastructure failures
  and are not reported as pass rates.

To produce pass rates, run `pnpm bench --runs 3` with an agent model that is not rate
limited, or after the limit resets. `--skip-agent-reruns` skips the comparison agent run
in runs 2..N to save tokens, and `--task <name>` runs a single task. Results, including
per-run details, are written to `bench/results.json`.

## Reproducing

```bash
pnpm install
pnpm -r build
cp .env.example .env   # set LLM_API_KEY, LLM_BASE_URL and the model names
pnpm bench             # both tasks; add --runs 3 for pass rates
```

A full run makes real API calls and takes a few minutes; agent runs dominate the time and
the token use.

## Local open models (Ollama)

Measured on 2026-11-14 on one PC: NVIDIA RTX 2060 (6 GB), Ollama 0.40, models
`qwen3:1.7b`, `qwen3.5:4b` and `qwen2.5-coder:7b` (Q4_K_M). Local runs cost $0, so the
table's cost columns read `$0.0000`; the token counts behind the cost estimates below
are written by the bench to `out/bench-tokens.jsonl` and priced with
`pnpm bench:price`.

### Before the small-model fixes

`morning-brief`, qwen3:1.7b as agent and writer, code as of `0d5ff0c`: **0 of 3
scenarios passed.** The agent read emails, calendar and weather, then wrote the brief as
a chat reply instead of calling `send_message`; the compiler turned that into a 3-step
workflow that read data and sent nothing. `qwen2.5-coder:7b` as agent made **no tool
call at all**: it wrote its calls as JSON text (`{"name": "get_emails", …}`), several in
one reply, including a `send_message` with placeholder text before reading anything.

What changed, all with tests: tool calls written as text are recovered (bare JSON,
several objects, ```json fences, `<tool_call>` tags); leaked `<think>` blocks are
stripped; the demo agent is told to act when it answers in text before any action tool;
actions planned in the same turn as reads are held until the reads return; `compile`
warns when a recording never used an action tool; a fallback recompile that lost an
action or AI step no longer replaces the workflow; list fields mentioned for most items
are required for every item (`emails.*.subject`); opt-in `HOTPATH_REPAIR_MENTIONS=1`
appends values the writer still left out; `HOTPATH_CHEAP_REASONING=none` turns Ollama
thinking off.

### After (final code, `HOTPATH_REPAIR_MENTIONS=1`)

| Config | Agent            | Writer                   | Task × runs      | same-data | new-data | drift |
| ------ | ---------------- | ------------------------ | ---------------- | --------- | -------- | ----- |
| F1     | qwen3:1.7b       | qwen3:1.7b, thinking on  | morning-brief ×3 | 2/3       | 3/3      | 2/3   |
| F2     | qwen3:1.7b       | qwen3:1.7b, thinking off | morning-brief ×3 | 2/3       | 2/3      | 2/3   |
| F3     | qwen3:1.7b       | qwen3:1.7b, thinking off | inbox-digest ×2  | 1/2       | 2/2      | 0/2   |
| F4     | qwen3:1.7b       | qwen3:1.7b, thinking off | weekly-report ×2 | 0/2       | 0/2      | 0/2   |
| F5     | qwen2.5-coder:7b | qwen3:1.7b, thinking off | morning-brief ×2 | 1/2       | 1/2      | 0/2   |

Unedited rows from F2 (run 1) and F3 (run 1):

```
morning-brief/same-data  9.4s / $0.0000     1.2s / $0.0000          246ms + 34ms + 897ms   8x       -        ✅      no
morning-brief/new-data   9.2s / $0.0000     2.1s / $0.0000          244ms + 33ms + 1.8s    4x       -        ✅      no
morning-brief/drift      -                  12.5s / $0.0000 → 1.2s  246ms + 34ms + 940ms   -        -        ✅      yes → recompiled
inbox-digest/same-data  11.4s / $0.0000    2.1s / $0.0000           244ms + 36ms + 1.8s    5x       -        ✅      no
inbox-digest/new-data   13.3s / $0.0000    2.1s / $0.0000           266ms + 38ms + 1.8s    6x       -        ✅      no
```

- **Speed:** with the writer's thinking off, replays took 0.7–2.1 s against 9–13 s for
  the agent (4–19×). With thinking on, the 1.7B writer took 3–31 s, often slower than the
  agent: keep thinking off (or effort low) for replay.
- **What still fails:** when the recording agent's own message leaves a whole category
  out (no email subject at all), nothing tells the compiler that category matters, so
  repair has nothing to add. `weekly-report` (13 tool calls) is beyond what the 1.7B agent
  records reliably. Recording with `qwen2.5-coder:7b` (F5) did not help: it paraphrases
  values ("Q3 budget review (14:00)"), which the compiler cannot match.
- The new recompile safety fired as intended in F3 and in a qwen3.5:4b run: the fallback
  agent skipped `get_email` (or `send_message` and the AI step) and the old workflow was
  kept.

### What these runs would cost on paid APIs

The same runs' token counts priced at paid rates (`pnpm bench:price --per-day 1000
<logs>`), passing F2 and F3 runs only (7 runs), 1,000 runs a day for 30 days:

| Agent → replay model                        | Agent / run | Hotpath / run | Agent / month | Hotpath / month | Cheaper |
| ------------------------------------------- | ----------- | ------------- | ------------- | --------------- | ------- |
| Claude Sonnet 5.5 → Sonnet 5.5 (same model) | $0.02499    | $0.00331      | $750          | $99             | 8×      |
| Claude Sonnet 5.5 → Haiku 5.5               | $0.02499    | $0.00017      | $750          | $4.96           | 151×    |
| Claude Opus 5.5 → Haiku 5.5                 | $0.04997    | $0.00017      | $1,499        | $4.96           | 302×    |
| DeepSeek V4 Pro → V4.1 Flash (peak)         | $0.01164    | $0.00044      | $349          | $13             | 26×     |
| OpenAI GPT-6 Astra → GPT-6 Luna             | $0.12493    | $0.00017      | $3,748        | $4.96           | 755×    |

Prices per 1M tokens: Claude from Anthropic's price table (2026-11-03); DeepSeek and
OpenAI from third-party price trackers (2026-11), not the official pages. Check them
before quoting.

How to read it:

- **The same-model row is the structural saving** (8×): the agent re-reads its growing
  conversation on every turn (4–5 calls, ~3,200 input and 1,500–2,300 output tokens per
  run here), the replay makes 1–2 short calls (~640–850 input, ~190 output). It matches
  the 10–13× measured on a real paid API above.
- The larger rows also switch the replay to a cheaper model, which the workflow allows
  because the model only writes text from data in front of it.
- **With a thinking writer the saving disappears**: F1's replays averaged 2,720 output
  tokens, so Sonnet → Sonnet came out _more_ expensive than the agent ($868 vs $590 a
  month). Use a non-thinking or low-effort model for replay.
- These are estimates: the tokens come from Qwen models and Qwen's tokenizer. A stronger
  paid agent may need fewer turns or tokens. The proof is a run on the paid API itself.

## Recorded in Claude Code, replayed locally (2026-11-14)

Claude Code (Opus 5.5) did `morning-brief` once through `hotpath record` as an MCP
server (4 tool calls). The trace compiled into 5 steps; the replays used qwen3:1.7b
(`HOTPATH_CHEAP_REASONING=none`, `HOTPATH_REPAIR_MENTIONS=1`) on an RTX 2060.

| Code                                                    | same data      | new data                        | drift        |
| ------------------------------------------------------- | -------------- | ------------------------------- | ------------ |
| Before the stale-fact guard                             | 3/3            | 3/3 passed the guard, but wrong | caught at s1 |
| Stale-fact guard, retry still shows the example         | 3/3            | 1/5 (drift)                     | —            |
| Final: stale-fact guard, retries never show the example | 3/3, 1.6–1.8 s | 8/8, 2.3–3.1 s                  | caught at s1 |

- **What was wrong before:** on new data the brief still said "11–21°C" (the new day
  was 9–17°C) and kept the recording's "budget review clashes with your 14:00 Dentist
  appointment". The grounding guard only checked that today's facts were present.
- **The guard:** the compiler keeps every value the example took from the data
  (`guard.exampleFacts`); the runtime fails an output that repeats one that is no
  longer anywhere in the run's data or inputs. Number ranges written with an en dash
  ("11–21") now count as mentioning both numbers.
- **Two measured traps:** naming the copied facts in the retry ("remove: Dentist
  appointment") made the 1.7B model write them again; and a retry that still showed the
  example copied from it even when the first answer had only left something out.
- **Cost of the fix:** facts are right, style is rougher. Without the example the 1.7B
  model sometimes adds a preamble ("Here is the complete text…") and repair appends the
  items it still left out. Every new-data run took the retry (2 LLM calls).
- Claude Code keeps an MCP server running for the whole session, so the recorder never
  writes the trace's end line; the trace was closed by hand for this test. Fixed since:
  the recorder starts a new trace after a quiet gap (`HOTPATH_SPLIT_IDLE_MS`, default
  10 minutes), and `compile` reads a trace that is still open (with a warning). The
  same open trace then compiled to the same 5 steps with no hand edit.

### Same workflow, a large replay model (2026-11-15)

The same compiled workflow, unchanged, replayed with
`nvidia/nemotron-3-ultra-550b-a55b:free` on OpenRouter's free tier
(`HOTPATH_REPAIR_MENTIONS=1`). Both free Gemma 4 models returned 429 from their
provider and were not measured.

| Replay model            | same data  | new data       | drift        | LLM calls per run |
| ----------------------- | ---------- | -------------- | ------------ | ----------------- |
| qwen3:1.7b (local)      | 3/3, ~2 s  | 8/8, 2.3–3.1 s | caught at s1 | 2 on new data     |
| Nemotron 3 Ultra (550B) | 1/1, 7.6 s | 4/4, 25–88 s   | caught at s1 | 1                 |

- **Style:** the large model kept the recording's format on new data (title, weather,
  calendar, emails, a closing line) with no preamble, and passed the stale-fact guard
  on the first answer, so it never needed the retry. On same data it also kept the
  recording's "budget review clashes with the 14:00 Dentist appointment" heads-up,
  which is correct for that day.
- **Speed:** almost all of the time is the free tier's queue and the model's
  reasoning; the tool steps took 38–45 ms. A paid endpoint would be much faster.
- **Cost:** $0 on the free tier. At the paid price ($0.60 / $2.40 per million
  tokens in / out on 2026-11-15) the same-data replay (544 + 495 tokens) would cost
  about $0.0015. Opus 5.5 took 27 s to do the task in Claude Code; its cost could not
  be measured from inside Claude Code.
- One run on same data and four on new data: a sign, not a statistic.

### Without and with Hotpath: ERNIE 5.5 Flash (2026-11-15)

`pnpm bench` with `baidu/ernie-5.5-flash-preview:free` on OpenRouter as both the agent
and the replay model, so the only difference is Hotpath. "Without" is the agent doing
the task; "with" is the compiled workflow. One run each.

| Task / scenario          | Without Hotpath (agent)            | With Hotpath (workflow)            | Result              |
| ------------------------ | ---------------------------------- | ---------------------------------- | ------------------- |
| morning-brief, same data | 6.1 s, 3 calls, 2.6k in + 0.7k out | 8.1 s, 1 call, 0.6k in + 2.2k out  | correct, slower     |
| morning-brief, new data  | 5.4 s, 3 calls, 2.5k in + 0.6k out | 13.0 s, 1 call, 0.6k in + 4.3k out | correct, slower     |
| morning-brief, drift     | —                                  | caught, agent re-ran, recompiled   | correct             |
| weekly-report, same data | 9.9 s, 5 calls, 8.1k in + 1.3k out | 138 s, 3 calls, 2.5k in + 41k out  | correct, 14x slower |
| weekly-report, new data  | 9.1 s, 5 calls, 8.4k in + 1.3k out | 128 s, 3 calls, 2.4k in + 41k out  | correct, 14x slower |
| weekly-report, drift     | —                                  | caught, agent re-ran, recompiled   | correct             |

- **Hotpath lost on this model.** Every answer was right and drift was always
  caught, but the replay was slower and used more tokens than the agent. Hotpath
  cut input tokens by about 70%, but ERNIE spent 2k–41k tokens thinking on the replay
  call, against about 1k in the agent's whole run.
- **ERNIE's reasoning can't be turned off:** OpenRouter answers `reasoning: {enabled:
false}` with "Reasoning is mandatory for this endpoint", and `reasoning_effort`
  `none` or `low` changed nothing (a morning-brief rerun with `none` used 6–7k tokens).
- **Likely cause, not yet tested:** the replay prompt asks for "about N characters"
  and shows the whole recorded example, which a reasoning model may try to match
  exactly. The agent gets only the task. Testing a shorter replay instruction was
  stopped by the free tier's 50-requests-a-day limit.
- On the same day, Nemotron 3 Ultra (above) and qwen3:1.7b without thinking replayed
  the same workflows quickly. Hotpath wins when the replay call is short; a model that
  always thinks long erases that.

### The fix: no character count, and a token cap (2026-11-15)

ERNIE's free quota was used up, so the fix was measured on local qwen3:1.7b with
thinking **on** (`HOTPATH_CHEAP_REASONING` unset), which also reasons before
answering. Same workflows, `HOTPATH_REPAIR_MENTIONS=1`. Thinking + answer tokens per
replay, mean of the runs:

| Scenario            | Old prompt               | New prompt                    |
| ------------------- | ------------------------ | ----------------------------- |
| morning-brief, same | 1,740 tokens, 15 s (n=2) | **805 tokens, 5.8 s** (n=8)   |
| morning-brief, new  | 1,990 tokens, 16 s (n=2) | 2,030 tokens, 14 s (n=8)      |
| weekly-report, same | 2,817 tokens, 23 s (n=1) | 3,150 tokens, 25 s (n=3)      |
| weekly-report, new  | 3,559 tokens, 28 s (n=1) | 4,770 tokens, 31 s (2 of n=3) |

- **What changed:** the prompt no longer asks for "about 3159 characters" (a
  reasoning model counts towards it while thinking); it asks to match the example
  "roughly", and a retry asks for "about N lines". Every prompt ends with "Reply with
  the text only: no introduction, no code fences" (ERNIE had wrapped a brief in a
  code fence).
- **Result:** same-data replays think less than half as much and run 2.6x faster.
  New-data replays did not change: there the model spends its thinking on which
  facts are today's. The weekly-report differences are within the run-to-run noise.
  Every run passed except one runaway, below.
- **Runaways are now capped.** One weekly-report new-data run thought for 42,677
  tokens (5.6 minutes) and returned nothing. Each llm-step call now sends
  `max_tokens` (`HOTPATH_CHEAP_MAX_TOKENS`, default 16,000, `0` for no cap), so the
  worst case stops at the cap and drifts to the agent with a clear reason.
  Normal replays stayed under 15k on every model tried, including ERNIE.
- **Tried and dropped:** hiding the example's facts as "[…]" (so the model can't
  copy them) made it worse: more retries, more thinking, and one 170,288-character
  answer.
- **Not yet re-measured on ERNIE** (quota). The cap bounds its worst case. Whether
  the prompt change helps it as much as it helps qwen on same data is still open.

### Thinking off by default, and no model call when the data is unchanged (2026-11-15)

Same local setup: qwen3:1.7b replaying both demo workflows, every run checked by
the guards. Reuse was off for the thinking columns so the model was always asked.

| Replay              | Thinking on (`HOTPATH_CHEAP_REASONING=default`) | Thinking off (new default) | Data unchanged (answer reuse) |
| ------------------- | ----------------------------------------------- | -------------------------- | ----------------------------- |
| morning-brief, same | 693–960 tokens, 6.9–13.9 s (n=3)                | 215 tokens, 3.3–3.9 s      | 0 calls, 0.4 s total          |
| morning-brief, new  | 1,485–1,726 tokens, 21–25 s (n=3)               | 186 tokens, 2.9–3.4 s      | 0 calls, 0.4 s (second run)   |
| weekly-report, same | 2,934–3,553 tokens, 38–55 s (n=2)               | 543–561 tokens, 6.8–10.5 s | 0 calls, 0.4–0.6 s            |
| weekly-report, new  | 5,655–8,393 tokens, 87–134 s (n=2)              | 571–625 tokens, 8.6–9.9 s  | 0 calls, 0.5 s (second run)   |

Every run passed. Thinking-on times vary a lot between batches (this batch ran
slower than the one above); the token counts are the steadier measure.

- **Thinking is off unless asked for.** `HOTPATH_CHEAP_REASONING` now defaults to
  `none`. A replay step rewrites known data in a known format, the guards check the
  answer either way, and thinking made it 4–14x slower here without a single extra
  pass. `default` sends nothing (the provider decides); `low`/`medium`/`high` still
  work. A provider that rejects the parameter gets the request again without it,
  and that model is remembered, so there is one failed round trip per process, not
  per call.
- **Answer reuse.** An llm step's question is its recorded example plus the data
  it is given (`answerKey`, a SHA-256). The compiler stores the key of the recorded
  run (`inputKey`), so a replay on the recorded data uses the agent's own answer;
  every answer the replay model gives is kept in `.hotpath/answers/<task>.json`
  (last 50). Same key, same answer, no model call. A recompile changes the example
  and so every key. `HOTPATH_REUSE=0` turns it off.
- **What it does not fix:** a model whose reasoning cannot be turned off (ERNIE 5.5
  Flash: "Reasoning is mandatory") still thinks on new data. Reuse helps it on
  reruns and unchanged data; the token cap bounds its worst case. For a replay
  model, pick one that can answer without thinking. Not yet measured on ERNIE
  (free quota used up).

### Without and with Hotpath on today's code, on a laptop (2026-11-15)

`pnpm bench` with qwen3:1.7b as both the agent and the replay model on the same RTX
2060 (Ollama, `HOTPATH_REPAIR_MENTIONS=1`, thinking off for replays by default), code
as of `32ffb57`. "Agent" is the agent doing the task; "Hotpath" is the compiled
workflow on the same machine.

| Task          | Runs | Agent      | Hotpath, same data | Hotpath, new data | Faster | Passed (same / new / drift) |
| ------------- | ---- | ---------- | ------------------ | ----------------- | ------ | --------------------------- |
| morning-brief | 3    | 9.6–13.5 s | 0.3–2.0 s          | 1.1–1.6 s         | 6–42×  | 2/3 · 2/3 · 2/3             |
| inbox-digest  | 1    | 9.2–11.6 s | 0.3 s              | 0.9 s             | 10–41× | 1/1 · 1/1 · 1/1             |

- **0.3 s runs** are answer reuse: on the recorded data the agent's own answer is used
  when it passes the guards, so no model is called.
- **Every failure came from the recording, not the replay:** the 1.7B agent's brief
  left emails out, and nothing tells the compiler a whole category it never saw matters.
  A stronger recording agent avoids this (Claude Code recordings passed 8/8 on new data,
  above).
- **Two faults this run found, both fixed with tests (`32ffb57`):** reuse used to copy
  a recording that had left items out (it must now pass the guards first), and the bench
  expected replays to repeat the agent's failed calls, which the compiler drops on
  purpose.
- A second inbox-digest run is not reported: it overlapped a code change.
- Costs are $0 locally; on paid APIs see "What these runs would cost" above.

### Recording quality: warnings, several recordings, and recording again (2026-11-15)

`pnpm bench --task morning-brief --runs 5`, qwen3:1.7b as the agent and the replay model
(Ollama on the RTX 2060, `HOTPATH_REPAIR_MENTIONS=1`, thinking off for replays). Each run
records afresh, so the agent's recording differs from run to run. Passed = scenario runs
that met every check, out of 5.

| Setup                                                              | Commit    | Same data | New data | Drift   |
| ------------------------------------------------------------------ | --------- | --------- | -------- | ------- |
| Before: one recording                                              | `ce742f1` | 5/5       | 4/5      | 4/5     |
| After: one recording, coverage warnings only                       | `7fff773` | 3/5       | 3/5      | 5/5     |
| After: two recordings (`--recordings 2`)                           | `7fff773` | 4/5       | 4/5      | 3/5     |
| After: refuse a warned recording and record again (`--rerecord 2`) | `d232e04` | **5/5**   | **5/5**  | **5/5** |

How to read it:

- **The first three rows do not differ beyond chance.** With 5 runs each, one weak
  recording moves a cell by 20 points, and how often the 1.7B agent leaves emails out
  (0 of 5 recordings in the first row, 2 of 5 in the second) is the agent's luck, not the
  engine's. The warnings alone change nothing in a replay, and are not meant to.
- **The warning finds the weak recordings.** In rows two and three together (10 runs),
  the compiler warned about 3 recordings ("mentions 1 of 3 emails", "mentions none of the
  3 emails"). Those 3 are exactly the runs that failed same data and new data; no run
  without a warning failed them.
- **Acting on the warning is what helps.** In the last row `hotpath compile --strict`
  refused 2 of the 5 first recordings (one covered 1 of 3 emails, one none), the agent
  did the task again, and the second recording was accepted both times: 15 of 15
  scenario runs passed. One sample of 5: encouraging, not proof. It costs one more agent
  run (about 10 s here) for each refused recording.
- **Two recordings helped less than hoped.** The compile learned a missing requirement
  from the other recording in 3 of 5 runs (email subjects, the weather summary, event
  titles), but when both recordings leave the same list out (run 4) there is nothing to
  learn, and the drift scenario still depends on the single recording the fallback makes.
- **Drift.** The "before" failure was a fallback agent that sent a placeholder brief;
  the recompiled workflow had nothing to check and replayed the placeholder. Such a
  recompile is now rejected (row three, run 3: "recompile rejected … what the AI step s4
  must mention"), which the bench counts as a failed scenario because the next run falls
  back again, but the placeholder is no longer replayed day after day. The other drift
  failure (row three, run 2) was a fallback recording that covered 1 of 3 emails: a
  fallback is not yet held to `--strict`, because the old workflow no longer fits the data
  and there is nothing better to keep. Open.
- **Times.** Replays took 0.3 s (answer reused) to 2.1 s, the agent 9–16 s. The 313 s
  drift recoveries in the first row's log are not the engine: on this PC every `pnpm`
  start hangs for 5 minutes, and the fallback started the agent through `pnpm`. The
  later rows start it with `node --import tsx` and recover in 10–13 s.

Not measured: paraphrase-tolerant matching (not built), other tasks, other models.

## Rows written by code, replay model that thinks (2026-11-15, task 05)

`bench/src/replay-tokens.ts`, commit 7b1622f, dry runs, model `qwen3:1.7b` on local
Ollama with thinking on (`HOTPATH_CHEAP_REASONING=default`), 5 runs per cell, the checked-in
morning-brief recording. "Passed" = no drift and every required value in the text.

| data      | AI step writes | passed | output tokens (mean) | range     | prompt tokens | llm s (mean) | calls | rows filled |
| --------- | -------------- | ------ | -------------------- | --------- | ------------- | ------------ | ----- | ----------- |
| same data | whole text     | 1/5    | 2324                 | 933–4551  | 806           | 41.3         | 1.8   | -           |
| same data | rows by code   | 1/5    | 3086                 | 1411–4547 | 919           | 22.8         | 2.0   | 0/5         |
| new data  | whole text     | 0/5    | 2583                 | 1226–5968 | 862           | 19.2         | 2.0   | -           |
| new data  | rows by code   | 1/5    | 2627                 | 1119–4212 | 783           | 19.5         | 1.8   | 1/5         |

**Result: a loss. The target (new-data output tokens halved) was not met.** Output tokens
did not fall (2583 → 2627 on new data, 2324 → 3086 on same data) and passes stayed at 0–1
of 5. Rows were filled by code in only 1 of 10 runs: the 1.7B thinking model mostly writes
the lists itself or fails the check, so the feature rarely applies here. The model's
thinking dominates the output, which row templates do not shorten. Not measured: bigger
models (`qwen3.5:4b`), other providers, or a per-provider thinking budget. `HOTPATH_LAYOUT`
is left on (it is off with `HOTPATH_LAYOUT=0`); keeping it as the default is the owner's call.

### Same test, Gemini (2026-11-15, task 05)

Same script and commit as above, model `gemini-3.1-flash-lite` through Google's
OpenAI-compatible endpoint (free tier), thinking on (`HOTPATH_CHEAP_REASONING=default`), 5 runs each.

| data      | AI step writes | passed | output tokens (mean) | range   | prompt tokens | llm s (mean) | calls | rows filled |
| --------- | -------------- | ------ | -------------------- | ------- | ------------- | ------------ | ----- | ----------- |
| same data | whole text     | 5/5    | 140                  | 140–140 | 505           | 2.2          | 1.0   | -           |
| same data | rows by code   | 5/5    | 65                   | 65–65   | 489           | 1.2          | 1.0   | 5/5         |
| new data  | whole text     | 3/5    | 192                  | 126–291 | 634           | 6.4          | 1.4   | -           |
| new data  | rows by code   | 5/5    | 62                   | 62–62   | 471           | 4.2          | 1.0   | 5/5         |

**Result: a win on this model.** New-data output tokens fell from 192 to 62 (-68%, target
was -50%), passes went from 3/5 to 5/5 (both whole-text failures were a missing-values
drift and a second call), and rows were filled by code in every run. Caveats: one small
model, 5 runs, one task; the provider's `completion_tokens` may not include hidden
thinking tokens, so the token ratio is for visible output. Together with the Qwen table
above: rows by code helps a model that follows the format, and does nothing for a 1.7B
model that thinks at length. `HOTPATH_LAYOUT` stays on by default.

## Branches and per-item rules (2026-11-15, task 03)

`pnpm bench:branching --runs 3` (`bench/src/branching.ts`), commit `8895286`, agent and
replay model both `gemini-3.1-flash-lite` (free tier, thinking off for replay). Real model
calls; every check reads what the demo tools were asked to do (`out/actions.json`).

- **mail-triage**: the agent records the task once per path (urgent → page the on-call,
  normal → add to the digest, spam → archive); the three recordings compile into one
  workflow with a 3-path branch. Replays: each path on the recorded data and on new
  data; then a fourth path never recorded (billing → forward to finance), which must fall
  back to the agent, be learned, and then run alone while the old paths still work.
- **inbox-sweep**: one recording of "archive only the spam" must compile into a loop with
  a rule on each email, and archive the right emails on a different mailbox.

| Check                                                   | Passed   |
| ------------------------------------------------------- | -------- |
| mail-triage compiled into a branch                      | 2/2      |
| mail-triage same data (urgent, normal, spam)            | 2/2 each |
| mail-triage new data (urgent, normal, spam)             | 2/2 each |
| mail-triage unseen path: falls back to the agent        | 2/2      |
| mail-triage unseen path learned: runs alone             | 2/2      |
| mail-triage old paths still work after learning         | 2/2      |
| inbox-sweep learned the rule `email.category is "spam"` | 3/3      |
| inbox-sweep same data / new data                        | 3/3 each |

**One of three mail-triage runs was lost before it produced a workflow:** the recording
agent chose the wrong action for the "normal" email, and its next run failed. That is the
recording agent's mistake, not the compiled workflow's, but it is a failure of the whole
loop on this model: 2 of 3 attempts at recording three paths succeeded. A first single run
of the same script passed 13/13.

Limits of this measurement: one small hosted model, three runs, two demo tasks with fake
data. Rules from one example per path are only learned on category-style field names
(`priority`, `status`, ...); with any other field the cheap model is asked, which this
run did not exercise. Not run: the acceptance check's local `qwen3:1.7b` version.

## The ten-task suite (2026-11-15, task 06)

`pnpm bench --suite --runs 3 --skip-agent-reruns`, code as of `13f9bf9` (before branching
v2), agent and replay model both `gemini-3.1-flash-lite` through Google's OpenAI-compatible
endpoint (free tier; costs read $0). Ten tasks: the three demo tasks and seven office tasks
(`examples/demo-tools/src/office.ts`). Each task has three scenarios (same data, new data,
drift) and was run 3 times: 90 scenario runs. A scenario passes when the replay did the
right things and mentioned every expected item (and, for drift, recovered without a second
fallback).

| Task            | Passed          | What decided it                                                                                             |
| --------------- | --------------- | ----------------------------------------------------------------------------------------------------------- |
| morning-brief   | 9/9             |                                                                                                             |
| customer-lookup | 9/9             | chained lookups (each call needs the last result)                                                           |
| two-places      | 9/9             | two `send_message` calls to different recipients                                                            |
| meeting-times   | 9/9             | UTC to local time; the AI step does the arithmetic                                                          |
| long-report     | 8/9             | 22 calls. One drift recompile was rejected because the fallback agent skipped steps (6 of 7 projects)       |
| weekly-report   | 7/9             | 2 new-data runs: the AI text was 517 and 550 characters, over the length guard (recorded from a short text) |
| inbox-digest    | 6/9             | one run lost in setup (the recording agent run failed)                                                      |
| invoice-total   | 6/9             | one run lost in setup: the free tier answered HTTP 429 to the recording agent                               |
| ticket-pages    | 4/9             | pagination: recorded with 2 pages, new data has 3 (see below)                                               |
| flaky-sales     | **0/9**         | a read that fails once (see below)                                                                          |
| **Total**       | **67/90 (74%)** |                                                                                                             |

Speed where it passed: same-data replays took 0.3 s against 5–98 s for the agent (14–367×,
mostly answer reuse); new-data replays took 1–5 s (3–107×). Two new-data replays were not
faster: `inbox-digest` (60 s for the replay, a slow model call) and `two-places` (equal).

### The three engine gaps this suite found (fixed in code 2026-11-16, not re-measured yet)

- **A read that fails once (flaky-sales, 0/9).** The service answers 503 to the first
  `get_sales` call of every process. The agent retried; the compiler drops failed calls, so
  the workflow has one `get_sales` step with no retry, and every replay hits the 503 and
  falls back. Fix to try: retry a read-only tool step once when it returns an error.
- **Pagination (ticket-pages, 4/9).** "Call `list_tickets` until `next_page` is null" is
  recorded as two fixed calls. New data with three pages is caught by the guard
  (`next_page must be null`) and falls back, and the recompile was rejected twice because the
  fallback agent's recording looked like it skipped a step. Fix to try: a loop that follows
  `next_page`.
- **The length guard does not grow with the data (weekly-report, new-data 1/3).** The limit
  is the larger of 500 characters and three times the recorded text (`compiler.ts`). The
  recording's text was short, and on a day with more to report the text was 517 and 550
  characters. Fix to try: scale the limit with the number of items in the data.

Not run: the acceptance check names local `qwen3:1.7b` for both roles. Three of the 90
runs were infrastructure failures (HTTP 429 on the free tier) and are counted as failures.

**Fixes made for these gaps (unit-tested, suite not re-run):** a read-only tool step that
returns an error is repeated once (side effects never are); a run of calls to one read-only
tool that differ only in a page number going up by one, ending where the data ended, now
compiles to one step with `paginate` that follows the next-page field (up to 50 pages); the
length limit of a written text grows with the number of list items in today's data compared
with the recording (`recordedItems`). Re-run `pnpm bench --suite` to measure them.

### Finance task: bank-reconciliation (2026-11-16, Gemini free tier, 1 run, a sign not a statistic)

Paged bank lines in EUR/USD/GBP, matched against a ledger, converted with exchange rates, one report
to the controller (`examples/demo-tools/src/finance.ts`). Agent `gemini-3.6-flash`, replay model
`gemini-3.1-flash-lite`.

| Scenario                         | Result                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| same data                        | ✅ 0.3 s against the agent's 11.4 s, no fallback                                               |
| drift (`amount` renamed `value`) | ✅ caught, agent re-ran, recompiled, 0.3 s afterwards                                          |
| new data (3 pages, other refs)   | ❌ the replay model's text had the wrong total (428 EUR missing): the sum is done by the model |

What it found:

- With `gemini-3.1-flash-lite` as the _agent_, the recorded run itself was wrong (it listed a
  matched line as unmatched and summed 242.5 instead of 297.5). A wrong recording compiles into a
  wrong workflow; the expected-mentions check caught it. The compiler's coverage warning also said
  the recorded text mentioned only part of the lines.
- Agents fetch page 2 after looking at something else (page 1, ledger, page 2). The first pagination
  fix only took consecutive pages and missed this; it now takes pages with other reads in between
  (a side effect between them ends the chain). The bench's tool-call check accepts the same reads in
  another order.
- Open gap: arithmetic over today's data (a total in EUR) is left to the replay model, and a small
  model gets it wrong. Idea to try: compute sums in code (a derived value step) like rows-by-code.
- Free-tier 429 and 503 errors hit several runs; `gemini-3.7-flash` returned 503 on setup.

### First real run on Claude: bank-reconciliation (2026-11-16, Sonnet 5.5 agent, Haiku 5.5 replay, 1 run each)

Full table, token counts and the problems it showed are in `JOURNEY.md`. In short: replay cost 20–58×
lower than the Sonnet agent ($0.0005–0.0016 against $0.028–0.032 a run); time 1.4× faster, 1.2× slower and
3.5× faster in three comparisons; drift was caught, the agent recovered and the recompiled workflow replayed
cleanly. But the new-data replay left out the unmatched list and the 428 EUR total and still passed every
guard. Prices are the project's table (2026-11-03); the tool's own cost column showed $0.0000 because
`PRICE_*` was not set.

### Tried: prompt-level fixes for the finance replay (2026-11-16, Haiku 5.5, 3 runs each on new data, Sonnet recording)

Same Sonnet recording of `bank-reconciliation`, replayed on new data with Haiku 5.5, to see why the report
left out the unmatched list and the 428 EUR total. Prices: Haiku $0.10 / $0.50 per 1M tokens.

| Change                                                                                | Total (428) in report | LLM calls | Output tokens per run | Cost per run   |
| ------------------------------------------------------------------------------------- | --------------------- | --------- | --------------------- | -------------- |
| Before (prompt says "cover every item")                                               | 0 of 3                | 2         | 2,637–2,737           | $0.0013–0.0016 |
| After: lines with calculated figures shown as `<calculated>`, "do not leave them out" | **0 of 3**            | 2         | 2,035–2,632           | $0.0012–0.0015 |

**It did not work.** Haiku wrote an exhaustive reconciliation each time (every line, conversions of the
unmatched USD lines) but no total. The hint costs about 110 prompt tokens and changes nothing the user
would notice. A small model does not do "work out a figure like the recording's" from a prompt; the figure
has to be calculated by code. (The code is kept, tested, and harmless; `selective` also did not fire here,
because the recording mentions every reference and so counts as covered.) What did work: the compiler now
warns about a recorded sentence that admits a gap ("I did not fetch a GBP rate"), which every replay repeats.
The two-calls-per-run cost comes from the grounding guard asking for a retry; not yet investigated.

### Finance replay fixed: the retry had lost the instruction (2026-11-16, Haiku 5.5 and Sonnet 5.5, Sonnet recording)

Why the total (428 EUR) never appeared: when the first answer fails a check, the runtime asks again with a
shorter prompt, and **that prompt had none of the instructions about calculated figures**, so the text that
was finally sent came from a prompt that never asked for a total. (An earlier prompt-only fix, measured above,
changed only the first prompt, so it looked like it did nothing.) The retry prompt now keeps the
"calculated figures" lines (`derived`).

New data, 2026-10-02 (3 pages), Sonnet recording, replay step written by:

| Writer                          | Runs | Total 428 in the sent report | LLM calls | Output tokens | Cost per run   | Time        |
| ------------------------------- | ---- | ---------------------------- | --------- | ------------- | -------------- | ----------- |
| Haiku 5.5                       | 5    | **5 of 5** (no repair mode)  | 2         | 2,482–2,795   | $0.0014–0.0016 | 9.8–11.6 s  |
| Haiku 5.5, before the retry fix | 3    | 0 of 3                       | 2         | 2,035–2,632   | $0.0012–0.0015 | 8.5–14.7 s  |
| Sonnet 5.5                      | 3    | 3 of 3 (repair on)           | 2         | 1,775–1,785   | $0.0214–0.0215 | 14.4–18.9 s |

The Sonnet agent doing the same new day: $0.033 and 10.1 s (bench run). So the Haiku replay is about 22× cheaper
at about the same time; Sonnet as the writer is no better and 15× dearer, so a stronger writer is opt-in
(`HOTPATH_STRONG_CALC=1` at compile time), not the default. Same data: 1 call, $0.0006, 4.5 s. A Sonnet-written
step before the retry fix had also failed to produce the total (0 of 3), which is what pointed at the retry.

Caveats: one task, 5 runs, one recording; the report on new data takes 2 calls (the grounding check asks for a
retry), so it is no faster than the agent; with repair mode off, Sonnet-written runs before the fix drifted on
the grounding guard ("does not mention -250"), a position-based check that is still too strict.

### Measured the way a reviewer asks (2026-11-16, `pnpm bench:measure`, finance task, Sonnet 5.5 recording, Haiku 5.5 replay)

New script `bench/src/measure.ts` (`pnpm bench:measure --task T --runs N --drift K [--record]`). Every run, in
every scenario, is one record in `out/measure-<runId>.jsonl` with the same fields: run id, wall time, engine time
split into startup / tools / model / rate-limit wait, model calls, prompt and completion tokens, cost, the text
that was sent, and two separate verdicts: **mentions** (the old word check) and **correctness** (`exact` in the
expected file: the figure on the "total" line must equal the true total, every unmatched line must show its EUR
amount, no matched line may be reported as missing). Timing boundaries: **wall** = the whole `hotpath run`
process as a person waits for it (includes starting node and tsx, about 0.65 s); **engine** = what the runtime
measured inside it. Replays run with `--no-fallback`, so a replay that drifts is counted as "needed recovery"
and costs no agent call. Only same-data may reuse a saved answer; new-data runs set `HOTPATH_REUSE=0`.

Recording (once): Sonnet 5.5, 5 calls, 9,030 in / 1,158 out, $0.0296, 13.2 s.

| Scenario          | Runs | Finished | Correct (exact) | Model calls     | Wall p50 / p95    | Engine p50 / p95 | Tokens in / out (mean) | Cost (mean) |
| ----------------- | ---- | -------- | --------------- | --------------- | ----------------- | ---------------- | ---------------------- | ----------- |
| same data         | 20   | 20       | 20              | **0 in all 20** | 0.94 s / 1.18 s   | 0.28 s / 0.35 s  | 0 / 0                  | $0          |
| new data, batch A | 20   | 19       | not audited¹    | 2 each          | 10.10 s / 10.94 s | 9.48 s / 10.86 s | 1,815 / 2,285          | $0.0013     |
| new data, batch B | 20   | 17       | **17 of 17**    | 2 each          | 10.31 s / 11.46 s | 9.59 s / 10.79 s | 1,815 / 2,385          | $0.0014     |

¹ The text was not saved in batch A; its checker also had a false positive (it called "(excludes BK-2004)" a wrong
claim). Batch B saved every report; all 17 that finished were re-read by the final checker and are correct
(exact total −428, all three unmatched lines with their EUR amounts, no matched line called missing).

- **The 0.3 s is reproducible, but it is engine time.** Same data made zero model calls in 20 of 20 runs (it
  re-sends the answer saved from the recording). End to end through the CLI it is about 0.9 s, mostly startup.
  This is only right when the data is truly identical.
- **Recovery needed on healthy new data: 4 of 40 runs (10%)**, every time the grounding guard ("does not mention DHL /
  −250"), i.e. the model wrote a correct report that did not repeat a value the check expected at a fixed
  position. With the fallback on, each of those would cost one agent run (about $0.028) and a recompile, so the
  real mean cost per run would be about $0.0042 (0.9 × $0.0014 + 0.1 × $0.0294), still about 8× below the
  agent's $0.033. This guard is now the main reliability problem on this task.
- **New data takes two model calls and about 10 s, as long as the agent's 10 s.** Cost is the win here, not speed.
- p95 over 20 runs is the second-slowest run: a first estimate, not a production figure.

**Drift (data changes shape: the bank renames `amount` to `value`), 3 recoveries from the same compiled workflow:**

| What                                                     | Result                                                                                                                                              |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Replay noticed and fell back to the agent                | 3 of 3                                                                                                                                              |
| Agent recovered the task and a new workflow was compiled | 3 of 3                                                                                                                                              |
| Report sent by the recovery run correct (exact)          | 3 of 3                                                                                                                                              |
| Agent cost per recovery                                  | $0.0274–0.0284 (mean $0.0280), 5 calls, about 8.9k in / 1.0k out, 9.9–10.9 s                                                                        |
| Recompiled workflow kept its side effect                 | 3 of 3 (one `send_message`, same tool, `to="controller"`)                                                                                           |
| Recompiled workflow kept its guards                      | 3 of 3 (every read has a result schema; the AI step keeps its non-empty and length checks and still has grounding checks); 5 steps before and after |
| Replay on the changed data after the recompile           | 2 of 3 finished (the third hit the grounding guard again); both finished reports correct²                                                           |

² One was first flagged by the checker for calling BK-1006 missing; the report says "BK-1006 pending a GBP rate"
beside the total, which is not that claim, and the checker was fixed.

What this does not show: one task, one recording, one kind of drift (a renamed field), Anthropic models only, no
agent-versus-Hotpath comparison inside `measure` (the agent's own numbers come from the recording and the earlier
bench: about $0.03 and 10–14 s). The older `pnpm bench` still reports its own way; `bench:measure` is the
consistent one.

## Step 1 of the v1 brief: true against false rejections (2026-11-16, free models only)

`bench:measure --scenarios new-data --runs 20`, `HOTPATH_KEEP_REJECTED=1`, replays with `--no-fallback`, every run
judged by `bench/src/rejections.ts`: a rejection is **false** when the text the guard rejected was a correct report
(every expected mention and the `exact` checks), **true** otherwise; a run that **finished** is judged the same
way. Models: local `qwen3:1.7b` (Ollama, thinking off) and `gemini-3.1-flash-lite` (free tier). Workflows: the
Sonnet recording of morning-brief and the flash-lite recording of bank-reconciliation, as they were on disk.
Code: `23e1c36`. No guard was changed before this table.

| Run id   | Task                | Model      | Finished correct | Finished **wrong** | True rejections | False rejections | Stopped, no reason kept¹ |
| -------- | ------------------- | ---------- | ---------------- | ------------------ | --------------- | ---------------- | ------------------------ |
| ca2a0576 | morning-brief       | qwen3:1.7b | 20               | 0                  | 0               | 0                | 0                        |
| 8ac3bde2 | morning-brief       | flash-lite | 18               | 0                  | 0               | 0                | 2                        |
| 1d223ba4 | bank-reconciliation | qwen3:1.7b | 0                | **20**             | 0               | 0                | 0                        |
| 15ce970c | bank-reconciliation | flash-lite | 15               | **3**              | 0               | 1                | 1                        |

¹ No `hotpath-run.json` was written and the bench did not keep the output (fixed since: `outputTail`,
`providerError`). Wall times of 8–41 s point to the provider; not proven.

**What the table says.** False rejections: 1 of 76 judged runs (1.3%). The problem these runs show is the
opposite one: **23 wrong reports passed every guard and were sent.**

- qwen3:1.7b, bank-reconciliation, 20 of 20: listed all seven lines as unmatched (four of them are in the ledger)
  and wrote the recorded total **-297.5** instead of -428. Its first answer had been rejected for leaving out
  BK-2006 and BK-2007; the retry then listed every line.
- flash-lite, 3 of 20: totals 332, 1103.5 and 430 instead of -428 (wrong arithmetic or wrong selection).
- The one false rejection (flash-lite #20) asked for BK-2001, BK-2003 and BK-2005, three **matched** lines.

**Why: the bank-reconciliation workflow on disk was stale.** Its AI step carried a grounding entry with an
`atLeast` field that no code in this repository writes or reads. The schema drops unknown fields, so the entry
became "every line's ref must be mentioned", which forces a correct report to list matched lines. A fresh compile
of the same recording with today's compiler gives `positions: [3, 6]` instead. The morning-brief workflow equals a
fresh compile.

### The same task on a fresh compile (positions only, `HOTPATH_SELECTION_RULES=0`)

| Run id   | Model      | Finished correct | Finished **wrong** | Rejections | Notes                                                                                                                                                                 |
| -------- | ---------- | ---------------- | ------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a5e87626 | qwen3:1.7b | 0                | **20**             | 0          | listed BK-2001 to BK-2005 as unmatched (four are matched), left out BK-2006 and BK-2007, wrote the recorded total -297.5; the count rule ("cite 2 items") accepted it |
| 2c787f0b | flash-lite | 11               | **1** (total 580)  | 0          | stopped after 12 runs to save free-tier quota (runs 13–20 were killed at start, 3–5 ms, not counted)                                                                  |

## Steps 2–4: selection rules and figures computed by code (2026-11-16)

Steps 2 to 4 of the brief turned out to be one fix. The step 1 table shows almost no false rejections (1 of 76) and
many wrong reports passing, all on the selected list and its total. So the guard was made **stricter where it was
blind**, and the prompt now hands the model what code can work out:

- **Selection rule (A2).** At compile time, for a list the recorded text cited only in part, Hotpath looks for a
  simple rule that picks exactly the cited items on the recorded data: membership in another list read in the same
  run (`ref` not in the ledger's `ref`), a field equal to a value, or the sign of an amount. Only exact fits are kept;
  when several fit, an item counts as selected only if every rule selects it. At run time the output must cite
  **exactly today's selected items by their key** (instead of "any 2 items"), and the prompt names them. No rule
  found: the old count check stays. `HOTPATH_SELECTION_RULES=0` at compile time switches it off.
- **Figures in code (A3).** For each figure in the recorded text that no tool returned, the compiler looks for the
  expression that gives it exactly: count, sum or average of a field over the list or over the selected items,
  optionally converted to the report's currency with the rates the run read, or one item's converted amount. At
  run time code computes it on today's data, the prompt gives the result ("use exactly, do not recalculate"), and
  the output must state it (sign and trailing zeros may differ); the recorded figure written again while today's
  differs is a copied fact. A figure that cannot be computed today (a rate was not read) is claimed nowhere: the
  model writes it as before. `HOTPATH_CALCULATIONS=0` switches it off.
- Also: a replay answer wrapped whole in `"""` or a code fence is unwrapped (qwen copied the retry prompt's
  delimiters into every sent report).

Safety: `packages/runtime/test/guard-safety-finance.test.ts` (new day of the finance recording): the correct
report passes old and new guard; the report qwen actually sent (measured above) passes the old guard and is
rejected by the new one; a left-out unmatched line, a matched line put in its place, a wrong total, the recorded
total, no total and a wrong converted amount are each rejected; a day with nothing unmatched asks for nothing.

`pnpm bench:guard-audit` (no model calls), before → after this change:

| What                                                | Old guard | New guard before | New guard now |
| --------------------------------------------------- | --------- | ---------------- | ------------- |
| Values left out one at a time, all steps (415)      | 194       | 186              | **189**       |
| Whole list items left out, all steps (126)          | 89        | 87               | **89**        |
| Whole items the old guard caught and the new misses |           | 2                | **0**         |

The 2 whole bank-reconciliation items are caught again. The 4 single values the audit still lists as lost on that
step are the description and USD amount of the two selected lines: the new guard asks for each selected line by
its reference and for its **converted** amount (the calculation check, which this audit does not run), not for
the description text. The fifth is morning-brief's third sender address, intended (see FALLBACK-INVESTIGATION).

**Measured, bank-reconciliation new data, 20 runs, recompiled from the same flash-lite recording:**

| Run id   | Model      | Before (fresh compile, positions) | After: finished correct | Finished wrong | Rejections | Model calls | Tokens out (mean) |
| -------- | ---------- | --------------------------------- | ----------------------- | -------------- | ---------- | ----------- | ----------------- |
| 56f836c1 | qwen3:1.7b | 0 of 20 correct                   | **20**                  | 0              | 0          | 1 each      | 56 (was 115)      |
| 5d59dab9 | flash-lite | 11 of 12 correct (1 wrong total)  | **20**                  | 0              | 0          | 1 each      | 100 (was 289)     |

Healthy-data false fallback on this task, both models: **0 of 40** (target under 3%), and no wrong report sent.
morning-brief has no selected list or calculated figure, so its workflow is unchanged by this step.

The qwen reports are shorter than the recording (each line with its EUR amount, the total; no description), and
every one has the right three lines and -428. morning-brief on qwen3:1.7b after the change (regression check,
run 3a249cdb): 20 of 20 correct, same as before.

## Step 6: drift suite, bank-reconciliation (2026-11-16)

Seven new fixture sets, each the new-data day with one change
(`examples/demo-tools/scripts/make-drift-fixtures.mjs`): a field removed (`description`), a type change (amounts as
strings), a new enum value (an unmatched line in CHF), an empty statement, an error payload (`{error: …}` from the
ledger, no `isError`), extra nesting (`{page, data: {lines}}`), a renamed tool (`get_fx_rate` →
`get_exchange_rate`), plus the old `drift` set (`amount` renamed `value`). `bench:measure --drift 1 --drift-set S`,
each from the same compiled workflow (the one measured above), fallback on.

**Run 1, qwen3:1.7b as fallback agent and replay model** (run ids 38e26069, 90dd7931, 83a0b0a6, a4c0bd07, b486e03d,
8e0f3fa3, e1906945, 34b13321):

| Set             | Replay noticed the change         | What the fallback agent (qwen3:1.7b) sent                        |
| --------------- | --------------------------------- | ---------------------------------------------------------------- |
| drift (renamed) | yes, schema of `list_bank_lines`  | wrong (reported matched BK-1005, total 5479)                     |
| removed field   | yes, schema                       | wrong (left out BK-2006, BK-2007)                                |
| type change     | yes, schema (`amount` not number) | wrong (no conversion, total 295)                                 |
| **new enum**    | **no: sent a wrong report**²      | (no fallback)                                                    |
| empty list      | yes, rate lookup failed           | correct ("no unmatched entries, total 0")                        |
| error payload   | yes, schema of `list_ledger`      | wrong: invented two unmatched lines although the ledger was down |
| extra nesting   | yes, schema                       | wrong (left out two lines)                                       |
| renamed tool    | yes, tool not found               | wrong (one line only)                                            |

² The workflow reads exchange rates for the currencies at two fixed line positions (both USD that day), so the CHF
rate was never read; the figure check could compute nothing and claimed nothing, and the model wrote -94.5 EUR for
-95 CHF and a total of -323.5 instead of -432.75. **Fixed:** a calculated figure that needs a rate the run did not
read is now drift ("today's data needs an exchange rate the workflow does not read (CHF)"); re-run e506e2f5: the
replay falls back instead of sending.

Reading: the **engine** noticed the change in 8 of 8 sets after the fix (7 of 8 before). What the fallback then sends
is the agent's work, and qwen3:1.7b is not a usable finance agent (6 wrong reports of 7). A fallback inherits the
agent's quality; Hotpath does not check the agent's own report. The suite is re-run below with a stronger agent.

## Step 8: where the time goes on new data (2026-11-16, from the step 1–4 records, p50 of finished runs)

| Task / model (run)                                 | Wall   | Engine | Startup | Tools | Model call | Model share | Tokens out |
| -------------------------------------------------- | ------ | ------ | ------- | ----- | ---------- | ----------- | ---------- |
| morning-brief, qwen3:1.7b (3a249cdb)               | 2.48 s | 1.87 s | 0.22 s  | 35 ms | 1.61 s     | 86%         | 246        |
| morning-brief, flash-lite (8ac3bde2)               | 5.82 s | 5.20 s | 0.22 s  | 36 ms | 4.94 s     | 95%         | 144        |
| bank-reconciliation, qwen, before (a5e87626)       | 1.60 s | 1.00 s | 0.22 s  | 39 ms | 0.73 s     | 73%         | 115        |
| bank-reconciliation, qwen, after (56f836c1)        | 1.25 s | 0.65 s | 0.22 s  | 39 ms | **0.38 s** | 59%         | **56**     |
| bank-reconciliation, flash-lite, before (2c787f0b) | 9.85 s | 9.24 s | 0.22 s  | 38 ms | 8.98 s     | 97%         | 100        |
| bank-reconciliation, flash-lite, after (5d59dab9)  | 8.78 s | 8.18 s | 0.22 s  | 39 ms | 7.91 s     | 97%         | 100        |

Wall minus engine (about 0.6 s) is starting Node and tsx for the CLI. Rate-limit waits were 0 at p50.

- **The model call is the time**, on every task: tools take about 40 ms, the MCP server 0.22 s to start.
- **Shorter output helps where the model's own speed is the limit.** Giving the model the selected items and the
  computed figures (steps 3–4) halved qwen's output on the finance task (115 → 56 tokens) and its model time (0.73 →
  0.38 s). On flash-lite's free tier the output was already 100 tokens and the call still took about 8 s: that is
  provider latency (queueing), not generation, and no prompt change removes it. The p95 there (57 s) is the same.
- Not done: capping output tokens from the example's length. With thinking off the answers are already short, and a
  cap that cuts a correct answer becomes a false fallback; the existing 16,000-token cap only stops runaway thinking.

**Run 2, gemini-3.1-flash-lite as fallback agent and replay model** (after the new-currency fix; run ids 04311f89,
e6d5fb4a, 74a03d27, 30ff4923, 1a122f49, 73c0dbe3, f2d87256, ffad4d6d):

| Set             | Replay noticed | Fallback agent             | What was sent                                                    | Replay after recompile     |
| --------------- | -------------- | -------------------------- | ---------------------------------------------------------------- | -------------------------- |
| drift (renamed) | yes            | provider 503, not measured | nothing                                                          | drift again (old workflow) |
| removed field   | yes            | sent, then a provider 503  | wrong: BK-2004 (matched) listed, total 484                       | drift again                |
| type change     | yes            | ran                        | wrong: BK-2004 listed, total 484                                 | **wrong: no total**³       |
| new currency    | yes (CHF rate) | provider 503, not measured | nothing                                                          | drift again                |
| empty list      | yes            | ran                        | correct ("no bank transactions … nothing to reconcile")⁴         | drift (rate lookup)        |
| error payload   | yes            | ran                        | nothing (the agent did not report on a ledger it could not read) | drift again                |
| extra nesting   | yes            | provider 503, not measured | nothing                                                          | drift again                |
| renamed tool    | yes            | provider 503, not measured | nothing                                                          | drift again                |

³ The workflow recompiled from the agent's wrong report (total 484, which no calculation explains) replaced the good
one, and its replay sent a report without a total. **Fixed:** a recompile that loses the old workflow's calculated
figures or selection rule is no longer saved (`lostChecks`, like the existing checks for lost steps); the old
workflow stays and the next run falls back again. ⁴ The checker counts it wrong only because it has no "total" line.

**What the suite shows.** The engine noticed the change in 8 of 8 sets on both models, and after the two fixes no
replay sends a report on data it was not built for. Recovery is the weak part, and it is the agent's: flash-lite and
qwen3:1.7b wrote wrong finance reports during the fallback (flash-lite counted the matched GBP line BK-2004 as
unmatched twice), and the free tier failed 5 of 8 agent runs with HTTP 503. Not measured: recovery with a strong
agent (that is a Claude run). The "2 of 3 recompiled replays" problem from the Claude run was a recompile that kept
the per-position grounding of a new recording; recompiles now get selection rules and calculations, and a weaker
recompile is refused. Not re-measured on Claude.

## Step 5: the suite re-run, local qwen3:1.7b (2026-11-16)

`bench/src/index.ts --suite --runs 3 --skip-agent-reruns`, code `dbb425e`, qwen3:1.7b (Ollama, thinking off) as the
**recording agent, the fallback agent and the replay model**. Eleven tasks now (the ten plus bank-reconciliation),
three scenarios each, three runs, each run **records the task again** (three recordings per task). Model-provider
failures are now reported apart; there were none (local model). Log: `out/suite-qwen-traces/` holds the 94 traces.

| Task                | Passed          | Same data | New data | Drift |
| ------------------- | --------------- | --------- | -------- | ----- |
| customer-lookup     | 9/9             | 3/3       | 3/3      | 3/3   |
| two-places          | 9/9             | 3/3       | 3/3      | 3/3   |
| invoice-total       | 8/9             | 3/3       | 2/3      | 3/3   |
| inbox-digest        | 7/9             | 3/3       | 2/3      | 2/3   |
| ticket-pages        | 6/9             | 3/3       | 2/3      | 1/3   |
| morning-brief       | 3/9             | 1/3       | 1/3      | 1/3   |
| weekly-report       | 3/9             | 2/3       | 1/3      | 0/3   |
| long-report         | 3/9             | 3/3       | 0/3      | 0/3   |
| meeting-times       | 3/9             | 1/3       | 0/3      | 2/3   |
| flaky-sales         | 2/9             | 1/3       | 1/3      | 0/3   |
| bank-reconciliation | 0/9             | 0/3       | 0/3      | 0/3   |
| **Total**           | **53/99 (54%)** |           |          |       |

**This measures qwen3:1.7b as a recording agent more than the engine.** A same-data replay repeats the recorded
answer, so a same-data failure means the recording itself missed expected items. Read against the recordings (each
agent text checked against the task's expected mentions): bank-reconciliation's recordings missed 1 to 3 of 3 expected
items every time (qwen called the tools with wrong arguments and never read page 2), most morning-brief recordings
missed 1 to 5 of 6, half the weekly-report ones 3 of 6, long-report's agent read 5 of the 22 sources. Where the
recordings were good (customer-lookup, two-places, invoice-total, inbox-digest, ticket-pages) the suite passed **39 of
45 (87%)**. The compile-time checks flagged the bad recordings: coverage warnings ("mentions none of the 3 repos"),
tool errors that were not recovered, and missing reads.

Not comparable with the 67/90 (74%) of 2026-11-15: that run used gemini-3.1-flash-lite as recording agent, ten tasks.
The brief's next step (the same suite on flash-lite) was not run: the free tier answered 503 to 5 of 8 agent runs in
the drift suite the same evening, and a suite run needs about 100 agent runs. Not fixed here: the weakest tasks' cause
is the recording agent; the engine change that would help them (reading a list in full when the agent read part of
it) is not built.

## Step 9: replay models (2026-11-16, new data, bank-reconciliation and morning-brief)

Same workflows for every model (Sonnet recording of morning-brief, flash-lite recording of bank-reconciliation, code
`dbb425e`). Replays with `--no-fallback`; every stop was judged with `bench/src/rejections.ts`.

| Replay model (family)          | Runs  | morning-brief                          | bank-reconciliation | Wrong reports sent | False rejections | Model call p50 (bank) |
| ------------------------------ | ----- | -------------------------------------- | ------------------- | ------------------ | ---------------- | --------------------- |
| qwen3:1.7b (Qwen, local)       | 20+20 | 20 correct                             | 20 correct          | 0                  | 0                | 0.38 s                |
| qwen3.5:4b (Qwen, local)       | 10+10 | 7 correct, 3 true rejections           | 10 correct          | 0                  | 0                | about 1.3 s           |
| qwen2.5-coder:7b (Qwen, local) | 10+10 | 10 correct                             | 10 correct          | 0                  | 0                | about 3 s             |
| gemini-3.1-flash-lite (Google) | 20+20 | 18 correct, 2 stopped (no reason kept) | 20 correct          | 0                  | 0                | 7.9 s (free tier)     |

Run ids: ca2a0576 / 56f836c1, 6564dc3f / 727559bf, ac0d113d / a7f3b60d, 8ac3bde2 / 5d59dab9. Local runs on an RTX 2060.

- **Healthy-data false fallback on two models, both tasks: 0 of 80** (qwen3:1.7b and flash-lite; target under 3%).
- The three qwen3.5:4b stops were right: the first answer copied the recorded date and dropped an email, the retry
  paraphrased the subjects. Each would have cost one agent run, not a wrong brief.
- **Recommended now:** qwen3:1.7b or qwen2.5-coder:7b for local replay; gemini-3.1-flash-lite for a cheap hosted
  replay, with its free-tier latency (8 s p50, 57 s p95) in mind. Claude Haiku 5.5 was measured before the
  engine changes (see above) and is the step 12 check.
- **Not measured: OpenAI, DeepSeek, Mistral or any other family.** No key for them on this machine; bigger Gemini
  models answered 429 earlier. One cheap model per family is still open.

## Steps 7, 10, 11: checks without a model (2026-11-16, unit-tested, no benchmark needed)

- **Step 7, recording check.** `hotpath compile` now (a) warns about a recording whose reads returned an error the
  agent never recovered from, an empty answer, the same call three times in a row, or figures in the text that no
  tool returned and no calculation explains; and (b) **replays the workflow once on its own recording** (tools
  answered from the trace, no model, side effects dry) and warns when a step asks for something the recording never
  did or the recorded text fails the workflow's own checks. Both real workflows (morning-brief, bank-reconciliation)
  pass it. In the qwen suite above the coverage warnings named the bad recordings; the replay check is new since.
- **Step 10, hosted mode.** `HOTPATH_HOSTED=1`: no local tool server or agent; https MCP endpoints only, through an
  egress check at connect time (private, loopback, link-local, metadata, CGNAT, IPv4-mapped and NAT64 addresses
  refused; DNS rebinding and redirects covered). Security findings 5 (link guard) and 7 (private folders, opt-in
  retention) closed except the parts that need a decision; see `SECURITY-REVIEW.md`.
- **Step 11, crash safety.** A crash journal per task and inputs: a rerun after a crash does not repeat a finished
  action and stops on one that never confirmed (`crash-safety.test.ts`: killed after the first of two sends → the
  rerun sends only the second; killed during the second → the rerun sends nothing and says why).

Retry of the five drift sets the flash-lite agent lost to HTTP 503 (run ids feed1bea, 5fe925a3, 28cb3395, 63363a26,
77af2434): every replay noticed the change again and nothing was sent, but every fallback agent run got HTTP 429 (the
day's free quota was used up). The bench now labels these `providerError` and does not count them. Recovery on these
five sets is still unmeasured.

## Step 12: Claude confirmation run (2026-11-16, owner's yes, about $0.06 spent)

Same shape as the earlier Claude runs: `bench:measure --record --runs 10 --scenarios new-data`, Sonnet 5.5 records once,
Haiku 5.5 replays, `--no-fallback`, prices from the project table (Sonnet $2/$10, Haiku $0.10/$0.50 per 1M).

| Run id   | Task                                                | Recording (Sonnet)                  | New data, finished | Correct | Model calls   | Wall p50 / p95  | Out tokens (mean) | Replay cost (10 runs) |
| -------- | --------------------------------------------------- | ----------------------------------- | ------------------ | ------- | ------------- | --------------- | ----------------- | --------------------- |
| 05811411 | morning-brief                                       | 3 calls, 4,448 / 866 tok, $0.0176   | **10 of 10**       | 10      | 1 (one run 2) | 5.33 s / 9.05 s | 1,061             | $0.0062               |
| dfd4e20e | bank-reconciliation                                 | 5 calls, 8,903 / 1,104 tok, $0.0288 | **10 of 10**       | 10      | 1 each        | 4.11 s / 4.42 s | 723               | $0.0046               |
| fa0371fa | bank-reconciliation, recompiled after the fix below | (same recording)                    | **10 of 10**       | 10      | 1 each        | 4.92 s / 6.42 s | 637               | $0.0043               |

Total spend: about **$0.061** (two Sonnet recordings $0.046, thirty Haiku replays $0.015).

Before the engine changes, the same Claude setup finished morning-brief 6 of 10 (then 10 of 10 after the
fallback fix) and bank-reconciliation 36 of 40 with 4 false fallbacks. Now: **30 of 30 finished, 30 correct, no
fallback, no retry on the finance task.** Ten runs per row: a confirmation, not a rate.

**Found by this run and fixed (no extra spend beyond fa0371fa):** the Sonnet recording wrote its figures with trailing
zeros (`-279.00`, `-297.50`) and named the matched lines in passing ("All other lines (BK-1001, 1002, …) have a
ledger entry"). The compiler then learned no calculation and no selection rule; dfd4e20e replayed correctly anyway but
without those checks. Fixed: figures are matched by value, not by text; a line that names two or more other items and
none of the cited ones is a side remark, and the rule is learned without it (one item alone on a line is never set
aside, so a wrong bullet in an agent's report is not explained away); list numbering ("2)") is not a figure. After
the recompile the workflow has the selection rule, the converted amounts and the total, and fa0371fa replayed 10 of 10
correct with them in force.

## Auto-compile: `hotpath learn` (2026-11-18, task 10, local qwen3:1.7b only)

The JIT step: hotpath finds the path an agent repeats and compiles it with no
recording step and no labelling. Branch `task-10-auto-compile` on `cloud-runner`
`bf9c952`. Agent and replay model: `qwen3:1.7b` on Ollama, on a laptop. Nothing
paid was called. 1 run each: a sign, not a statistic.

**How it ran.** The demo agent ran `morning-brief` 3 times (2026-11-16, -17,
-18) on the default data. `hotpath learn` ignored the task name and the inputs
the recorder had stored and worked from the tool calls alone. Then
`hotpath learn --promote`, then `hotpath run <path> --no-fallback` on the
`new-data` fixtures for 3 new dates.

| step                                     | result                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| paths found in 3 runs                    | 1 (`get_emails → get_calendar → get_weather → send_message!`), hot after 3 clean runs                              |
| inputs inferred                          | `date` (the hand-written workflow's only input); `city=Paris` and `to=me` kept as constants                        |
| candidate from all 3 runs                | **shadow check failed**: the 3 texts disagree (see below)                                                          |
| candidate from the newest run (fallback) | shadow check passed: same `send_message` call as the agent; 1 warning (text covers 1 of 3 emails by exact subject) |
| `--auto`                                 | did not promote (it waits for a person when there is a warning); `--promote` did                                   |
| replay on new data, no agent, 3 dates    | 3 of 3 passed; the brief named all 3 new emails, both events and the new weather                                   |
| agent run (p50 of 3)                     | 14.3 s, 4 model calls                                                                                              |
| replay (p50 of 3)                        | 1.3 s in the workflow (2.4 s for the whole command), 1 model call                                                  |

Costs: the price table puts the agent at $0.0878 for the 3 runs ($0.029 each)
and a replay at $0.0022. On local Ollama both are $0 in fact.

**What the run found.** The compiler, given several recordings, learns what a
replay must mention from all of them but takes the example text from the
newest. A weak agent writes a different text each run (run 1 quoted every
email snippet, run 3 paraphrased), so the compiled workflow failed its own
check on its own data. `hotpath compile` on the same 3 recordings would do the
same. `learn` now tries the newest clean run alone when the all-runs candidate
fails the shadow check (inputs still inferred across all runs), and says so.
The compiler's behaviour is task 14's area; a fix there would let all runs
count again.

**Unit checks** (`packages/learn/test`, no model): signatures equal across
data, page counts (1, 3, 5) and loop lengths, and after a retried call;
different for another tool order or another side effect. Inputs inferred from
3 synthetic runs equal the hand-written `{date}` on `morning-brief` and
`bank-reconciliation`. A path with a failed run, or a run that fails the
recording check, is not hot. A candidate edited to send to someone else fails
the shadow check and is never promoted.

**Not measured yet:** the future hit rate on a real user's mixed traffic, and
paths with branches (`mail-triage`) or with several hot paths in one traces
folder.

## Model proxy: one line changed (2026-11-18, task 11)

The example agent in `examples/proxy-agent` (OpenAI SDK, its own tools and loop) does
the daily orders report: read the day's orders, send a report naming each one. The
only change for Hotpath is its `baseURL`. `pnpm --filter proxy-agent bench -- --model qwen3.5:4b`
runs it straight to Ollama on days 2–6, then through `hotpath proxy`: record day 1
(no task name, no inputs given: both inferred), compile, replay days 2–6. Local Ollama
on a laptop, 1 run per day, branch `task-11-proxy` on top of `cloud-runner` bf9c952.

| qwen3.5:4b, 5 days                   | Model calls per run | Time per run | Reports naming every order |
| ------------------------------------ | ------------------- | ------------ | -------------------------- |
| Agent straight to the model          | 3                   | 7.1 s        | 5 / 5                      |
| Same agent through the proxy, replay | 1 (the AI step)     | 1.6 s        | 5 / 5                      |

- The compiled workflow: `s1 get_orders(date={{inputs.date}})`, `s2 llm`, `s3 send_report(to=ops, text={{steps.s2.output}})`.
  The input `date` was inferred from the user message; the task was named `proxy-<hash>`
  after the prompt, and replays found it by matching the prompt with the date taken out.
- Through the proxy, the two tool turns and the closing turn are answered by Hotpath
  (no model call); the one model call is the AI step that writes the report. No
  handover in 5 runs. 4.5× faster per run, 3× fewer model calls.
- **Failed first, with qwen2.5-coder:7b:** the agent itself never called a tool; it wrote
  the call as JSON text with made-up orders, on every day. Nothing could be recorded.
  That is the model, not the proxy (the agent got the same answers without Hotpath).
- One run per day on one small task: a sign, not a statistic. A remote provider was not
  measured (the bench refuses a non-local upstream so it never costs money).

## Task 14: engine reliability (2026-11-18, free and local models only)

Branch `task-14-reliability` from `cloud-runner` (bf9c952). No paid Claude run was made on purpose. **One paid call
happened by mistake** before the worktree's model settings were forced to local qwen: one Haiku 5.5 call (553 in /
396 out tokens, about $0.00025, record `out/measure-a44ff99e.jsonl`, invoice-total, 1 run). It is left out of every
count below. (That record file was later deleted by the suite-runner bug described under "Bench fixes".)

### What changed in the engine

| Commit  | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 98993ab | **Clock times computed by code.** A recorded time ("09:30" for `07:30Z`) is learned as a `time` calculation when every line that names one item states that item's local time under one shift the data gives: an offset field ("+02:00"), then a time-zone field ("Europe/Paris", daylight saving included), then UTC as is. The model gets "Roadmap review: 09:30" and the text is checked for it ("9:30", "9:30 AM" and "09.30" count, "19:30" does not). |
| 98993ab | **Dates and clock times are no figures.** "October 1, 2026", "1 Oct 2026", "Oct 2026", ISO timestamps and "15:00" are masked before figures are read. Before, "the report for October 1, 2026" was learned as a count of 1 (long-report qwen recording) and "15:00" read as an unexplained 15.                                                                                                                                                              |
| 98993ab | **A new currency in an unconverted sum is drift.** A total added up without conversion remembers the currency codes its items had; an item in another currency (EUR among USD invoices) stops the run before the model writes, instead of a total that mixes currencies.                                                                                                                                                                                    |
| 98993ab | **An empty list is drift.** A list the AI step writes about (its calculations, or items it is grounded on) that had items in the recording and is empty today stops the run: the recording never showed what to write then. The agent does that run, and its recording teaches the workflow. Selections are exempt (an empty selection is normal and the prompt says so).                                                                                   |
| e1565d3 | **A value seen only inside a longer one is not grounded** (a label that is a word of a mentioned title).                                                                                                                                                                                                                                                                                                                                                    |
| c66306e | **The same list read in several steps is judged together.** weekly-report reads open issues once per repo; web-app had one issue, so "every issue number" was learned for the other repos but only "the first issue" there. Now the three lists count together (5 of 5 named) and each is required item by item. **A tag inside one item of a list whose items are all required is dropped** (`issues.0.labels`: tomorrow's first issue is another one).    |

### False fallbacks on healthy new data (qwen3:1.7b replay, Ollama, 10 runs per task)

Method (`FALLBACK-INVESTIGATION.md`): each task's latest healthy recording from the main checkout (all 11 mention every
expected item; morning-brief and bank-reconciliation are Sonnet recordings, the others flash-lite) is compiled with
this branch's code and replayed 10 times on the new-data fixtures with `bench:measure --scenarios new-data`
(`--no-fallback`, `HOTPATH_KEEP_REJECTED=1`); `bench/src/rejections.ts` sorts every stop into a true rejection (the
text was wrong) or a false one (it was right). qwen3:1.7b as the replay model, thinking off, RTX 2060.

**First, a bench bug:** the recordings' meta line holds `cwd` = the main checkout, and the compiled workflow keeps it,
so every replay in this worktree started the **main checkout's** tool server with its own code and fixtures and wrote
its messages there. The first baseline (110 runs, 2026-11-18 morning) was therefore invalid and is not reported. The
copied recordings now point at the worktree. (Also a finding for users: a workflow whose recorded `cwd` points at
another checkout runs that checkout's tools without a word.)

**Final measurement, 2026-11-18, code 41b6a35 (9 tasks) and 19386ec (weekly-report and two-places, the only two
whose workflow the last commit changes), 110 replays:**

| Task                | Run id   | Finished correct | Finished wrong | True rejections                       | False rejections | Wall p50 / p95  |
| ------------------- | -------- | ---------------- | -------------- | ------------------------------------- | ---------------- | --------------- |
| morning-brief       | 2e347398 | 10               | 0              | 0                                     | 0                | 2.82 s / 3.11 s |
| bank-reconciliation | 30e46b65 | 10               | 0              | 0                                     | 0                | 2.94 s / 3.14 s |
| invoice-total       | 57ef439f | 10               | 0              | 0                                     | 0                | 2.03 s / 2.33 s |
| meeting-times       | c393b325 | 10               | 0              | 0                                     | 0                | 1.46 s / 1.79 s |
| weekly-report       | 73b3f17b | 8                | 0              | 2 (left out open issue 315)           | 0                | 3.28 s / 3.49 s |
| long-report         | 28f14740 | 10               | 0              | 0                                     | 0                | 2.65 s / 2.87 s |
| inbox-digest        | cce2d0bc | 10               | 0              | 0                                     | 0                | 2.33 s / 2.52 s |
| ticket-pages        | 9a75f93c | 10               | 0              | 0                                     | 0                | 1.32 s / 1.41 s |
| flaky-sales         | c1d89f2a | 1                | 0              | 9 ("Baltic" for the region "Baltics") | 0                | 2.10 s / 2.33 s |
| customer-lookup     | ab993f89 | 10               | 0              | 0                                     | 0                | 1.48 s / 1.67 s |
| two-places          | 4d11c6f6 | 8                | 0              | 2 (status note paraphrased the title) | 0                | 2.27 s / 2.58 s |
| **Total**           |          | **97 of 110**    | **0**          | **13**                                | **0 (0%)**       |                 |

**False fallbacks: 0 of 110 (0%) by the bench's rule, under the 2% target.** The rule (`rejections.ts`) counts a stop
as true when the rejected text misses a fact the task's answer key names. Read by a person, 11 of the 13 true
rejections are **wording slips, not wrong facts**: qwen3:1.7b wrote "Baltic" for "Baltics" with every figure right (9,
flaky-sales; the retry named the region and the model wrote "Baltic" again), and twice it paraphrased the incident
title in the status note ("stale search results for new listings"). Counted as false, the rate would be **11 of 110
(10%)**. The guard was not loosened to accept them: a guard that accepts a changed name accepts a wrong one too. What
would remove the flaky-sales slip without loosening anything: the recording wrote "18,400" for 18400, so its
one-line-per-region rows cannot be written by code (a reformatted value blocks a row template, by design); row
templates that can group thousands would let code write the region names. Not built (follow-up).

Before the fixes (same recordings, same model, 2026-11-18, code 98993ab and e1565d3; records lost, see "Bench
fixes"): weekly-report finished **1 of 10**. All 9 stops were on the label "performance" (a word the agent wrote for
issue 77's title). One of those texts was correct (**1 false rejection of 110, 0.9%**). The other 8 left out issue 315
and were caught only by that accident: the issue numbers of web-app (one issue in the recording) were checked for the
first issue only. two-places finished 6 of 10, with 2 "finished wrong" that were a bench artifact (the crash journal
made the next run skip the on-call message; the bench now clears it), and every two-places stop came **after** the
on-call message was sent, so the agent could not have taken over. All other tasks were as in the final table.

After the weekly-report fix, its 8 finished texts (73b3f17b) state every open issue, but only 4 name issue 315 with
its title under mobile-app; the other 4 add a bare "315" under another repo (the guard checks that a value is in the
text, not where; the retry told the model "does not mention: 315" and it appended the number). A reader would call
those 4 sloppy; the bench's answer key does not check placement.

### Guard audit (`bench:guard-audit`, no model, this worktree's 11 recordings plus the checked-in one)

| Code                     | Values left out, caught (old guard / current) | Whole items left out, caught (old / current) | Lost against the old guard                          |
| ------------------------ | --------------------------------------------- | -------------------------------------------- | --------------------------------------------------- |
| bf9c952 (start)          | 169 / 165 of 370                              | 81 / 79 of 116                               | 4 values, 2 items (bank-reconciliation)             |
| 98993ab, e1565d3         | 169 / 165 of 370                              | 81 / 79 of 116                               | same                                                |
| c66306e, 19386ec (final) | 169 / 164 of 370                              | 81 / 79 of 116                               | same + 1 value: weekly-report's label "performance" |

The 4 values and 2 items lost on bank-reconciliation are there at bf9c952 already: they are matched bank lines that
the selective report rightly leaves out (the old guard demanded every position). The one new loss is the label inside
issue 77, which stays required through its number. The audit cannot show the gain (a new issue in a one-issue repo is
now required): it only leaves out values of the recorded data. `guard-safety.test.ts` and
`guard-safety-finance.test.ts` pass unchanged.

### Tool changes beyond a renamed field (`packages/runtime/test/drift-kinds.test.ts`, unit-tested, no model)

An invoice-total workflow compiled from a recording with amounts in USD, replayed on changed data. Each change must
stop before `send_message` with a reason that says what changed; the agent then takes over (fallback), or with
`--no-fallback` the run fails with that reason.

| Change                                     | Where it stops | Reason given                                              | Sent | Model called |
| ------------------------------------------ | -------------- | --------------------------------------------------------- | ---- | ------------ |
| healthy new data (control)                 | does not stop  |                                                           | once | yes          |
| removed field (`amount`)                   | s1 (the read)  | schema: `amount` required                                 | no   | no           |
| changed type (amounts as strings)          | s1             | schema: `amount` must be a number                         | no   | no           |
| new enum value (one invoice in EUR)        | s2 (the text)  | "a currency the recording never saw (EUR)": **new check** | no   | no           |
| empty result (`[]`)                        | s2             | "steps.s1.result is empty today": **new check**           | no   | no           |
| error payload (`{error: …}`, no `isError`) | s1             | schema                                                    | no   | no           |
| error flagged by the tool (`isError`)      | s1             | read again once, then stops                               | no   | no           |

Before this work the new-currency case summed USD and EUR as one figure and sent it, and an empty list was written
about by the model without a stop. The finance task had these kinds measured on 2026-11-16 (step 6: the replay
noticed 8 of 8). **Recovery quality is the fallback agent's**, as step 6 showed; not re-measured here.

### Clock times and dates

meeting-times on new data (qwen3:1.7b, c393b325): **10 of 10 correct**, with the local times (10:15, 08:00, 16:45 from
UTC +02:00) handed to the model by code and checked in the text. In the 2026-11-16 qwen suite, meeting-times new data
was 0 of 3 (with qwen's own recordings, so not a like-for-like comparison). Unit tests cover the zone case
(Europe/Paris in October and in December) and that a wrong conversion, or a UTC time written as local, is rejected.
"October 1, 2026" is no longer learned as a count.

### Bench fixes

- **The suite runner deleted `out/`** at start, with every `bench:measure` record in it, and its own log when that
  was redirected there. It deleted this day's first measurement records (and the accidental Haiku record named above);
  the numbers before the fixes come from the tables printed at the time. Fixed (b33fb2f): the suite clears only its
  own files.
- **Measured runs were not independent** (41b6a35): a run that stopped after its first message left a crash-journal
  entry, and the next run with the same inputs skipped that message. `bench:measure` now clears the task's journal
  before each run.

### The eleven-task suite on gemini-3.1-flash-lite (2026-11-18, code 19386ec, 1 run)

`bench/src/index.ts --suite`, gemini-3.1-flash-lite (free tier) as **recording agent, fallback agent and replay model**,
33 scenario runs (11 tasks × same data, new data, drift), **one pass**: the run was started with `--runs 3` and stopped
after the first pass at the owner's request (time). A sign, not a rate.

| Task                | Same data | New data  | Drift    | Passed          | What decided a failure                                                                                        |
| ------------------- | --------- | --------- | -------- | --------------- | ------------------------------------------------------------------------------------------------------------- |
| morning-brief       | ✅        | ✅        | ✅       | 3/3             |                                                                                                               |
| inbox-digest        | ✅        | ✅        | ✅       | 3/3             |                                                                                                               |
| ticket-pages        | ✅        | ✅        | ✅       | 3/3             | (was 4/9 on 2026-11-15: pagination now a loop)                                                                |
| customer-lookup     | ✅        | ✅        | ✅       | 3/3             |                                                                                                               |
| two-places          | ✅        | ✅        | ✅       | 3/3             |                                                                                                               |
| invoice-total       | ✅        | ✅        | ✅       | 3/3             |                                                                                                               |
| weekly-report       | ✅        | ✅        | ❌       | 2/3             | drift: the fallback agent read 1 of 3 repos; the recompile was refused (it lost steps), so it fell back again |
| long-report         | ✅        | ✅        | ❌       | 2/3             | drift: the free tier answered 429 during the recompiled run; the agent's report missed all 7 projects         |
| flaky-sales         | ✅        | ✅        | ❌       | 2/3             | drift: fell back again after the recompile (was 0/9 on 2026-11-15: the read retry fixed same and new data)    |
| meeting-times       | ✅        | ✅        | ❌       | 2/3             | drift: noticed (`start_utc` missing), but the fallback agent got HTTP 503 from the free tier (provider)       |
| bank-reconciliation | ❌        | ✅        | ❌       | 1/3             | the flash-lite recording left out the total (-297.5), so same data and the drift recovery repeat that gap     |
| **Total**           | **10/11** | **11/11** | **6/11** | **27/33 (82%)** |                                                                                                               |

New data: **11 of 11** replays correct, 1–4 s where the agent took 8–128 s (two outliers: weekly-report 22 s and
two-places 37 s, slow free-tier model calls). Every drift was noticed; the failures are in recovery (the fallback agent
or the free tier), which Hotpath does not do itself. One drift run (meeting-times) is a provider failure (503) and one
(long-report) had a 429 in it. Same-data failures come from the recording (bank-reconciliation).

Comparison with the last runs: 67 of 90 (74%) on 2026-11-15 (flash-lite, 3 passes, ten tasks, code before the
read-retry, pagination and length fixes) and 53 of 99 (54%) on 2026-11-16 (qwen3:1.7b doing everything). Not
like-for-like: one pass here.

**qwen3:1.7b suite (2026-11-18): not reported.** A first attempt was invalid (the fallback agent could not start:
`pnpm` was not on PATH, so every drift failed at once); the second was stopped in its third pass at the owner's
request, to stop loading the local GPU, before it printed its totals. The false-fallback measurement above is the qwen
result for this task.

### Claude confirmation (2026-11-18, code 99b4c27, owner's yes, cap $0.50)

The three tasks whose behaviour this work changed, replayed by Haiku 5.5 on new data from the same healthy recordings
as the qwen measurement (`bench:measure --runs 10 --scenarios new-data`, `--no-fallback`, so the Sonnet agent was never
called). Prices from the project table (Haiku $0.10 / $0.50 per 1M).

| Task          | Run id   | Correct  | Stops | Wall p50 / p95  | Tokens in / out (mean) | Cost (10 runs) |
| ------------- | -------- | -------- | ----- | --------------- | ---------------------- | -------------- |
| meeting-times | 2d3a6163 | 10 of 10 | 0     | 2.89 s / 3.79 s | 504 / 263              | $0.002         |
| weekly-report | caf8c3c9 | 10 of 10 | 0     | 8.23 s / 8.57 s | 2,391 / 1,590          | $0.010         |
| two-places    | 00abf6c8 | 10 of 10 | 0     | 5.54 s / 6.05 s | 761 / 629              | $0.004         |

**30 of 30 correct, 0 false fallbacks, about $0.016 in all** (36,562 in / 24,818 out tokens). Every weekly-report text
names issue 315 by its title under mobile-app (the misplaced bare numbers were qwen3:1.7b's). Ten runs per task: a
confirmation, not a rate.

## Opus 5.5 morning brief, real cost per run (2026-11-21)

Run: `hotpath demo` plus replays on new days, `HOTPATH_REUSE=0`, fresh home (`out/opus-home`). Task `morning-brief`,
synthetic demo data. Agent (recording) and replay on Claude Opus 5.5; a second line replays on Haiku 5.5.
Costs = the CLI's token counts at list prices (Opus $4/$20 per 1M in/out; Haiku $0.10/$0.50).

- Opus 5.5 agent, 3 recordings: $0.0358, $0.0372, $0.0382 (mean $0.0371), 3 model calls each.
- Opus 5.5 replay, 6 runs (1 demo + 5 new days 2026-10-05..09): $0.0151 demo; $0.0138 to $0.0194 on new days (mean $0.0176), 1 model call each.
- Haiku 5.5 replay, 5 new days: $0.0006 to $0.0008 (mean $0.00068), 1 model call each.
- All 14 replays passed the workflow's check; 0 fallbacks.

Ratios from these means: Opus agent / Opus replay about 2.1x; Opus agent / Haiku replay about 55x. Small sample: one
task, one workflow, 3 recordings. Raw summary: `company/gtm/social/RESULTS-opus-morning-brief-2026-11-21.md` (in the
hotpath repo).
