# Security Policy

## Supported versions

Hotpath is early-stage. Only the **latest release** (and the latest commit on `main`) is supported: fixes land there, and older versions do not get patches.

## Reporting a vulnerability

Please report vulnerabilities **privately**, not in a public issue or pull request.

Use GitHub's private reporting: open the repository's **Security** tab, choose **Advisories**, and click **Report a vulnerability**. This creates a private advisory that only the maintainers can see.

Please include:

- what the problem is and which part of Hotpath it affects (recorder, compiler, runtime, proxy, viewer, CLI);
- steps or a minimal example to reproduce it, and the version you tested;
- the impact you expect, for example code execution, leaking secrets, or sending a message twice.

Do not include real API keys or private data in a report; redact traces and workflows first (they can contain tool results).

The maintainers will acknowledge the report, work on a fix in private, and credit the reporter in the advisory unless they prefer to stay anonymous. Response times are best effort.

## Scope and design notes

- **Secrets** are read only from environment variables (`.env`, which is gitignored) and are never logged or committed. The proxy passes the agent's key through on each request and never writes it down.
- **Process execution:** other programs are started from an argument list, never through a shell, and input names are validated, so input values cannot be interpreted as shell syntax.
- **Traces and workflows** (`traces/`, `workflows/`) contain the data returned by the tools you record. Treat them as sensitive and do not publish them without reviewing them. `hotpath forget <task>` deletes everything stored for a task.
- **Task names** are used as file names and are checked wherever they become a path, so a name such as `../x` is refused.
- **A workflow file names the command that is started as the MCP server.** Read a workflow you did not compile yourself before running it.
- The proxy listens on loopback only, because it sees every key that passes through it.
- The full review, with what is fixed and what is still open, is in [`docs/SECURITY-REVIEW.md`](docs/SECURITY-REVIEW.md).
- The demo tools never touch the real world: `send_message` writes to a local file.
