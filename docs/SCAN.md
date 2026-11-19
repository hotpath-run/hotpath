# `hotpath scan`: what would Hotpath save on the traces you already have?

```
hotpath scan <file-or-folder> [--json] [--html report.html] [--days N] [--hot-after N]
                              [--price model=in/out] [--run-cost USD]
```

Point it at a trace export (or a folder of them). It tells you, in plain language:

- how many runs followed a path that repeats (a **path** is the ordered list of tools a run called);
- the **estimated hit rate**: the share of runs on paths that repeated cleanly at least 3 times;
- the **top repeated paths** (tool sequence, run count);
- the model tokens and cost those runs used;
- an **estimated monthly saving**.

You need no Hotpath install in your agent and no API key. The scan makes no model call.

## Privacy

- The scan **runs on your machine and sends nothing anywhere**. It has no network code.
- **Tool argument values never appear in the report.** The report holds tool names, argument names, kinds
  ("a value the agent chose", "a value an earlier tool returned") and counts. Trace and run ids are not printed.
- Tool _names_ are shown. If a tool name is itself sensitive, rename it in the export before sharing the HTML.
- The HTML report is one file with inline CSS and no script, font or image loaded from the web.
- Tests cover this: a fixture with a recognisable email in every argument must not appear in the text, JSON or HTML.

## Formats it reads

| Source                    | File                                                                          | What it uses                                                                                                                                                                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenTelemetry GenAI spans | OTLP JSON (`.json`, or `.jsonl` with one export per line)                     | `execute_tool` spans: `gen_ai.tool.name`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`; model spans: `gen_ai.usage.input_tokens` / `output_tokens`, `gen_ai.request.model` / `gen_ai.response.model`; failure = span status error or `error.type`. A run is one trace id. |
| LangSmith                 | JSON list of runs (or `{"runs": [...]}`)                                      | `run_type: "tool"` runs as calls (`name`, `inputs`, `outputs`, `error`); `run_type: "llm"` runs for `prompt_tokens`, `completion_tokens`, `total_cost`. A run is one `trace_id`.                                                                                                     |
| Langfuse                  | `{"data": [...]}` of traces with observations, or a flat list of observations | `TOOL` observations as calls (`name`, `input`, `output`, `level: "ERROR"`); `GENERATION` observations for `usageDetails`, `costDetails` / `totalCost`, `model`. A run is one trace id.                                                                                               |
| Hotpath's own traces      | `.jsonl` from `hotpath record` (folder or file)                               | The tool calls. They carry no token counts: pass `--run-cost`.                                                                                                                                                                                                                       |

The format is found from the contents, not the file name. A file that cannot be read is skipped and named at the end.

## Export steps

These steps come from each tool's public docs (checked 2026-11-19). Where a doc did not confirm a detail, it says so.

### OpenTelemetry (OTLP JSON)

1. Instrument the agent with a GenAI instrumentation that follows the
   [GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai) (the page on
   opentelemetry.io now points there). Tool calls are `execute_tool` spans.
2. **Tool arguments and results are opt-in** in those conventions, and most instrumentations only record them when you
   switch content capture on (see your instrumentation's docs for the flag). Without them the scan still groups
   runs by tool names, but it cannot tell a loop over a list from separate paths, so the hit rate reads low.
3. Export to a file. With the OpenTelemetry Collector, add the `file` exporter to a traces pipeline:
   ```yaml
   exporters:
     file:
       path: ./traces.jsonl
   service:
     pipelines:
       traces:
         receivers: [otlp]
         exporters: [file]
   ```
   The file holds one OTLP JSON document per line; `hotpath scan traces.jsonl` reads it as is.
   Any other route that gives you OTLP JSON (`{"resourceSpans": [...]}`) works too.

### LangSmith

1. Use the SDK's `runs.query` (the older `list_runs` is deprecated). It looks back **one day** unless you set
   `min_start_time`, so set it:
   ```python
   import asyncio, json
   from datetime import datetime, timedelta, timezone
   from langsmith import Client

   async def main():
       client = Client()
       project_id = str(client.read_project(project_name="<your_project>").id)
       since = datetime.now(timezone.utc) - timedelta(days=7)
       rows = []
       for run_type in ("TOOL", "LLM"):
           async for run in client.runs.query(
               project_ids=[project_id],
               min_start_time=since,
               run_type=run_type,
               selects=["ID", "NAME", "RUN_TYPE", "START_TIME", "TRACE_ID", "INPUTS", "OUTPUTS"],
           ):
               rows.append(json.loads(run.json()))
       json.dump(rows, open("langsmith-runs.json", "w"), default=str)

   asyncio.run(main())
   ```
2. `selects` names documented by LangSmith: `ID`, `NAME`, `RUN_TYPE`, `START_TIME`, `TRACE_ID`, `INPUTS`, `OUTPUTS`.
   The scan also uses `error`, `end_time`, `parent_run_id`, `prompt_tokens`, `completion_tokens` and `total_cost`. The
   page we checked does not list their `selects` names: look them up in LangSmith's run data format reference and add
   them. Without `error` every run looks clean; without the token fields there is no cost.
3. For large volumes LangSmith recommends its Bulk Data Export instead. The page did not describe a UI export, so we
   do not give UI steps.

### Langfuse

1. Create an API key pair in your project settings. Use the public observations API with HTTP basic auth
   (`public-key:secret-key`) against your region's base URL, for example `https://cloud.langfuse.com`.
