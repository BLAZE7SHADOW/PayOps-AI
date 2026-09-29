# 06 · Phase Plan and Execution

> **pnpm on this machine.** Plain `pnpm` does not work here. Run every `pnpm ...` command in this file as `npx pnpm@10.28.0 ...` (for example `npx pnpm@10.28.0 db:migrate`). To keep typing `pnpm`, add `alias pnpm='npx pnpm@10.28.0'` to `~/.zshrc` and open a new terminal. In Claude's cloud shell `pnpm` is also missing: call `node_modules/.bin/vitest` and `node_modules/.bin/tsc` directly.

Seven phases, about 6–7 weeks part-time. Every phase ends with something that runs and can be demoed. Do not start a phase until the previous phase's "Done when" list is fully true. Current status lives in `docs/PROGRESS.md`.

Resume checkpoint: **after Phase 3 the project is resume-ready** (working product + real agent with interrupt/resume). Start applying then; Phases 4–6 continue in parallel.

---

## Phase 0 · Foundations (2–3 days)

**Goal:** a monorepo that builds, lints, tests and boots against a local Postgres (PGlite) or Supabase.

Tasks
1. `pnpm` workspace: `apps/{web,server}`, `packages/{shared,core,agents,simulator,evals}`. `tsconfig.base.json` strict, path aliases `@payops/*`.
2. ESLint (typescript-eslint, import/no-restricted-paths per architecture doc §2), Prettier, Vitest at root.
3. `pnpm db:local` (PGlite server), Drizzle + drizzle-kit migrations, `pnpm db:migrate`. `pnpm dev` runs server + web.
4. `env.ts` per app with Zod parsing; `.env.example` (names only). Confirm `.env` is git-ignored.
5. `packages/shared`: `money.ts` (`toMinor`, `formatMoney`, tests), `ids.ts` (prefixed ids, seeded generator), enums skeleton.
6. `apps/server`: Express 5, `/api/health` (checks the database), error middleware, pino, request id, pg-boss started.
7. `apps/web`: Vite + React + Router, `tokens.css`, Plex fonts, app shell (nav + top bar) with empty routes, `Skeleton`, `Button`, `Tag`, `Table` primitives.
8. `git init`, first commit.

Done when
- `pnpm i && pnpm db:local` (or Supabase URL) `&& pnpm db:migrate && pnpm dev` works; `/api/health` returns ok; web shell renders on warm paper with Plex fonts.
- `pnpm lint && pnpm typecheck && pnpm test` pass.

You should be able to explain: why a monorepo, why integer paise, why ports/adapters.

---

## Phase 1 · Product core without AI (5–6 days)

**Goal:** generate realistic payment data with faults, detect inconsistencies, see them as cases.

Tasks
1. Drizzle tables for all external + internal data (data model doc) + first migration.
2. Domain services in `core`: `PaymentService`, `OrderService` (transition guard + `version`), `LedgerService` (append-only, double-entry helpers), `RefundService`, `SettlementService`, `WebhookService`.
3. `PaymentGatewayPort` + `SimulatorGatewayAdapter`.
4. `packages/simulator`: seeded generator; `healthy_payment` and the 8 MVP scenarios from the product doc (including `supportNotes` text for J1 later). Background noise: N healthy payments per run so tables look real.
5. Detection rules D1–D8 with unit tests; `CaseService.openOrUpdate` with fingerprint dedup; `reconcile-sweep` scheduled pg-boss job.
6. API: payments list/detail (with merged lifecycle), cases list/detail (with state matrix), simulator endpoints.
7. Web: Payments table + lifecycle drawer, Exceptions queue with mini-matrix, Case page with **StateMatrix** (investigation column shows "Not started"), Simulator page. Skeletons + empty states.

Done when
- Generating each scenario creates exactly the expected case type; `healthy_payment` creates none (tests).
- Case page shows the correct mismatched cells for every scenario.
- Detection tests cover every rule, including a no-fire case.

Demo: "Generate `captured_order_failed` → case appears in the queue → open it → matrix shows Order and Ledger wrong."

---

## Phase 2 · Resolution spine, still no AI (5–6 days)

**Goal:** a human can resolve any MVP case safely, end to end. This is the same pipeline the agent will use.

Tasks
1. Action catalog in `shared` (Zod params, flags) and handlers in `core/executor` with idempotency keys and `executions` records.
2. Policy engine P0–P8 in `core/policy`, versioned, pure, table-driven tests.
3. Validator: per-action postconditions + global invariants; `validationResults`.
4. Auth: login, JWT cookie, roles, seeded demo users, `requireRole` middleware, socket auth.
5. Approvals service with four-eyes rule; approval queue API.
6. Audit service; every service write goes through it.
7. Fault injection: order service rejects replay with `ORDER_VERSION_CONFLICT` for `replay_fails_then_replan`.
8. Web: "Resolve manually" form on Case page, Approvals page + drawer, Verification block, Audit log page, Policy page, Sign-in page.

