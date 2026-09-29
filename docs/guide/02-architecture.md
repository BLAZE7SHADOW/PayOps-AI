# 02 · Architecture

## The big picture

```
Browser (React)  ── REST + Socket.IO ──►  API server (Express)  ──►  Postgres
                                              │   ▲                    (business data,
                                              │   │                     job queue,
                                              ▼   │                     graph checkpoints)
                                     pg-boss job queue
                                              │
                                              ▼
                             Agent runner (LangGraph graph)
                                   │             │
                                   ▼             ▼
                       Core services         Model ports
                (policy, executor, validator)  (Gemini, Jev, or recorded replay)
```

There is one server process and one database. There is no Redis and no separate worker: the job queue (pg-boss) and the graph checkpoints live in the same Postgres as the business data.

## The packages (a pnpm monorepo)

| Package | Job | Depends on |
|---|---|---|
| `apps/web` | The operator UI: React 19, Vite, TanStack Query, Tailwind, Radix | shared |
| `apps/server` | REST API, auth, live events, job workers, seeding | core, agents, simulator, shared |
| `packages/agents` | The LangGraph investigation graph, its nodes, tools and prompts | core, shared |
| `packages/core` | The domain: services, policy, executor, validator, database schema, ports and adapters | shared |
| `packages/shared` | Types, enums and constants used by web and server (money helpers, action catalog, policy table) | none |
| `packages/simulator` | Creates fake payments with a chosen fault, resets and undoes demo data | core, shared |
| `packages/evals` | Runs golden scenarios and scores the agent | agents, core |

Rule of thumb: `core` knows nothing about LangGraph or the web. `agents` uses `core` but is not used by it. This keeps the money-touching code testable without any AI.

## Ports and adapters (why AI can be swapped out)

Anything outside the domain sits behind a small interface (a "port") in `packages/core/src/ports`:

| Port | What it hides | Real adapter | Other adapters |
|---|---|---|---|
| `LlmPort` | The big reasoning model | Gemini through LangChain | recording, replay |
| `DecisionPort` | The small classification model | Jev through the TypeSafe SDK | recording, replay |
| `GatewayPort` | The payment gateway | Simulator gateway | (Razorpay planned) |
| `ClockPort` | "What time is it" | System clock | Fixed clock for tests |
| `EventsPort` | Live updates to browsers | Socket.IO | Test collector |

`AI_MODE` picks the adapters: `LIVE` calls the providers, `RECORD` calls them and saves every answer, `REPLAY` serves saved answers with no network. The product also works with AI off, because detection, policy, execution and verification never needed a model.

## How a request travels

**Starting an investigation.** The browser posts to `/api/cases/:id/runs`. The route creates an `agent_runs` row and puts a job on the pg-boss queue, then returns 202 straight away. A worker picks the job up and calls `investigateAgentRun`, which builds the graph and runs it. Progress events are written to `agent_steps` and pushed to the browser over Socket.IO, so the case page fills in live.

**Pausing for approval.** When policy needs a person, the graph calls LangGraph's `interrupt`. The full state is saved by the Postgres checkpointer and the run stops. Nothing is held in memory, so a server restart does not lose it. When someone approves, a second job (`agent-resume`) calls the graph again with a `Command({ resume })` and it continues exactly where it stopped.

**Live updates.** The server publishes events to rooms (`ops`, or one room per case). The web app's socket handler updates TanStack Query caches so lists and pages refresh without polling.

## Where data lives

| Data | Tables (see `packages/core/src/db/schema`) |
|---|---|
| Fake gateway | `gw_payments`, `gw_refunds`, `gw_webhook_deliveries`, `gw_settlement_lines` |
| Our own records | `orders`, `payments`, `payment_attempts`, `refunds`, `ledger_entries`, `settlements` |
| Ops work | `cases`, `resolutions`, `approvals`, `executions`, `validation_results`, `disputes`, `audit_events` |
| Agent runs | `agent_runs`, `agent_steps`, `agent_findings`, `evidence` |
| Job queue names | `reconcile-sweep`, `agent-run`, `agent-resume` (pg-boss) |
| Graph memory | the `checkpoints` schema created by LangGraph's Postgres saver |
| Job queue | the `pgboss` schema |

Money is always an integer in paise (`amountMinor`), never a decimal, and only code does arithmetic on it.

## Auth in one paragraph

Passwords are hashed with scrypt. A sign-in sets one httpOnly cookie holding a signed token that lasts 8 hours. Roles decide what each screen and API route allows. Demo mode adds one-click demo accounts.
