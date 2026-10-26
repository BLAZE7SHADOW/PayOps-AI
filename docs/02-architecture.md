# 02 · System Architecture

> **Backend moved to Python (D090).** Paths in this file were updated; the map below is for reading old commits and decisions. The last TypeScript commit is the tag `ts-backend-final` (`git show ts-backend-final:<path>`).
>
> | Was | Now |
> |---|---|
> | `apps/server` (Express routes, auth, Socket.IO, pg-boss) | `python/payops/src/payops/api`, `auth`, `jobs`, `realtime.py` (FastAPI, python-socketio, Procrastinate) |
> | `packages/core` (domain, services, executor, validator, adapters, Drizzle schema) | `payops/domain`, `services`, `services/writes`, `infra`, `db` (SQLAlchemy models, Alembic) |
> | `packages/agents` and `python/agents` as a service | `python/agents/src/payops_agents` (the graph) and `payops/agent_tools` (tools, run store, in-process node API) |
> | `packages/simulator` | `payops/simulator` |
> | `packages/evals` | `payops/evals` (`pnpm eval`) |
> | `/internal/agent/*`, `AGENT_RUNTIME`, `AGENT_INTERNAL_SECRET` | removed: agents call the services in process |
> | Drizzle migrations | `python/payops/migrations` (SQL `0000` to `0012` kept as `migrations/sql`, then Alembic revisions) |
> | `.env` read in `env.ts` | `payops/settings.py` |


> **pnpm on this machine.** Plain `pnpm` does not work here. Run every `pnpm ...` command in this file as `npx pnpm@10.28.0 ...`, or add `alias pnpm='npx pnpm@10.28.0'` to `~/.zshrc`.

## 1. Shape

Two runnable parts: the **web app** (`apps/web`, TypeScript) and **one Python backend process** (`python/payops`, with the agent graph from `python/agents` running inside it). **One database** (Postgres on Supabase) holds business data, the job queue and LangGraph checkpoints. No Redis, no separate worker service.

Hexagonal: the domain core depends on **ports** (interfaces); **adapters** implement them. The agent system is a client of the domain core, not part of it.

```
          ┌──────────── apps/web (React + Vite) ─────────────┐
          │  TanStack Query (REST)     Socket.IO client       │
          └────────────┬───────────────────────┬─────────────┘
                       │ REST /api/*           │ websocket /socket.io
          ┌────────────▼───────────────────────▼─────────────────────────┐
          │ python/payops (one process: uvicorn + FastAPI)                │
          │  routers · python-socketio · Procrastinate worker             │
          │  jobs: agent_run · agent_resume · webhook_retry · reconcile   │
          └──────┬──────────────────────────────┬────────────────────────┘
                 │ uses                          │ runs graphs
          ┌──────▼──── services, domain ────────┐ ┌──▼──── python/agents ───────────┐
          │ SQLAlchemy models + services        │ │ LangGraph graph, nodes, context │
          │ detection · policy · executor ·     │ │ builders, Jev questions         │
          │ validator · audit · ports/infra     │ │ (reach services through         │
          │                                     │ │  agent_tools / InProcessNodeApi)│
          └──────┬──────────────────────────────┘ └──┬──────────────────────────────┘
                 │                                    │
          ┌──────▼────────────────────────────────────▼──────┐
          │ Postgres (Supabase in the cloud · pgserver locally)│
          │  public.*       business + ops tables (Alembic)   │
          │  procrastinate_* job queue                        │
          │  checkpoints_py LangGraph Postgres saver          │
          └───────────────────────────────────────────────────┘
```

Why one process: the workload is small, and one process means one deploy, in-process Socket.IO (no Redis adapter) and simpler debugging. Jobs still go through the queue so agent runs never block HTTP requests and survive restarts. The worker sleeps until Postgres NOTIFY wakes it, which keeps an idle API nearly silent on the network (D083, D089).

## 2. Repository layout

