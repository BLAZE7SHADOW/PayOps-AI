# 02 · System Architecture

> **pnpm on this machine.** Plain `pnpm` does not work here. Run every `pnpm ...` command in this file as `npx pnpm@10.28.0 ...` (for example `npx pnpm@10.28.0 db:migrate`). To keep typing `pnpm`, add `alias pnpm='npx pnpm@10.28.0'` to `~/.zshrc` and open a new terminal. In Claude's cloud shell `pnpm` is also missing: call `node_modules/.bin/vitest` and `node_modules/.bin/tsc` directly.

## 1. Shape

Monorepo, TypeScript everywhere. **Two runnable apps** (web, server) and a few packages. **One database** (Postgres on Supabase) holds business data, the job queue and LangGraph checkpoints. No Redis, no separate worker process.

Hexagonal: the domain core depends on **ports** (interfaces); **adapters** implement them. The agent system is a client of the domain core, not part of it.

```
          ┌──────────── apps/web (React + Vite) ─────────────┐
          │  TanStack Query (REST)     Socket.IO client       │
          └────────────┬───────────────────────┬─────────────┘
                       │ REST /api/*           │ websocket
          ┌────────────▼───────────────────────▼─────────────────────────┐
          │ apps/server (one Node process)                                │
          │  Express routes · Socket.IO · pg-boss workers                 │
          │  jobs: agent-run · agent-resume · reconcile-sweep             │
          └──────┬──────────────────────────────┬────────────────────────┘
                 │ uses                          │ runs graphs
          ┌──────▼──────── packages/core ───────┐ ┌──▼──── packages/agents ─────────┐
          │ Drizzle schema + domain services     │ │ LangGraph graph, nodes, tools,  │
          │ detection · policy · executor ·      │ │ context builders, Jev questions │
          │ validator · audit · ports/ adapters/ │ │ (calls core services via tools) │
          └──────┬───────────────────────────────┘ └──┬─────────────────────────────┘
                 │                                     │
          ┌──────▼─────────────────────────────────────▼──────┐
          │ Postgres (Supabase in the cloud · PGlite locally)  │
          │  public.*      business + ops tables (Drizzle)     │
          │  pgboss.*      job queue                           │
          │  checkpoints   LangGraph PostgresSaver             │
          └────────────────────────────────────────────────────┘
```

Why one process: the workload is small, and one process means one deploy, in-process Socket.IO (no Redis adapter), and simpler debugging. Jobs still go through pg-boss so agent runs never block HTTP requests and survive restarts. If it ever needs to scale, the same code can run a second process with `ROLE=worker`.

## 2. Repository layout

```
payops-ai/
├─ CLAUDE.md                 session bootstrap (read first)
├─ AGENTS.md                 pointer for non-Claude coding agents
├─ docs/                     source of truth (this folder)
├─ apps/
│  ├─ web/                   React 19 + Vite + TS
│  │  └─ src/{app,routes,features/<feature>/{api,components,hooks},ui,styles,lib}
│  └─ server/                Express 5 + Socket.IO + pg-boss
│     └─ src/{routes,middleware,socket,jobs,scripts,main.ts,app.ts}
├─ packages/
│  ├─ shared/                Zod schemas, enums, DTO types, action catalog, money utils, event names
│  ├─ core/                  Drizzle schema + migrations, domain services, detection, policy, executor, validator, ports, adapters
│  ├─ agents/                LangGraph graph, nodes, state, context builders, prompts, tools, grounding, Jev questions
│  ├─ simulator/             seeded scenario generators, fault injection, fake gateway writes
│  └─ evals/                 golden scenarios + runner + report
├─ fixtures/cassettes/       recorded LLM/Jev responses for REPLAY
├─ scripts/                  local-db (PGlite server)
├─ .env.example
└─ package.json / pnpm-workspace.yaml / tsconfig.base.json
```

Dependency direction (lint-enforced): `shared ← core ← agents ← server`, `simulator → core`, `shared ← web`. `core` never imports `agents`. `web` never imports `core`.

## 3. Ports and adapters