2. Fetch tool and model observations, bounded by time, with the `core,basic,io,usage` field groups:
   ```bash
   curl -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" \
     "https://cloud.langfuse.com/api/public/v2/observations?type=TOOL&fromStartTime=2026-11-01T00:00:00Z&fields=core,basic,io&limit=1000" \
     > tools-1.json
   curl -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" \
     "https://cloud.langfuse.com/api/public/v2/observations?type=GENERATION&fromStartTime=2026-11-01T00:00:00Z&fields=core,basic,usage&limit=1000" \
     > generations-1.json
   ```
3. Pagination is cursor-based: if `meta.cursor` is set, repeat the request with `&cursor=<value>` until it is
   `null` (pages can be empty while a cursor is still present). Put all the files in one folder.
   `hotpath scan ./langfuse-export` groups the observations by `traceId`.
4. The older `GET /api/public/traces` response (traces with their observations) is read too. Langfuse lists it as
   deprecated. The docs we checked did not describe a UI export button, so we give no UI steps.

## How the numbers are made

1. **Paths.** Each run gets the same path signature `hotpath learn` uses: tools in order, with argument names and where
   each value came from, ignoring the values. Runs with the same signature are one path.
2. **Compilable.** A path is compilable at **3 or more clean runs** (`--hot-after` changes the 3). A clean run finished
   and had no tool call that failed (a failed call the agent then repeated successfully counts as a retry). Runs
   with an error, runs that never finished and runs with no tool call are never counted as repeated.
3. **Hit rate.** Runs on compilable paths divided by all runs. That is the steady state. A second line gives the
   share served after the first 3 runs of each path (which still go to your agent to learn).
4. **Cost.** Per run: the cost the export reports; else tokens times the model's list price from `bench/src/price.ts`
   (Claude Opus/Sonnet/Haiku 5.5, DeepSeek, GPT-6 lines; copied into `packages/learn/src/scan/prices.ts`); else
   `--run-cost`. A model with no listed price is named in the report and left unpriced: give it with
   `--price gpt-4.1=2/8` (USD per 1M tokens, input/output).
5. **Monthly saving.** Cost of the compilable runs per day of traces, times 30, times (1 - replay share). The
   replay share is the measured replay-to-agent cost ratio from `docs/CLAIMS.md` (morning-brief on Claude, 2026-11-16):
   Haiku replay $0.0006 against a Sonnet agent run $0.0179 when nothing falls back (**3%**), and about $0.0023 when
   one run in ten falls back (**13%**). The report gives both ends as a range.
6. **Days.** From the first and last run in the traces; if they span under a day, one day is assumed and the report
   says so. Use `--days` when you know better.

## Limits (the report says all of these)

- Everything is an **estimate** from your traces. It is not a measurement of Hotpath on your agent.
- The cost ratio was measured on **two tasks** with a Sonnet agent and a Haiku replay (10 runs each). A cheaper
  agent model saves less; a dearer one saves more. A run that falls back to the agent costs more than one that does not.
- A compilable path is not a guarantee: whether it compiles and passes the shadow check is only known by running
  `hotpath learn`.
- Without tool results in the export, loops over a list can split one path into several, so the hit rate reads
  low, never high.
- Only tool calls make a path. A run whose work is all in the model's text has no path.
- Imported traces have no read-only/side-effect markings, so every tool is treated as one that changes something.
  That affects the signature text, not the counts.
