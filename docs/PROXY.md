# The model proxy: one line to put Hotpath in

`hotpath proxy` is an HTTP server that speaks the OpenAI Chat Completions and the
Anthropic Messages APIs. An agent points its model base URL at it and changes nothing
else: not its tools, not its loop, not its framework.

```bash
hotpath proxy --openai http://localhost:11434/v1 --read-only get_orders
```

```ts
const client = new OpenAI({ baseURL: "http://127.0.0.1:8787/v1", apiKey }); // the one line
// Anthropic SDK: new Anthropic({ baseURL: "http://127.0.0.1:8787", apiKey })
```

- **Every conversation is recorded** as a trace of the usual format (SPEC §5.1) under
  `traces/<task>/`. `hotpath compile <task>` compiles it like an MCP recording.
- **A conversation that matches a compiled workflow is answered from it.** The proxy
  replies to each model turn with the workflow's next tool call, with today's
  arguments, without calling the model. The agent runs the tool as usual and sends the
  result back; the runtime's guards check it before the next step. At an AI step the
  proxy calls the real model with the workflow's short prompt (the agent's own
  provider, key and model). When the workflow is done it answers `Done.`.
- **On drift** (a guard fails, the agent sends something other than the tool result,
  any error) the proxy forwards the agent's request to the model as the agent sent
  it. The model sees the whole conversation, including the tool calls the replay made
  and their results, and finishes the task. That conversation is recorded, so the
  next compile learns the new situation.
- **The agent's key** goes through on each request (`Authorization` or `x-api-key`) and
  is never written: not in traces, prompts, logs or error messages (a test checks all
  four). A replay keeps it in memory for its own AI steps until the conversation ends.

## Options

| Flag                  | Default                     | What it does                                                     |
| --------------------- | --------------------------- | ---------------------------------------------------------------- |
| `--port`              | `8787`                      | Port to listen on                                                |
| `--host`              | `127.0.0.1`                 | Only `127.0.0.1`, `localhost` or `::1`: the proxy sees every key |
| `--openai <url>`      | `https://api.openai.com/v1` | Where Chat Completions requests go (`HOTPATH_PROXY_OPENAI`)      |
| `--anthropic <url>`   | `https://api.anthropic.com` | Where Messages requests go (`HOTPATH_PROXY_ANTHROPIC`)           |
| `--read-only <tools>` | none                        | Tools that only read. The others are actions: never run twice    |
| `--record-only`       | off                         | Record, never answer from a workflow                             |

Request headers, all optional and never sent upstream:

| Header                     | What it does                                                   |
| -------------------------- | -------------------------------------------------------------- |
| `x-hotpath-task: <name>`   | The task this conversation is. Without it, the proxy names it  |
|                            | `proxy-<hash>` after the prompt, with today's inputs taken out |
| `x-hotpath-inputs: {json}` | The inputs. Without it, they are inferred (below)              |
| `x-hotpath-read-only: a,b` | Like `--read-only`, for this conversation                      |
| `x-hotpath-off: 1`         | Pass this request through untouched                            |

Every answer carries `x-hotpath: replay` (Hotpath answered) or `x-hotpath: forward`
(the model did). `GET /hotpath/stats` returns the counters: requests, turns served by
Hotpath, requests forwarded, AI-step model calls, replays started, finished and handed
over, traces written.

## Inputs without configuration

A recorded conversation's inputs are the argument values the model passed to a tool
that also appear, on their own, in what the agent was asked: "Send the daily orders
report for 2026-10-01" plus `get_orders(date="2026-10-01")` gives the input
`date`. The user message is searched first; the system prompt only when the user
message holds none (it is mostly fixed instructions). Values the model read from a
tool result are not inputs.

Next to each trace, `<time>.prompt.json` keeps the system prompt and first user
message with each input replaced by `{{inputs.<name>}}`. A new conversation is matched
against these templates; the values in the placeholders are today's inputs. So a
conversation is replayed when its prompt has the recorded shape and only the inputs
differ. Anything else is recorded instead.

