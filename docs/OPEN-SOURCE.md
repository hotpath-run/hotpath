# What is open, what is paid, and why

**The rule:** what makes one developer say "wow" on their laptop is open. What a team needs to trust it in production, across many agents and people, is paid. We sell the production layer, not the engine.

## Open source (Apache-2.0)

Everything in this repository: `@hotpathrun/cli`, `recorder`, `compiler`, `runtime`, `sdk`, `shared`, `viewer`, `proxy`, `learn`, `scheduler`, plus `examples/`, `bench/` and `docs/`.

| Part                                                              | Where                                                 |
| ----------------------------------------------------------------- | ----------------------------------------------------- |
| Recorder (MCP), SDK recorder, model proxy                         | `packages/recorder`, `packages/sdk`, `packages/proxy` |
| Compiler, runtime, guards, dry runs, drift detection and fallback | `packages/compiler`, `packages/runtime`               |
| Auto-compile on one machine (`hotpath learn` over local traces)   | `packages/learn`                                      |
| Local scheduler and run history                                   | `packages/scheduler`                                  |
| Workflow viewer                                                   | `packages/viewer`                                     |
| Benchmarks, examples, docs                                        | `bench/`, `examples/`, `docs/`                        |

There is no licence key, no usage limit and no telemetry. The engine sends nothing to us; the only network calls are to the model provider you configure.

## Paid, not part of this repository

A hosted team layer. **It is not available yet.**

- **Fleet auto-compile:** collects runs from every instance and machine, finds hot paths across all of them, and promotes them after a shadow check and an approval step.
- **Hosted proxy for production:** always on, several providers with your own keys, spending caps, failover.
- **Tool-change monitoring:** notices a tool changing shape across the fleet, alerts in Slack or email, recompiles with approval.
- **Team dashboard:** hit rate, savings, false fallbacks, every workflow as a graph with live numbers.
- **Audit and compliance:** signed run records, retention rules, export, SSO/SAML, roles, EU hosting.
- **A shared library of compiled paths** for common tools.

## Why open the engine

1. **Trust.** Hotpath sits between an agent and its tools, in the request path. You should be able to read what runs there.
2. **Adoption without a sales process.** Install it, it works on a free local model, bring it to your team.
3. **Developer infrastructure that is closed is hard to adopt.** Its neighbours are open.

## Why people will still pay

The money is in production, not on the laptop. A company running an agent 100,000 times a month needs fleet learning, alerts, audit and single sign-on, and building those costs more than buying them. The price will follow the savings: free locally, and for teams priced below the model cost the product removes.

## What could change

If someone hosts the open engine as a competing service, the hosted-proxy code may move to a source-available licence in future. A released version stays under the licence it was released with, and the engine in this repository stays Apache-2.0.

## Contributing and the paid layer

Contributions are accepted under Apache-2.0 (see [`CONTRIBUTING.md`](../CONTRIBUTING.md)). A change whose job belongs to the paid layer (fleet services, billing, dashboards) is out of scope here. The formats the layer builds on, for example the trace format in [`SPEC.md`](SPEC.md), are public.
