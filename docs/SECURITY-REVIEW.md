# Security and privacy review

Reviewed 2026-11-15 against the code on branch `agent-tasks-work` (based on `81d9852`).
One person read the code; nothing here was tested by an outside party. Each finding is
marked **fixed** (with the test that proves it) or **open** (with the reason and the plan).

To report a problem, see `SECURITY.md`.

## 1. What Hotpath holds

| Asset                     | Where                                                                                                                                             | Why it matters                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Model provider key        | `.env` (`LLM_API_KEY`), process environment                                                                                                       | Whoever has it spends the customer's money                       |
| Tool data                 | `traces/<task>/*.jsonl`, `workflows/<task>.json` (the AI step's example and guard values), `.hotpath/answers/<task>.json`, `out/hotpath-run.json` | Emails, documents, tickets: whatever the recorded tools returned |
| Agent configs             | The agent's own MCP config (edited by `wrap`), `.hotpath/wrap-backups/`                                                                           | Often hold tokens for the MCP servers                            |
| The right to act          | Side-effect steps (`send_message`, …) in a workflow                                                                                               | A replay really sends, posts or deletes                          |
| Schedules and run history | `.hotpath/schedules.json`, `.hotpath/runs.jsonl`                                                                                                  | Task names, times, costs; no tool data                           |

Everything is plain JSON in the project folder. Nothing is sent anywhere except: the AI
step's prompt (tool data included) to the configured model provider, tool calls to the
MCP server, and, when the user sets one, a webhook notification (`.hotpath/config.json`).
There is no telemetry.

## 2. Who can influence what

| Entry point                                 | Who controls it                                                                       | What it can reach                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Tool results (live and recorded)            | Anyone who can write to the tool's data: an email sender, a web page, a ticket author | The AI step's prompt, guard checks, conditions, tool arguments built from templates |
| Trace files                                 | Whoever can write to `traces/`                                                        | The compiled workflow: steps, arguments, the server command                         |
| Workflow files                              | Whoever can write to `workflows/`                                                     | Which command is started as the MCP server, which tools run with which arguments    |
| `hotpath.config.json`                       | Whoever can write to the project folder                                               | The agent command run on a fallback                                                 |
| Agent MCP configs                           | The user, `hotpath wrap`                                                              | Which server is recorded, under which task name                                     |
| Command-line arguments and `HOTPATH_INPUTS` | The user, a scheduler, an agent that starts the recorder                              | Task names (file paths), input names (agent flags), input values                    |

The project folder is trusted: someone who can edit `workflows/*.json` or
`hotpath.config.json` can already run commands as the user (finding 6). Tool results are
**not** trusted.

## 3. Findings

### 1. Task names were used as file paths unchecked — fixed

`--task ../../x` (or a trace or workflow file naming such a task) made the recorder,
compiler, runtime and scheduler read and write outside `traces/`, `workflows/` and
`.hotpath/answers/`. Only `hotpath wrap` checked the name.

Fix: one rule in `packages/shared/src/task-name.ts` (`assertTaskName`): no path
separators, no `:*?"<>|` or control characters, no leading `.` or `-`, no trailing space
or `.`, no Windows device names, at most 100 characters. Spaces and non-ASCII letters
stay allowed. It runs wherever a name becomes a path (`TraceWriter`, `latestTraceFile`,
`loadWorkflow`, `saveWorkflow`, the answer store, `addSchedule`, `forget`), and the trace
and workflow schemas refuse such a name when a file is read.

Tests: `packages/shared/test/task-name.test.ts`, `packages/compiler/test/security.test.ts`,
`packages/recorder/test/log.test.ts` (trace writer), `packages/cli/test/forget.test.ts`.

### 2. `.env` was written with the default file mode — fixed

`hotpath init` created `.env` readable by every user of the machine on Linux and macOS
(mode 644 under the usual umask). It is now written and re-set to mode 600. No effect on
Windows, where the file inherits the folder's access list.

Test: `packages/cli/test/setup.test.ts` ("readable by its owner only"; skipped on Windows).

### 3. The recorder logged the server's full command line — fixed

The recorder wrote `server=<command and all arguments>` to stderr, which agents keep in
their logs. Arguments can hold a token (`npx some-server --api-key …`). The log now shows
the command name and the number of arguments.

Test: `packages/recorder/test/log.test.ts`.

**Still open, same root:** the arguments are stored in the trace (`meta.server`,
`meta.serverArgv`) and in the workflow, because the replay needs them to start the
server. A token passed as an argument therefore sits in those files in plain text.
"Pass tokens to MCP servers through `env`, not arguments" is now in
`docs/INTEGRATIONS.md`. Plan: have
`hotpath doctor` warn when a wrapped server's arguments look like a secret. Not done
yet because it needs a decision on what "looks like a secret" means.

### 4. No way to delete a task's data — fixed

`hotpath forget <task>` lists and, after a yes (or `--yes`), deletes the task's
recordings, workflow and its backups, saved answers, schedules and run-history lines,
and the last run's metrics file. `--dry-run` only lists. Other tasks are untouched, also
ones whose name starts the same way.

Test: `packages/cli/test/forget.test.ts`.

Not covered: the wrapped agent keeps recording new traces until `hotpath unwrap`; the
command says so. Files already copied elsewhere (backups, a pilot report) are out of reach.

### 5. Can a tool result change what the replay does? — checked, limits stated

What a malicious tool result (an email that says "ignore your instructions and …")
**cannot** do in a replay:

- add, remove or reorder steps, or choose a tool: the steps are fixed in the workflow;
- make a template pull in other data: text that comes from a tool is never expanded
  again, so `{{inputs.x}}` inside an email stays that literal text
  (test: `packages/shared/test/template.test.ts`, "does not expand templates found in data");
- reach a shell: servers and agents are started from argument lists.

What it **can** do:

- **change the text the AI step writes**, and that text is then an argument of the next
  action (the message that gets sent). The grounding and stale-fact guards check that
  today's values are mentioned and yesterday's are not; they do not check that nothing
  else was added. This is the same exposure as the agent itself, with a smaller model
  that may be easier to steer.
- **flip an `ask` condition** (a step some recordings made and others did not, decided
  by a yes/no question to the model): a tool result can talk the model into yes or no
  for a step that exists in the workflow.
- **trigger a fallback** by breaking a guard, which runs the full agent on the same
  poisoned data.

**(a) Done 2026-11-16: link guard.** An AI step's text that contains a link or an email
address found in none of the run's data and not in the recorded example is drift
(`foreignAddresses` in `packages/runtime/src/checks.ts`, tests in `checks.test.ts`;
`HOTPATH_LINK_GUARD=0` turns it off). It catches the usual exfiltration shape ("see
https://evil.example/?q=<the figures>"). Limit: a link that is itself in a tool result
passes, since the guard cannot tell a tool's own link from a planted one.

Also done: the tool server no longer inherits Hotpath's model keys (`LLM_API_KEY` and the
other `HOTPATH_SECRETS`, `toolServerEnv` in runtime.ts): a recorded server is someone
else's code.

**(b) Still open, a product decision:** for workflows with an action step, require a dry
run and a human yes when an `ask` condition decides an action.

### 6. Workflow and config files are commands — accepted, documented

`workflows/<task>.json` names the command that is started as the MCP server (`server`,
`serverArgv`, `cwd`), and `hotpath.config.json` names the agent command. Both are run
without a shell, so a value cannot inject a second command, but the command itself is
whatever the file says. Treat a workflow file from someone else like a script from
someone else: read it (`hotpath show <task>`, and the `server` line in the JSON) before
running it. Plan: when workflows can be shared (Hub, Cloud), sign them or strip the
server command and take it from local config.

### 7. Stored data is not encrypted and has no retention limit — mostly done (2026-11-16)

Traces, workflows and saved answers stay until deleted. `forget` (finding 4) deletes per
task; there is no automatic expiry and no redaction at record time.
Done: `HOTPATH_RETAIN_DAYS=N` (opt-in, off by default) deletes a task's traces older than
N days whenever its workflow is saved, never the trace the workflow was compiled from
(`packages/compiler/src/retention.ts`, tested). Off by default because deleting recordings
changes what a later compile can learn (branches).

Done: folders Hotpath creates for traces, workflows, saved answers, the crash journal and
schedules are created with mode 700, and trace and journal files with 600, so other local
users on Linux and macOS cannot read them. Only new folders get the mode: an existing
install keeps its folders (`chmod -R go-rwx traces workflows .hotpath` fixes one). Windows
ignores the mode; the user profile's ACLs apply.

Open: redaction of chosen fields at record time. Encryption at rest is left to the disk
(BitLocker, FileVault, LUKS): a key next to the data would add little.

### 8. The viewer — checked

`hotpath view` serves the workflow on `127.0.0.1` only, read-only, from Vite 8, whose
default CORS rule allows only localhost origins. The workflow JSON it serves contains
the recorded example text. Acceptable for a local tool; do not expose the port.

### 9. Key handling — checked

- The key is read from the environment or `.env` in `packages/shared/src/llm.ts` only.
- `hotpath init` asks for it without echo and never logs it (existing test: "never
  echoes or logs the key"); `hotpath doctor` prints "key set (not shown)".
- No code path prints request headers. Provider error messages are passed on as text;
  the OpenAI SDK does not put the key in them.
- `--api-key` on the command line lands in shell history; the help text says to type it
  when asked instead.

### 10. Side effects — checked

- A dry run skips side-effect steps; scheduled runs dry-run them until the schedule is
  added with `--allow-side-effects`.
- After a side effect ran, drift never triggers the agent (it would act twice).
- A recompile after a fallback is refused when it lost read or action steps.
- Done 2026-11-16, crash journal (`packages/runtime/src/journal.ts`): every action of a
  run is written down as started, then done, per task and inputs. A run killed between
  two actions and run again with the same inputs does not repeat the finished one; an
  action that started and never confirmed (killed mid-call, or the tool answered with an
  error) stops the rerun with a message to check it first. A step marked `repeatable`
  is done again. Tests: `crash-safety.test.ts`. `hotpath forget` deletes the journal.
  Limit: a task without inputs has one key for every run, so an unconfirmed action
  blocks its next runs until someone deletes `.hotpath/journal/<task>`.
- Open: an idempotency value passed to tools that accept one (`idempotencyKey` exists in
  journal.ts; no demo tool takes it yet).

### 11. Hosted mode: local processes and SSRF — done for tools (2026-11-16)

With `HOTPATH_HOSTED=1` the runtime never starts a local program: a workflow whose
`server` is a command is refused with a message, and only an `https://` MCP endpoint is
allowed (`packages/runtime/src/tool-backends.ts`). The fallback agent, also a local
command, is not started either: drift stops the run. Every remote tool call goes through
`guardedFetch` (`egress.ts`): https only, no credentials in the URL, the address
checked **when the socket connects** (private, loopback, link-local, CGNAT, multicast,
documentation, cloud metadata 169.254.169.254 and fd00:ec2::254, IPv4-mapped and NAT64
forms), so DNS rebinding is refused too; every redirect hop is checked again (at most 3);
30 s and 10 MB per call. The same URL rules apply outside hosted mode to an `https://`
server in a workflow file. No new dependency (Node's `https` with a checking `lookup`).
Not built: the same rules for a customer's model endpoint (BYOK) and the key vault.

## 4. Summary

| #   | Finding                                        | Status                                |
| --- | ---------------------------------------------- | ------------------------------------- |
| 1   | Task names as file paths                       | Fixed                                 |
| 2   | `.env` file mode                               | Fixed                                 |
| 3   | Server arguments in the recorder log           | Fixed (log); open (stored in traces)  |
| 4   | Deleting a task's data                         | Fixed (`hotpath forget`)              |
| 5   | Prompt injection through tool data             | Link guard done; (b) open (decision)  |
| 6   | Workflow and config files are commands         | Accepted, documented                  |
| 7   | No encryption, retention or private file modes | Retention, modes done; redaction open |
| 8   | Viewer                                         | Checked                               |
| 9   | Key handling                                   | Checked                               |
| 10  | Side effects and reruns                        | Crash journal done; tool keys open    |
| 11  | Hosted mode: local processes, SSRF             | Done for tools; model endpoint open   |