```ts
// packages/core/src/ports/
PaymentGatewayPort   getPayment, listByOrder, listWebhookDeliveries, listRefunds, listSettlementLines,
                     createRefund, replayWebhook                  (writes arrive in Phase 2)
LlmPort              invokeStructured<T>(schema, messages, meta) → { data: T, usage }
DecisionPort         ask(state, questions, tag) → typed answers   (Jev)
EventPublisherPort   publish(room, event, payload)
ClockPort            now()   (fixed in tests and simulator)
```

| Port | Adapters |
|---|---|
| PaymentGatewayPort | `SimulatorGatewayAdapter` (reads/writes `gw_*` tables, default) · `RazorpayTestAdapter` (stretch, Phase 6) |
| LlmPort | `GeminiLlmAdapter` · `RecordingLlmAdapter` · `ReplayLlmAdapter` |
| DecisionPort | `JevDecisionAdapter` (`@typesafe-ai/sdk`) · `RecordingDecisionAdapter` · `ReplayDecisionAdapter` |
| EventPublisherPort | `SocketIoPublisher` (in-process) · `NoopPublisher` (tests) |

Adapters are wired once in a composition root (`packages/core/src/container.ts`).

### Two worlds, deliberately separate

- **External world** (what a real gateway/bank owns): `gw_payments`, `gw_refunds`, `gw_webhook_deliveries`, `gw_settlement_lines`. Only the gateway adapter and the simulator touch these.
- **Internal world** (our systems): `orders`, `payments`, `ledger_entries`, `refunds`, `settlements`, …

Reconciliation compares the two. This is what makes the problem real and lets a Razorpay adapter drop in later.

## 4. Key flows

### 4.1 Scenario → case
```
POST /api/simulator/scenarios {scenario, seed}
 → simulator writes gw_* + internal rows (with the injected fault)
 → detection runs for the touched orders/batches (and every 60s via the reconcile-sweep job)
 → rule hits → CaseService.openOrUpdate(fingerprint)  (one open case per fingerprint, enforced by a partial unique index)
 → socket "case.created" to room "ops"
```

### 4.2 Investigation (Phase 3+)
```
POST /api/cases/:id/runs (OPS+) → insert agent_run, boss.send('agent-run') → 202 {runId}
pg-boss worker → graph.invoke(initialState, {configurable: {thread_id: runId}})
 → events to room case:<id>
 → interrupt at awaitApproval → run AWAITING_APPROVAL, approval row created, job completes
POST /api/approvals/:id/decision → role + four-eyes check → boss.send('agent-resume')
worker → graph.invoke(new Command({resume}), {configurable: {thread_id}}) → execute → validate → (replan) → end
```

### 4.3 Manual resolution (Phase 2)
```
POST /api/cases/:id/actions {actions[]} → same policy → same approval → same executor → same validator
```

## 5. API surface

| Method | Path | Role | Phase |
|---|---|---|---|
| GET | /api/health | – | 0 |
| GET | /api/overview | VIEWER | 1 |
| GET | /api/payments?q&gatewayStatus&orderStatus&mismatchOnly&cursor&limit | VIEWER | 1 |
| GET | /api/payments/:id | VIEWER | 1 |
| GET | /api/cases?scope&status&type&severity&cursor&limit | VIEWER | 1 |
| GET | /api/cases/:id | VIEWER | 1 |
| GET | /api/simulator/scenarios · POST /api/simulator/scenarios · POST /api/simulator/reset | ADMIN (OPS when DEMO_MODE) | 1 |
| GET | /api/audit?entityId&caseId&cursor | VIEWER | 1 |
| GET | /api/webhooks?status&event&gwPaymentId&cursor | VIEWER | P3 |
| GET | /api/webhooks/counts, /api/webhooks/:id | VIEWER | P3 |
| POST | /api/webhooks/:id/replay | OPS | P3 |
| POST | /api/auth/login · /logout · GET /api/auth/me · GET /api/auth/demo-accounts | – | 2 |
| POST | /api/cases/:id/actions | OPS | 2 |
| GET | /api/approvals?status · POST /api/approvals/:id/decision | OPS / MANAGER | 2 |
| GET | /api/policy | VIEWER | 2 |
| POST | /api/cases/:id/runs · GET /api/runs · /api/runs/:id · /api/runs/:id/steps | OPS / VIEWER | 3 |

