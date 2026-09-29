# 06 · File map

Grouped by responsibility. The LangGraph and LangChain files are marked **[LangGraph]** and **[LangChain]**.

## Agents: `packages/agents/src`

| File | Responsibility |
|---|---|
| `graph.ts` **[LangGraph]** | Builds the graph: nodes, edges, conditional routing, parallel `Send` fan-out, compile with the checkpointer |
| `state.ts` **[LangGraph]** | The shared state (`Annotation.Root`) and the reducers that merge parallel branches |
| `nodes.ts` **[LangGraph]** | Every node's logic (`loadCase` to `closeEscalated`), the budget guard hook, `interrupt` for approval |
| `run.ts` **[LangGraph]** | Starts and resumes a run: `graph.invoke`, `Command({ resume })`, Postgres checkpointer, syncs results to the database |
| `store.ts` | Writes `agent_runs`, `agent_steps`, evidence and findings; step event sink |
| `tools.ts` | The 15 read-only tools (plain functions), grouped payment / reconciliation / risk |
| `context.ts` | Builds each agent's prompt context and trims it to a token budget |
| `schemas.ts` | Zod schemas for what Gemini must return (follow-up tools, findings, diagnosis) |
| `planning.ts` | Which specialists to run (J2 result to a list) |
| `risk.ts`, `risk.weights.ts` | Turns numbers into a risk score for J3, all in code |
| `grounding.ts`, `grounding/predicates.ts` | Checks each finding against its cited evidence; decides on an extra round |
| `templates.ts`, `proposal.ts` | Maps root cause to actions and builds the proposal, in code |
| `budget-guard.ts` | Tool-call and cost limits |
| `brief.ts`, `deps.ts`, `run-ids.ts`, `index.ts` | Case brief, dependency bundle, ids, exports |
| `scripts/record-cassettes.ts` | Records real model answers into cassettes |

## Domain core: `packages/core/src`

| Folder | Responsibility |
|---|---|
| `adapters/llm/gemini-llm.adapter.ts` **[LangChain]** | The only real Gemini call: `ChatGoogleGenerativeAI.withStructuredOutput` |
| `adapters/llm/` (others) | Recording and replay versions of the LLM port |
| `adapters/decision/` | Jev (real), recording and replay versions of the decision port |
| `adapters/cassette.ts` | Cassette format, key hashing, reader with the D054 fallback |
| `adapters/gateway/` | The simulated payment gateway |
| `ports/` | Interfaces: LLM, decision, gateway, clock, events |
| `reconciliation/` | Detection rules D1 to D8, the state matrix, snapshots of a payment across systems |
| `policy/` | Rules P0 to P11 and risk tier |
| `actions/` | The nine action handlers, preconditions and postconditions, idempotency keys, option drafting |
| `execution/executor.service.ts` | Runs approved actions once |
| `validation/validator.service.ts` | Post-execution checks and verdict |
| `services/` | Business services: cases, resolutions, approvals, audit, payments, orders, refunds, ledger, overview, signal intake (J1) |
| `db/` | Drizzle schema, migrations, client, retry |
| `config/env.ts`, `container.ts` | Environment parsing and wiring everything together |

## Shared: `packages/shared/src`

`actions.ts` (the nine actions), `agents.ts` (agent types, decision tags, budget limits), `policy.ts` (policy table and thresholds), `enums.ts`, `scenarios.ts`, `money.ts`, `events.ts`, `ids.ts`, `dto/` (API shapes).

## Server: `apps/server/src`

| File or folder | Responsibility |
|---|---|
| `main.ts` | Starts everything: database, migrations, jobs, HTTP, sockets, shutdown |
| `app.ts` | Express app and middleware |
| `routes/` | One file per area: cases (incl. start investigation), approvals, payments, overview, policy, runs, audit, simulator, auth |
| `jobs/boss.ts`, `jobs/agents.ts`, `jobs/reconcile.ts` | The queue, the agent-run and agent-resume workers, the one-minute reconcile sweep |
| `realtime/socket.ts` | Socket.IO rooms and event publishing |
| `auth/` | Sessions, passwords, role checks, demo users |
| `scripts/seed.ts` | Migrate and seed demo data |

## Simulator: `packages/simulator/src`

`scenarios/` (one file per fault), `world.ts` (base merchants and customers), `noise.ts` (healthy background payments), `index.ts` (generate and reset), `undo.ts` (snapshot and restore).

## Web: `apps/web/src`

`app/` (shell, router, nav), `features/` (overview, payments, exceptions, cases, investigation, resolution, approvals, runs, audit, policy, simulator, landing, auth), `ui/` (small shared components), `lib/` (API client, socket, formatting, permissions, query keys).

## Evals: `packages/evals`

`golden.ts` (the scenarios and expectations), `runner.ts` (runs them), `report.ts` (writes the markdown report).

## If you only have time for five files

1. `packages/agents/src/graph.ts` — the whole flow on one page
2. `packages/agents/src/nodes.ts` — what each step really does
3. `packages/core/src/policy/rules.ts` — who may do what
4. `packages/core/src/execution/executor.service.ts` and `validation/validator.service.ts` — act once, then verify
5. `packages/core/src/adapters/cassette.ts` — how replay works
