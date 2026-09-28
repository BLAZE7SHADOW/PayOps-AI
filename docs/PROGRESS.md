# Progress

Update at the end of every session. Newest session log entry on top.

## Current phase

**Phase 3 · First agent** (backend done, web UI + cassette recording remaining). Phases 0, 1 and 2 are done.

## Phase checklist

- [x] Phase 0 · Foundations
- [x] Phase 1 · Product core without AI
- [x] Phase 2 · Resolution spine
- [ ] Phase 3 · First agent (resume-ready milestone)
- [ ] Phase 4 · Multi-agent, context, evidence, Jev
- [ ] Phase 5 · Replan, evals, hardening
- [ ] Phase 6 · Polish, public demo, deploy

## Next task

Phase 3, task 7: Web UI. Investigation column needs to stream live from Socket.IO agent-step events (see `packages/agents/src/store.ts`'s `AGENT_STEP_EVENT` map for event names); Findings & resolution panel with `EvidenceRef`s; Evidence panel; attempt header; on reconnect, rebuild state from `GET /api/runs/:id/steps` (already implemented, see `apps/server/src/routes/runs.ts`). Then task 8: record real cassettes for `captured_order_failed`, `refund_stuck`, `refund_never_initiated` by running the server locally with `AI_MODE=RECORD` and real `GEMINI_API_KEY`/`TYPESAFE_JEV_API_KEY` — this needs Shivam's machine or a persistent local dev server; the cloud session used for the backend work could not keep a background dev server alive across tool calls. Once cassettes exist, re-verify the three "Done when" scenarios in `docs/06-phases.md` (AUTO resolves with no human action in LIVE; MANAGER approval pauses/resumes across a restart; REPLAY has zero network calls).

## How to run locally

```
pnpm install
pnpm db:local        # terminal 1: PGlite on :54329 (or set DATABASE_URL to Supabase session pooler)
pnpm seed            # migrates, seeds merchants/customers and one case per scenario
pnpm dev             # server :4000 + web :5173
```
Open http://localhost:5173 and use a demo account on the sign-in page (password for all: `payops-demo`):

| Email | Name | Role |
|---|---|---|
| ops@payops.dev | Ananya Rao | OPS |
| ops2@payops.dev | Rahul Menon | OPS (second analyst, for four-eyes approvals) |
| manager@payops.dev | Meera Iyer | MANAGER |
| viewer@payops.dev | Kabir Shah | VIEWER |
| admin@payops.dev | Admin | ADMIN |

`pnpm --filter @payops/web dev:mock` runs the UI on fixtures without a backend.

## Blockers

None.

## Known gaps (deliberate, later phases)

- Detection never closes a case by itself; cases close through a verified resolution.
- Login rate limiting is in memory (single server process).
- Signals column (complaint type, urgency, quarantine) stays empty until Jev J1 in Phase 4.
- Overview "Resolved by investigation" reads 0 until the web UI (task 7) lands.
- `packages/agents` has no unit tests yet (nodes, `templateActions`, `narrativeFor`, `buildProposal`); the backend is only covered indirectly via the existing 252-test suite, which exercises none of the new code paths.

## Later (parked ideas, do not build yet)

- Separate Refund specialist agent
- Cross-case pattern memory (LangGraph Store), e.g. merchant webhook failure streaks
- Dark theme with its own tokens
- Razorpay test adapter (Phase 6 stretch)
- Validator outcomes block on Overview (needs Phase 2 data)

## Session log

### 2026-09-28 · Phase 3 (backend)
- `shared`: full agent vocabulary (`agents.ts`) — run/step status, decision tags, root causes, finding codes, evidence/finding/proposal shapes, `RunBudget`, `AGENT_BUDGET_LIMITS`, `CreateRunBody`/`RunListQuery` DTOs.
- `core`: `LlmPort` + `GeminiLlmAdapter` (Gemini, structured output, temp 0); `DecisionPort` + `JevDecisionAdapter` (TypeSafe System One, choice/noul/score); a shared RECORD/REPLAY cassette adapter (`adapters/cassette.ts`) wrapping both ports, keyed by node/tag + call index + prompt hash; `agent_runs`/`agent_steps` tables + migration 0002; `ResolutionService.proposeFromAgent` + `finish({onFailure})`; `ApprovalService` continuation now covers approved/rejected/escalated.
- `packages/agents` (new workspace package): LangGraph state (`PayOpsState`), 11 read-only tools over Payment/Reconciliation data with evidence projection, Zod schemas for structured LLM output, case-brief builder, prompts, fast-path template resolution (D029), graph v1 (`loadCase → triage → diagnose(J6) → [fast: template | full: investigate → resolve] → policyGate → awaitApproval(interrupt) → execute → closeBlocked/closeRejected/closeEscalated`), `PostgresSaver` checkpointer keyed by `runId`, run store + Socket.IO event sink.
- `apps/server`: `agent-run`/`agent-resume` pg-boss jobs; `POST /api/cases/:id/runs` (create + enqueue), `GET /api/runs`, `/:id`, `/:id/steps`; `agentResumer` wired through a mutable box (D028) so an approval decision resumes the paused LangGraph thread.
- Design decisions logged: D027 (writes-before-interrupt split), D028 (resumer box), D029 (fast-path reuses `recommendedTypes`), D030 (agent failures escalate, `onFailure`), D031 (bounded two-call investigate instead of open ReAct), D032 (optional `scenarioKey`).
- Checks: `pnpm typecheck` clean across all 6 packages; `pnpm test` — 252/252 passing (no new tests added yet for the agent package itself — see Known gaps).
- Not done this session: Web UI (task 7 — investigation stream, findings/evidence panels, reconnect rebuild), cassette recording (task 8 — needs a persistent local server with real API keys, not available in this cloud session), and the three Phase 3 "Done when" scenarios are therefore unverified end to end.


### 2026-09-28 · Phase 2
- Shared contract: closed action catalog (9 actions, 4 classes), policy vocabulary P0–P11, resolution/approval/verification DTOs.
- Backend: write-side services (orders with optimistic locking, double-entry ledger, refunds, disputes), webhook consumer with the injected 409 fault, gateway writes (replay, refund), action handlers with preconditions/postconditions, policy engine, idempotent executor, independent validator, resolution + approval orchestration with four-eyes, auth (scrypt + JWT cookie, roles, JSON-only CSRF rule, demo users), migration 0001.
- Web: sign-in with demo accounts, role-aware UI, Resolve manually drawer with live policy preview, attempt history with execution and verification tables, Approvals queue and drawer, Policy page, realtime notices.
- Verified end to end in a real browser: replay fails (validator FAIL) then mark paid + ledger approved by a second analyst (PASS); ₹78,000 refund approved by a manager (PASS). Fixed: drawer reopening after auto-execution, PGlite connection interleaving (D023), approval event payload (D025), stale queue matrix (D024), window-level scroll in the app shell.
- Checks: typecheck, lint, 252 tests passing, production build.

### 2026-09-28 · Phases 0 and 1
- Switched storage to Postgres (Supabase) + pg-boss + PGlite for local/tests; removed MongoDB, Redis and the worker (D008).
- Phase 0: pnpm monorepo, strict TS, ESLint layering rules, Vitest projects, Drizzle schema + migration, server shell (health, errors, request ids, Socket.IO, pg-boss).
- Phase 1: pure reconciliation core (state matrix, rules D1–D8, settlement check, lifecycle), batched snapshot loader, case/audit/payment/overview services, simulator with all 9 scenarios, REST API, reconcile sweep job, seed script.
- Web: app shell, Overview, Payments + lifecycle drawer, Exceptions queue, Case screen with state matrix, Simulator, Audit log; realtime case notices; dev mock mode.
- Checks: typecheck, lint, 145 tests passing; verified end to end on a real server with seeded data and screenshots.
