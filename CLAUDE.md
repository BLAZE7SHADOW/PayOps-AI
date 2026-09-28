# PayOps AI · Session Guide

Read this file fully at the start of every session. Then read `docs/PROGRESS.md` to see where work stopped. Only open the other docs when the task touches them.

## What this project is

PayOps AI is a full-stack TypeScript payment-operations product (React, Node/Express, Postgres on Supabase). It detects payments where the gateway, order service, ledger, webhooks and settlement disagree, and resolves them. A LangGraph multi-agent system investigates cases, cites evidence, proposes a fix from a closed action catalog, pauses for human approval when policy requires it, executes through deterministic code, and verifies the outcome with an independent validator. If the fix fails, it replans (within limits) or escalates.

**The product must work with AI turned off.** The agent is one actor proposing actions; humans are the other. Both use the same catalog, policy, executor and validator.

Owner: Shivam (fresh B.Tech graduate). This is a portfolio project that should read as a real product, and he must be able to explain every part in interviews. Prefer clear code over clever code, and explain non-obvious choices in short comments or in `docs/DECISIONS.md`.

## Source of truth

| Doc | Read when |
|---|---|
| `docs/PROGRESS.md` | Every session, first |
| `docs/06-phases.md` | Planning or finishing any task |
| `docs/01-product.md` | Scenarios, users, scope |
| `docs/02-architecture.md` | Repo layout, ports/adapters, API, env, flows |
| `docs/03-agent-system.md` | Anything in `packages/agents`, policy, executor, validator, Jev, context, evidence |
| `docs/04-data-model.md` | Models, detection rules, state machines |
| `docs/05-ui-design.md` | **Any** UI work |
| `docs/DECISIONS.md` | Before changing an existing design choice |

If code and docs disagree, stop and ask Shivam. Do not silently "fix" either.

## Non-negotiable rules

1. **Stay in the current phase** (see `PROGRESS.md`). Things from later phases go to `PROGRESS.md › Later`, not into code.
2. **Models never touch the database.** LLMs and Jev see only context built by ContextBuilders from tool DTOs. Tools call domain services.
3. **Models never authorize or execute.** Agents propose from the closed action catalog (`packages/shared/src/actions.ts`). Policy (code) decides the tier; executor (code) acts; validator (code) verifies by re-reading the data.
4. **Models never do arithmetic or date math.** Code computes and passes results as facts. Money is integer paise (`amountMinor`), formatted only via `shared/money.ts`.
5. **Every finding cites evidence ids**, and grounding checks run before resolution.
6. **Every Jev decision point has a deterministic fallback.** Every LLM output is Zod-validated.
7. **Executor actions are idempotent** (idempotency key per action).
8. **Everything auditable:** state changes write `audit_events`; agent steps write `agent_steps`.
9. **Untrusted text** (customer/merchant notes) is screened (Jev J1) and never inserted into prompts unwrapped or when quarantined.
10. **Dependency direction:** `shared ← core ← agents ← server`, `simulator → core`, `shared ← web`. `core` never imports `agents`. `web` never imports `core`.

## Stack (locked; ask before adding dependencies)

pnpm workspaces · Node 22 · TypeScript strict · React 19 + Vite + React Router + TanStack Query + Zustand (UI state only) · Tailwind v4 with custom tokens · Radix UI primitives + `@radix-ui/react-icons` · Recharts (restyled) · Express 5 · Postgres (Supabase) via Drizzle ORM + `pg` · pg-boss (jobs in Postgres) · PGlite (local dev + tests) · Zod · Socket.IO (in-process) · pino · LangGraph JS + `@langchain/langgraph-checkpoint-postgres` · LangChain JS + `@langchain/google-genai` · `@typesafe-ai/sdk` (Jev) · Vitest · Playwright.

Do **not** add: MongoDB, Redis, BullMQ, a separate worker service, Supabase Auth/RLS, Next.js, Redux, Kafka, Kubernetes, microservices, vector DB, MCP, Context.dev, shadcn default styles, lucide-react, framer-motion, any icon pack with sparkles.

