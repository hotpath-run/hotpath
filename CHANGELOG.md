# Changelog

All notable changes. Versions follow [semantic versioning](https://semver.org); before 1.0 a minor version may change behaviour, and the change is listed here.

## 0.2.0

First open-source release (Apache-2.0).

- Packages are published under the `@hotpathrun` scope: `cli` (the `hotpath` command), `sdk`, `proxy`, `recorder`, `compiler`, `runtime`, `learn`, `scheduler`, `viewer`, `shared`. They were called `hotpath-*` before.
- `hotpath demo`: one command that records the bundled demo agent 3 times, learns the repeated path and replays it on new data.
- `hotpath learn`: finds the paths an agent repeats in your local traces and compiles the hot ones, with a shadow check before a path goes live.
- `hotpath proxy`: point an agent's model base URL at Hotpath (OpenAI and Anthropic APIs); conversations are recorded and repeated ones are served from compiled paths.
- Reliability of the replay: fewer false fallbacks; totals, counts, currency and time-zone conversions recomputed by code; drift noticed in 8 of 8 tested kinds of change.
