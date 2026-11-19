# Contributing to Hotpath

Thanks for your interest. Hotpath is early, so the most useful contributions are bug reports, small focused fixes, new benchmark tasks, and docs that fix a place where you got stuck.

By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE). Please read the [Code of Conduct](CODE_OF_CONDUCT.md). What is open and what is not: [`docs/OPEN-SOURCE.md`](docs/OPEN-SOURCE.md).

## Setup

You need Node 22+ and pnpm 9+.

```bash
git clone <this repository> && cd hotpath
pnpm install
cp .env.example .env   # only for the demo agent and `pnpm bench`
```

Never commit `.env` or paste an API key into code, logs or issues. Secrets come only from environment variables.

To try your change as the installed command: `pnpm hotpath <command>` runs the CLI from source.

## Running the checks

```bash
pnpm -r build     # type-check every package (TypeScript strict, ESM only)
pnpm -r test      # vitest, no API key needed
pnpm lint         # eslint + prettier --check
```

Run `build` before `test`: the demo-agent tests start the demo tools from their built `dist`. All three must pass before you open a PR. To fix formatting: `pnpm exec prettier --write .`

Tests must **not** call a real model. Mock `packages/shared/src/llm.ts` (see `packages/runtime/test/` for examples). Only `pnpm bench` and `examples/demo-agent` make real calls, and all model access goes through `llm.ts`.

## Pull requests

- One focused change per PR. Describe what it does and why.
- Tests first when practical: write the failing vitest test, then the code. A behaviour change comes with a test.
- Never skip, delete or weaken a test to get green.
- No new runtime dependency without a one-line justification in the PR description.
- Open an issue first for anything large or when the design is unclear.
- Commit messages: a short, descriptive summary.
- Packages are published as `@hotpathrun/*`. Import one package from another by that name, never by a relative path.

## Code style

- Small pure functions; side effects at the edges (CLI, MCP I/O, file I/O).
- Types for every public function; shared types and schemas live in `packages/shared`.
- Errors are typed and say what to do next.
- Comments explain _why_, not _what_.
- Never start a command through a shell: use an argument array (`cross-spawn`).
- Demo tools never touch the real world.

## Reporting bugs and requesting features

Use the issue templates. For a bug, include the command you ran, what you expected, what happened, your OS and Node version, and the relevant trace or workflow if you can share it (remove anything private first). Report security problems privately: see [`SECURITY.md`](SECURITY.md).