## AI configuration

- LLM: `AI_PROVIDER=gemini`, `AI_MODEL` (currently `gemini-3.6-flash`), key `GEMINI_API_KEY`. Access only through `LlmPort`.
- Jev (TypeSafe System One): key `TYPESAFE_JEV_API_KEY` (pass it explicitly to `new TypeSafeClient({ apiKey })`; the SDK default env name is different). Pin `JEV_MODEL`. Access only through `DecisionPort`. Docs: https://docs.typesafe.ai (API: `POST https://api.typesafe.ai/v1/systemone`, primitives Choice / Score / Noul, answers include probabilities and confidence).
- Jev is used at exactly five points (J1 intake, J2 plan, J3 risk, J4 grounding, J5 replan). Do not add more without a `DECISIONS.md` entry. Never ask Jev to count, compare numbers or order dates.
- `AI_MODE`: `LIVE` · `RECORD` · `REPLAY`. Tests and CI use `REPLAY`. Never call live APIs from unit tests.

## Secrets

`.env` exists at the repo root with real keys. **Never print, log, commit, echo or paste its values**, never `cat .env`. Read config only through each app's `env.ts`. Keep `.env.example` in sync (names only). `.env` must stay in `.gitignore`.

## UI rules (summary; full spec in `docs/05-ui-design.md`)

Internal ops tool, calm and dense. Warm paper background `#F5F2EA` (never pure white), ink text, single accent ledger green `#1E5A4C`, muted status colors. IBM Plex Sans + IBM Plex Mono (tabular numbers for money, ids, times). Radius 0–4px. Borders not shadows. No gradients, glass, orbs, dot grids, bento grids, emojis, sparkles, lucide, checkmark bullets, colored left stripes, neon, pastels, hover transforms, animated arrows, fake terminals, fake testimonials, pricing tiers. Skeleton loaders for every async surface. Copy: plain and specific, no em dashes, no "it's not X, it's Y", no hype words, AI features named by function ("Investigation", "Proposed resolution"). Only token colors, never raw hex in components.

## Commands (fill in as Phase 0 creates them)

```
pnpm db:local       # zero-install Postgres (PGlite) on :54329, or set DATABASE_URL to Supabase
pnpm db:migrate     # apply Drizzle migrations
pnpm db:generate    # generate a migration after changing packages/core/src/db/schema
pnpm dev            # server (API + jobs + sockets) + web
pnpm test           # vitest, all packages
pnpm typecheck
pnpm lint
pnpm eval           # evals in REPLAY (Phase 5)
pnpm jev:ping       # Jev smoke test (Phase 4)
```

## How to work in a session

1. Read this file and `docs/PROGRESS.md`. State the current phase and the next task before coding.
2. Plan the task briefly; for core logic (detection, policy, executor, validator, grounding, money) write tests first.
3. Implement in small steps; run `pnpm typecheck && pnpm test` for touched packages.
4. For UI work, check the result against `docs/05-ui-design.md` §8 and §9 before calling it done.
5. At the end: update `docs/PROGRESS.md` (done / in progress / next / blockers / notes for next session). Add design changes to `docs/DECISIONS.md`. Commit with a clear message.
6. Explain to Shivam in a few lines what was built and anything he should understand before the next session.

## Glossary

- **Case:** a detected inconsistency needing resolution. Display id `PAY-8291`.
- **Run:** one agent execution for a case; one LangGraph thread (`thread_id = runId`).
- **State matrix:** a payment's status as seen by Gateway, Order, Ledger, Webhook, Settlement.
- **Evidence item (`ev_xx`):** projected facts from one tool call. **Finding (`fd_xx`):** a typed claim citing evidence.
- **Tier:** policy outcome `AUTO | OPS | MANAGER | BLOCKED`.
- **Verdict:** validator outcome `PASS | PARTIAL | FAIL`.
- **J1–J5:** the five Jev decision points.