Done when
- Every MVP scenario can be resolved manually to validator PASS (integration tests on PGlite).
- Replaying the same execution twice produces one ledger entry.
- OPS user cannot approve MANAGER tier; requester cannot approve own request.
- Audit log shows the full chain for a resolved case.

Demo: manual resolution of `refund_never_initiated` requiring manager approval.

---

## Phase 3 · First agent: LangGraph, one investigator, live streaming (6–7 days)

**Goal:** a real agent run that investigates, proposes, pauses for approval, resumes after a browser close, executes and verifies.

Tasks
1. `LlmPort` + `GeminiLlmAdapter` (`@langchain/google-genai`, `AI_MODEL`, temperature 0, `withStructuredOutput`).
2. Recording/replay wrappers and cassette format; `AI_MODE` switch.
3. `packages/agents`: state (full shape from agent doc §6, even if some fields unused yet), tools for Payment + Reconciliation groups with projection and evidence writing.
4. Graph v1: `loadCase → triage → diagnose (J6 fast path, docs/03 §4a; needs the Jev adapter from Phase 4 task 1 pulled forward) → [fast: template | full: investigate]`. Full path: `investigate (single agent, all tools, baseline + ≤6 follow-ups) → resolve → policyGate → awaitApproval(interrupt) → execute → validate → close`. No replan yet (FAIL → escalate).
5. `PostgresSaver` checkpointer; `agent-run` and `agent-resume` pg-boss jobs; `agent_runs` / `agent_steps` persistence.
6. Socket.IO events from the in-process publisher; event names from agent doc §16.
7. Web: Investigation column streams live; Findings & resolution panel with `EvidenceRef`s; Evidence panel; attempt header; reconnect rebuilds from `/runs/:id/steps`.
8. Record cassettes for `captured_order_failed`, `refund_stuck`, `refund_never_initiated`.

Done when
- In LIVE mode, `captured_order_failed` resolves to PASS with no human action (AUTO tier).
- `refund_never_initiated` pauses at MANAGER approval; restarting the server and closing the browser, then approving later, resumes at `awaitApproval` (not from the start) and finishes.
- Same scenarios pass in REPLAY with zero network calls.

Demo: the hero screen, live. **Update resume and start applying.**

---

## Phase 4 · Multi-agent, context engineering, evidence, Jev (6–7 days)

**Goal:** the architecture in the agent doc, fully.

Tasks
1. `DecisionPort` + `JevDecisionAdapter` (`@typesafe-ai/sdk`, key from `TYPESAFE_JEV_API_KEY`, `JEV_MODEL` pinned) + record/replay. Smoke test script `pnpm jev:ping`.
2. J1 signal intake on case creation (quarantine flow + UI tags).
3. Split into Payment, Reconciliation, Risk specialists; `plan` node with J2; parallel fan-out with `Send`; `join`.
4. ContextBuilders per agent with budgets, projection, PII masking, token estimate logging.
5. Risk specialist: signal bucketing in code + J3 atomic scores + weights → tier.
6. `groundCheck`: structural predicates + J4 citation check + sufficiency → targeted extra round.
7. Findings persisted to `agentFindings`; evidence to `evidence`.
8. UI: Jev decisions in the trace with confidence; grounding status on each finding; dropped findings shown struck through with the reason.
9. Record cassettes for all scenarios.

Done when
- `plan` routes `settlement_mismatch` to Reconciliation (not Payment-only) and `suspicious_payment` includes Risk.
- A deliberately corrupted finding (test fixture) is caught by grounding and never reaches `resolve`.
- Context sizes per call are visible and within budget.
- Every Jev decision point has a tested fallback path (adapter throws → run still completes).

---

## Phase 5 · Replan loop, evals, hardening (5 days)

**Goal:** prove the agent recovers from failure and measure it.

Tasks
1. `replan` node with J5 + caps; `history` in context; attempt tabs in UI.
2. `replay_fails_then_replan` passes on attempt 2.
3. `packages/evals`: golden expectations for all scenarios; runner; markdown report (accuracy, tier match, grounding violations, replan success, tool calls, latency, cost).
4. Injection eval `injected_refund_request`: no refund proposed from the text; text quarantined.
5. Budget guard: exceeding `MAX_TOOL_CALLS` / `MAX_COST_USD` per run escalates cleanly.
6. Failure drills: Gemini timeout, Jev timeout, database serialization conflict during execute; each ends in a defined state.

Done when
- `pnpm eval` (REPLAY) passes in CI; `pnpm eval:live` report committed under `docs/evals/`.
- Replan scenario passes; injection scenario passes.

---

## Phase 6 · Polish, public demo, deploy (5–6 days)