## How the APIs carry tool calls (research notes, 2026-11-18)

- **OpenAI Chat Completions** (`POST /v1/chat/completions`). The model asks for tools in
  `choices[0].message.tool_calls[]` (`id`, `function.name`, `function.arguments` as a
  JSON string), `finish_reason: "tool_calls"`. The agent sends each result as a
  `{role: "tool", tool_call_id, content}` message in the next request, after the
  assistant message that asked. There is no error flag on a result. Streaming
  (`stream: true`) sends `data: {chunk}` lines: `delta.content` text, and
  `delta.tool_calls[]` pieces keyed by `index` (the `id` and name in the first piece,
  the arguments in fragments), then a chunk with `finish_reason` and `data: [DONE]`;
  `stream_options.include_usage` adds a last chunk with usage. Parallel tool calls come
  in one message.
- **OpenAI Responses API** (`POST /v1/responses`). Tool calls are `function_call` output
  items (`call_id`, `name`, `arguments`), results go back as `function_call_output`
  input items, and the conversation can live on OpenAI's side
  (`previous_response_id`), so a request may not carry the history at all. It also
  runs built-in tools (web search, file search, code interpreter) on OpenAI's side.
  **Not handled yet:** requests to it are passed through untouched and not recorded.
- **Anthropic Messages** (`POST /v1/messages`). The model asks with `tool_use` content
  blocks (`id`, `name`, `input` as an object), `stop_reason: "tool_use"`. The agent
  answers in the next user turn with `tool_result` blocks (`tool_use_id`, `content`
  as text or blocks, optional `is_error`), placed before any text. `system` is a
  top-level field. Streaming sends named events: `message_start`,
  `content_block_start` (a `text` or `tool_use` block), `content_block_delta`
  (`text_delta`, or `input_json_delta` with `partial_json` fragments),
  `content_block_stop`, `message_delta` (with `stop_reason`), `message_stop`.

## What the proxy cannot see or do

- **The real tool result.** It sees only what the agent sends the model. An agent that
  cuts, summarises or reformats results gives the guards that text (the same text the
  model would have had). A result the agent sends as plain text is kept as text.
- **Whether a tool only reads.** The APIs carry no such mark. Without `--read-only`,
  every tool is treated as an action: compiled as a side effect, never repeated after
  drift. Forgetting the mark costs a less flexible workflow, never a repeated send.
- **Tools that run on the provider's side** (web search, code execution, MCP connectors
  run by the provider, the Responses API's built-in tools). Their calls and results
  never pass through the agent's requests, so they are not recorded and cannot be
  replayed.
- **Running a tool.** The proxy never calls a tool; the agent does, on its own word as
  before. That is why replay works through a proxy at all: Hotpath plays the model's
  part, the agent keeps playing its own.
- **The final answer text.** Workflows compile tool calls and the text sent through
  them. A replay ends with `Done.`, not with a rewritten version of the model's
  closing message. Agents whose output is the final message itself (no tool sends
  it) are recorded but not served.
- **Never a repeated action.** After a handover in a conversation where the replay
  already had an action run, the proxy asks the model without streaming, removes any
  tool call that repeats that action with the same arguments, and tells the agent so
  in text (re-streamed if the agent asked for a stream).
- **Conversations are told apart** by the tool call ids they carry, and before the
  first tool call by their first messages. Two identical conversations started at the
  same moment, before either has a tool call, can be confused.
- **One tool call per turn on replay.** The workflow's steps run one at a time, so the
  proxy asks for one tool per reply even where the recorded model asked for several.

## Measured

See `docs/BENCHMARK.md`, "Model proxy". Run it yourself, free, on a local model:

```bash
pnpm --filter proxy-agent bench -- --model qwen3.5:4b
```