```
payops-ai/
├─ CLAUDE.md                 session bootstrap (read first)
├─ docs/                     source of truth (this folder)
├─ apps/web/                 React 19 + Vite + TS
│  └─ src/{app,routes,features/<feature>/{api,components,hooks},ui,styles,lib}
├─ packages/shared/          Zod schemas, enums, DTO types, permissions, money utils for the web app
├─ python/
│  ├─ payops/                the backend (uv project)
│  │  ├─ src/payops/
│  │  │  ├─ api/             FastAPI app, routes/{read,write,auth,simulator,ops}, session middleware, socket, startup
│  │  │  ├─ domain/          pure logic: money, policy, actions, reconciliation, validation, audit hash, permissions
│  │  │  ├─ services/        read services; services/writes: orders, ledger, refunds, cases, executor, resolutions, approvals
│  │  │  ├─ infra/           gateway adapter, snapshot loader, audit store
│  │  │  ├─ db/              engine, models, migrate, retry; migrations/ (Alembic) in the project root
│  │  │  ├─ auth/            passwords, TOTP, secret box, tokens, sessions, rate limit
│  │  │  ├─ jobs/            Procrastinate queue and the inline test queue
│  │  │  ├─ agent_tools/     tools, case brief, run store, in-process node API, runtime
│  │  │  ├─ simulator/       seeded scenario generators, fault injection
│  │  │  ├─ evals/           golden scenarios + runner (`python -m payops.evals`)
│  │  │  └─ dto/, settings.py, container.py (composition root), observability.py
│  │  ├─ migrations/         Alembic: sql/ (0000 to 0012 as before), versions/
│  │  └─ tests/              pytest, with committed recordings in tests/fixtures and tests/contract
│  └─ agents/                `payops_agents`: graph, nodes, state, context, prompts, grounding, Jev questions, cassette adapters
├─ fixtures/cassettes/       recorded LLM/Jev responses for REPLAY
├─ render.yaml, vercel.json  hosting (see DEPLOY.md)
└─ package.json / pnpm-workspace.yaml
```

Dependency direction: `domain` imports nothing from `services`, `api` or `agents`; `payops_agents` never imports `payops` (it reaches the backend through the `NodeApiPort` interface, implemented by `InProcessNodeApi`); `web` imports only `packages/shared`.

## 3. Ports and adapters

```python
# payops/domain/gateway.py, payops/ports.py (Clock, EventPublisher), payops_agents/ports.py (LlmPort, DecisionPort)
PaymentGateway    get_payment, list_by_order, list_webhook_deliveries, list_refunds, list_settlement_lines,
                  create_refund, replay_webhook, set_webhook_sink
LlmPort           invoke_structured(schema, messages, meta) -> (data, usage)
DecisionPort      ask(state, questions, tag) -> typed answers      (Jev)
EventPublisher    publish(room, event, payload)                    (realtime.py has OpsEvents)
Clock             now()   (fixed in tests and the simulator)
```

| Port | Adapters |
|---|---|
| PaymentGateway | `SimulatorGateway` (reads and writes `gw_*` tables, own connection pool) |
| LlmPort | `GeminiLlm`, `RecordingLlm`, `ReplayLlm` (`payops_agents/ports.py`, `cassette.py`) |
| DecisionPort | `JevDecision` (REST call to `api.typesafe.ai`), `RecordingDecision`, `ReplayDecision` |
| EventPublisher | `OpsEvents` over python-socketio (in-process), `NoopPublisher` (tests) |

Adapters are wired once in the composition root, `payops/container.py` (`build_services`).

### Two worlds, deliberately separate

- **External world** (what a real gateway or bank owns): `gw_payments`, `gw_refunds`, `gw_webhook_deliveries`, `gw_settlement_lines`. Only the gateway adapter and the simulator touch these.
- **Internal world** (our systems): `orders`, `payments`, `ledger_entries`, `refunds`, `settlements`, and so on.

Reconciliation compares the two. This is what makes the problem real and lets a Razorpay adapter drop in later.

## 4. Key flows

### 4.1 Scenario to case
```
POST /api/simulator/scenarios {scenario, seed}
 -> simulator writes gw_* + internal rows (with the injected fault)
 -> detection runs for the touched orders and batches (and periodically if RECONCILE_SWEEP_MS > 0)
 -> rule hits -> CaseService.open_or_update(fingerprint)  (one open case per fingerprint, partial unique index)
 -> socket "case.created" to room "ops"
```

### 4.2 Investigation
```
POST /api/cases/{id}/runs (OPS+) -> insert agent_run, queue.agent_run -> 202 {runId}
worker -> graph.ainvoke(initial_state, config={"configurable": {"thread_id": run_id}})
 -> events to room case:<id>
 -> interrupt at await_approval -> run AWAITING_APPROVAL, approval row created, job completes
POST /api/approvals/{id}/decision -> role + four-eyes check -> queue.agent_resume
worker -> graph.ainvoke(Command(resume=...), thread_id) -> execute -> validate -> (replan) -> end
```
The run start and resume calls are idempotent: a finished or running thread returns its status.

