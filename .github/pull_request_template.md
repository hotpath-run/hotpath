## What and why

<!-- One focused change. What does it do, and why? -->

## Checks

- [ ] `pnpm -r build && pnpm -r test && pnpm lint` pass
- [ ] Tests added or updated for every behaviour change (none skipped, deleted or weakened)
- [ ] No real model call in tests; no API key, trace or workflow with private data in the diff
- [ ] No new runtime dependency (or: why it is needed)
- [ ] Docs and `CHANGELOG.md` updated if behaviour changed