Tasks
1. Overview metrics + charts; Agent runs list + detail.
2. Landing page with real screen recordings, `/terms`, `/privacy`.
3. Keyboard nav, focus states, a11y pass, skeleton audit, copy audit against UI doc §8 and §9.
4. Dockerfile; deploy (Vercel + Render + Supabase), `AI_MODE=REPLAY`, nightly reset.
5. README: problem, 2-minute demo video, architecture diagram, "How decisions are made" table, eval results, how to run locally, design decisions.
6. Stretch: `RazorpayTestAdapter` behind `GATEWAY_ADAPTER=razorpay` (read payments/refunds, webhook signature verification).

Done when
- A stranger can open the link and complete the 2-minute demo without instructions.
- Lighthouse a11y ≥ 95 on Case page.

---

## Polish track (D062): phases P0 to P6

Goal: make PayOps AI the strongest portfolio piece for agentic AI solving a real payments problem. Razorpay and PayPal adapters stay out of this track and come after it. Each phase below runs in **its own fresh chat** to keep token use low: start with "Read CLAUDE.md and docs/PROGRESS.md, then continue.", do only the tasks listed, run the done-when checks, update PROGRESS.md, stop. Do not read other docs unless a task names them.

**P0 · Quick win (about half a day)**
1. One-line verdict at the top of every Case ("Fixed automatically and verified. Nothing needed from you.").
2. One shared `FAST_PATH` constant used by `diagnose()` and the run page.
Done when: verdict shows for every case status (unit-tested); typecheck and tests green.

**P1 · AI trust (3 to 4 days)**
1. Per-root-cause code checks that confirm the stated cause, closing the D057 gap (fix passes but the label is wrong).
2. Evals across all scenarios plus adversarial variants (misleading notes, conflicting evidence); commit the report under `docs/evals/`.
3. Operator feedback on a diagnosis ("right" or "wrong", with a reason), stored and shown in metrics later.
4. Global pause, propose-only mode, and clearer handoff messages when the agent stops.
Done when: a wrong root-cause label is caught by a test; eval report committed; pause stops new auto-executions.

**P2 · Operator workflow (3 to 4 days)**
1. Case assignment, due times, alerts for overdue cases.
2. Saved views, case notes, shift handoff summary.
3. Bulk approve for low-risk actions; auto-close when systems reconcile by themselves. (done, D069)
4. Undo through a reversing action where the catalog allows it. (done, D070)
Done when: an operator can run a shift from the Exceptions page without opening a case for routine ones.

**P3 · Realistic data and adapter test kit (3 days)**
1. Grow scenarios from 9 to about 15 with messier variants (late webhooks, partial refunds, out-of-order events, duplicates). (done, D071: 15 existed by then; six messy variants added, 21 total)
2. Raw event log with replay, and a retry queue for failed webhooks. (done, D072)
3. A 10,000-payment volume test with detection timings.
4. Adapter contract tests and a webhook signature-check helper, so Razorpay and PayPal only need an adapter.
Done when: contract tests run against the simulator adapter; volume test result written to docs.

**P4 · Security and compliance (3 to 4 days)**
1. MFA (TOTP), session revoke, persistent rate limiting.
2. Role and permission table in code and docs.
3. Hash-chained tamper-evident audit, database rules blocking update and delete, CSV export.
4. Threat model, and a data-flow table of what goes to Gemini and Jev, with PII masking tests.
Done when: audit chain verification passes and fails on a tampered row (tested); data-flow doc reviewed.

**P5 · Metrics and tracing (2 to 3 days)**
1. Resolution time, auto-resolution rate, agent accuracy (using P1 feedback), approval turnaround, cost per case.
2. Trace links from case to run to model call.
Done when: Overview shows each metric from real seeded data, each with a stated definition.

**P6 · Delivery (3 to 4 days)**
1. Accessibility, empty and error states on every page; Lighthouse a11y at least 95 on Case.
2. Playwright flows for the main journeys; CI.
3. Docker, hosted demo, scripted walkthrough, 2-minute video.
4. Usability test with three people; fix what they hit.
Done when: a stranger completes the demo from the link without help.

Not building: multi-tenant billing, real SSO, dark mode, a separate refund agent.

---

## Working rules for every phase

- One phase at a time. Anything outside the current phase goes to `PROGRESS.md › Later`.
- Each task: write/adjust tests first for core logic (detection, policy, executor, validator, grounding, money).
- End each coding session by updating `docs/PROGRESS.md` (done, in progress, next, blockers) and adding any design change to `docs/DECISIONS.md`.
- Before a phase is marked done, run the "Done when" list literally and write the result into `PROGRESS.md`.

## Interview talking points (collect as you build)

- Why the agent can't move money: closed catalog, policy in code, four-eyes, validator.
- Why Jev for five narrow decisions and an LLM for reasoning; how confidence routes behavior; why code pre-computes numbers for Jev.
- How interrupt/resume survives a server restart (Postgres checkpointer + thread id).
- How grounding catches hallucinated findings (predicates + citation check).
- How REPLAY mode makes the public demo free and the evals deterministic.
- What the eval numbers are and what failed first.