### 4.3 Manual resolution
```
POST /api/cases/{id}/actions {actions[]} -> same policy -> same approval -> same executor -> same validator
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
| GET | /api/audit/verify | MANAGER | P4 |
| GET | /api/audit/export.csv?caseId&entityId | MANAGER | P4 |
| GET | /api/webhooks?status&event&gwPaymentId&cursor | VIEWER | P3 |
| GET | /api/webhooks/counts, /api/webhooks/:id | VIEWER | P3 |
| POST | /api/webhooks/:id/replay | OPS | P3 |
| POST | /api/auth/login · /logout · GET /api/auth/me · GET /api/auth/demo-accounts | – | 2 |
| POST | /api/cases/:id/actions | OPS | 2 |
| GET | /api/approvals?status · POST /api/approvals/:id/decision | OPS / MANAGER | 2 |
| GET | /api/policy | VIEWER | 2 |
| POST | /api/cases/:id/runs · GET /api/runs · /api/runs/:id · /api/runs/:id/steps | OPS / VIEWER | 3 |

Conventions: Pydantic-validated input (`payops/dto`), keyset cursor pagination (`{items, nextCursor}`), errors `{ error: { code, message, details?, requestId } }`, `x-request-id` on every response.

## 6. Cross-cutting

- **Database access:** SQLAlchemy 2 async over psycopg 3. Models in `payops/db/models.py`; migrations are Alembic revisions (`0001` applies the original SQL files `0000` to `0012` unchanged, including the audit hash-chain triggers). They run on start (`MIGRATE_ON_START`) and with `alembic upgrade head`.
- **Transactions:** multi-row writes (ledger postings, executor steps, case updates plus audit) run in one `engine.transaction(...)` block that hands the services an `AsyncSession`. Serialization failures retry (`db/retry.py`). Simulated gateway reads use a separate pool so a request never waits on a second connection from its own pool (D089).
- **Integrity in the database:** primary keys, foreign keys where ownership is clear, `unique(idempotency_key)`, a partial unique index for one open case per fingerprint, check constraints on money (`amount_minor >= 0`).
- **Money:** `bigint` columns, always paise, `*_minor` names. Formatting only in `domain/money.py` (and `shared/money.ts` for the web).
- **Time:** `timestamptz`, UTC. Services take `now` from the `Clock`.
- **IDs:** prefixed text ids (`pay_...`, `ord_...`, `case_...`). Case display ids `PAY-0042`.
- **Auth:** own HS256 JWT in an httpOnly cookie plus a `sessions` row, scrypt password hashes, TOTP MFA with sealed secrets, a database rate limiter, and a JSON-only rule for state-changing requests. Roles `VIEWER < OPS < MANAGER < ADMIN`, seeded demo users. We do not use Supabase Auth or RLS; the backend is the only database client.
- **Audit:** state changes write `audit_events` in the same transaction, hash-chained.
- **Logging:** JSON lines with `requestId` (`observability.py`).
- **Config:** typed `pydantic-settings` in `payops/settings.py`; the process fails fast on bad config.

### Roles and permissions

Roles rank `VIEWER < OPS < MANAGER < ADMIN`; a permission names the lowest role that has it. The table lives in `python/payops/src/payops/domain/permissions.py` (the web copy is `packages/shared/src/permissions.ts`) and is the only place a role is compared. Routes use `require_permission(key)`, services use `has_permission(role, key)` and the UI uses `hasPermission(role, key)` from `packages/shared`. A test fails if a route has no guard (or an explicit `publicRoute()` marker) and if this table drifts from the code. Routes with no sign-in: health, login, MFA code step, demo login, logout, `me`, demo accounts.

<!-- permissions:start -->
| Permission | Lowest role | What it allows | Extra rule |
|---|---|---|---|
| `overview.view` | VIEWER | See the Overview metrics | - |
| `payment.view` | VIEWER | List payments and open a payment | - |
| `case.view` | VIEWER | List cases, open a case, its notes and source records | - |
| `run.view` | VIEWER | See agent runs, steps and feedback | - |
| `approval.view` | VIEWER | See the approval queue and one approval | - |
| `audit.view` | VIEWER | Read the audit log | - |
| `audit.verify` | MANAGER | Check the audit log for tampering and export it as CSV | - |
| `policy.view` | VIEWER | Read the policy rules | - |
| `webhook.view` | VIEWER | Read the webhook event log | - |
| `agent.view` | VIEWER | See agent controls | - |
| `handoff.view` | VIEWER | Read the shift handoff summary | - |
| `view.manage` | VIEWER | Save and delete your own saved views | Own views only |
| `account.security` | VIEWER | Manage your own MFA and signed-in browsers | Own account only |
| `case.assign` | OPS | Take a case or hand it back | The assignee must be OPS or above |
| `case.note` | OPS | Write a case note | - |
| `run.start` | OPS | Start an agent investigation on a case | - |
| `run.feedback` | OPS | Mark a diagnosis right or wrong | - |
| `resolution.propose` | OPS | Preview and propose a resolution | Policy decides the tier |
| `resolution.undo` | OPS | Propose an undo of a ledger post | Goes through the normal approval |
| `webhook.replay` | OPS | Replay a webhook event | - |
| `approval.decide` | OPS | Approve or reject a resolution | MANAGER-tier approvals need MANAGER or ADMIN. Four-eyes: never your own proposal |
| `approval.bulk` | OPS | Bulk approve low-risk approvals | Same tier and four-eyes rules per item |
| `agent.control` | MANAGER | Pause or limit the agent | - |
| `simulator.use` | ADMIN | Use the simulator: scenarios, reset, undo reset | OPS when DEMO_MODE is on |
| `user.mfaReset` | ADMIN | Reset another user's MFA | - |
| `user.sessionsRevoke` | ADMIN | Sign a user out of every browser | - |
<!-- permissions:end -->

## 7. Environment variables

| Var | Notes |
|---|---|
| `NODE_ENV`, `PORT`, `WEB_ORIGIN` | |
| `DATABASE_URL` | Supabase **session pooler** (port 5432), letters and digits in the password. Not the transaction pooler (6543): the queue and LangGraph need session features. Local: the URL `pnpm db:local` prints. |
| `JWT_SECRET` | required in production, 16+ characters |
| `AI_MODE` | `LIVE` · `RECORD` · `REPLAY` (default REPLAY) |
| `AI_PROVIDER`, `AI_MODEL`, `GEMINI_API_KEY` | live and record only |
| `TYPESAFE_JEV_API_KEY`, `JEV_MODEL` | live and record only |
| `RECONCILE_SWEEP_MS` | 0 disables the periodic sweep |
| `JOB_POLL_SECONDS`, `GATEWAY_POOL_MAX`, `DATABASE_POOL_MAX`, `CHECKPOINTER`, `MIGRATE_ON_START`, `JOBS` | see `docs/OPERATIONS.md` |
| `DEMO_MODE` | lets OPS use the simulator |
| `VITE_API_URL` | web, optional (dev uses the Vite proxy) |

## 8. Local development

No Docker needed. `pnpm db:local` starts a local Postgres (`pgserver`, data in `~/.payops-devdb`) and prints its `DATABASE_URL`; put it in `.env`, or point `DATABASE_URL` at Supabase. Then `pnpm dev` runs the API on :4000 (it migrates and creates the demo users on start) and the web app on :5173. Use **Reset demo data** in the Simulator to load the demo cases.

Tests start their own throwaway Postgres (`pgserver`), clone a migrated template database per test, and use `JOBS=inline` and `CHECKPOINTER=memory`.

## 9. Deployment

| Piece | Where |
|---|---|
| web | Vercel |
| backend | Render, one Python web service from `render.yaml` |
| database | Supabase free tier |

The public demo runs `AI_MODE=REPLAY`. Steps and rollback are in `docs/DEPLOY.md`.

## 10. Tech choices (locked)

**Web:** React 19, Vite 7, TypeScript 5.9 strict, React Router 7, TanStack Query 5, Zustand (UI state only), Tailwind v4 with our own tokens, Radix UI primitives, Recharts restyled, Socket.IO client, Zod 4.

**Backend:** Python 3.12 with `uv`, FastAPI, SQLAlchemy 2 async, Alembic, psycopg 3, Pydantic v2, Procrastinate, python-socketio, LangGraph Python with the Postgres checkpointer, PyJWT and cryptography, pytest, ruff, pyright, `pgserver`.

Not used, on purpose: MongoDB, Redis, BullMQ, Celery, a separate worker service, Supabase Auth/RLS, Kafka, Kubernetes, microservices, vector DB, MCP, Context.dev, Next.js, Redux, shadcn default styling, lucide icons.