Conventions: Zod-validated input (schemas from `shared`), keyset cursor pagination (`{items, nextCursor}`), errors `{ error: { code, message, details?, requestId } }`, `x-request-id` on every response.

## 6. Cross-cutting

- **Database access:** Drizzle ORM over `pg` (node-postgres). Schema in `packages/core/src/db/schema/*`, SQL migrations generated by drizzle-kit into `packages/core/drizzle/`, applied by `pnpm db:migrate` and on server start.
- **Transactions:** multi-row writes (ledger postings, executor steps, case updates + audit) run in `db.transaction`. Inside a transaction, only the `tx` handle is used.
- **Integrity in the database:** primary keys, foreign keys where ownership is clear, `unique(idempotency_key)`, partial unique index for one open case per fingerprint, check constraints on money (`amount_minor >= 0`).
- **Money:** `bigint` columns in `mode: 'number'` (safe integers), always paise, `*_minor` names. Formatting only in `shared/money.ts`.
- **Time:** `timestamptz`, UTC. Services take `now` from `ClockPort`.
- **IDs:** prefixed text ids (`pay_…`, `ord_…`, `case_…`). Case display ids `PAY-0042`.
- **Auth (Phase 2):** own JWT in an httpOnly cookie, roles `VIEWER < OPS < MANAGER < ADMIN`, seeded demo users. We do not use Supabase Auth or RLS; the server is the only database client.
- **Audit:** state changes write `audit_events` in the same transaction.
- **Logging:** pino JSON with `requestId, caseId, runId, node`.
- **Config:** Zod-parsed env in `core/config/env.ts`; the server fails fast on bad config.

## 7. Environment variables

| Var | Notes |
|---|---|
| `NODE_ENV`, `PORT`, `WEB_ORIGIN` | |
| `DATABASE_URL` | Supabase **session pooler** or direct connection string (port 5432). Not the transaction pooler (6543): pg-boss and LangGraph need session features. Local: `postgres://postgres:postgres@127.0.0.1:54329/postgres` from `pnpm db:local`. |
| `JWT_SECRET` | required in production |
| `AI_MODE` | `LIVE` · `RECORD` · `REPLAY` (default REPLAY) |
| `AI_PROVIDER`, `AI_MODEL`, `GEMINI_API_KEY` | already set in `.env` |
| `TYPESAFE_JEV_API_KEY`, `JEV_MODEL` | key already set; pin the model |
| `GATEWAY_ADAPTER` | `simulator` (default) · `razorpay` |
| `RECONCILE_SWEEP_MS` | 0 disables the sweep |
| `DEMO_MODE` | lets OPS use the simulator |
| `VITE_API_URL` | web, optional (dev uses Vite proxy) |

## 8. Local development

Two ways to get a database, no Docker needed:

1. `pnpm db:local` starts **PGlite** (Postgres compiled to WASM) on port 54329 with data in `.data/pglite`. Zero install. Good for development and tests.
2. Point `DATABASE_URL` at your Supabase project.

Then `pnpm db:migrate && pnpm dev`. Tests start their own throwaway PGlite instance.

PGlite serialises transactions across connections, so code must never wait on a second connection while holding a transaction (also good practice on real Postgres).

## 9. Deployment (Phase 6)

| Piece | Where |
|---|---|
| web | Vercel |
| server | Render or Railway (one Docker service) |
| database | Supabase free tier |

Public deployment runs `AI_MODE=REPLAY` and a nightly `reset` job.

## 10. Tech choices (locked)

React 19, Vite 7, TypeScript 5.9 strict, React Router 7, TanStack Query 5, Zustand (UI state only), Tailwind v4 with our own tokens, Radix UI primitives, Recharts restyled, Socket.IO, Express 5, Drizzle ORM + drizzle-kit, pg, pg-boss, Zod 4, pino, LangGraph JS + `@langchain/langgraph-checkpoint-postgres`, LangChain JS + `@langchain/google-genai`, `@typesafe-ai/sdk`, PGlite (local + tests), Vitest, Playwright, pnpm workspaces, Node 22.

Not used, on purpose: MongoDB, Redis, BullMQ, separate worker service, Supabase Auth/RLS, Kafka, Kubernetes, microservices, vector DB, MCP, Context.dev, Next.js, Redux, shadcn default styling, lucide icons.
