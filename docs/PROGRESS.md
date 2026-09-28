# Progress

Update at the end of every session. Newest session log entry on top.

## Current phase

**Phase 2 · Resolution spine** (not started). Phases 0 and 1 are done.

## Phase checklist

- [x] Phase 0 · Foundations
- [x] Phase 1 · Product core without AI
- [ ] Phase 2 · Resolution spine
- [ ] Phase 3 · First agent (resume-ready milestone)
- [ ] Phase 4 · Multi-agent, context, evidence, Jev
- [ ] Phase 5 · Replan, evals, hardening
- [ ] Phase 6 · Polish, public demo, deploy

## Next task

Phase 2, task 1: action catalog in `packages/shared/src/actions.ts` + write-side services the executor needs (`OrderService.transition` with version check and `lockedReason` fault, `LedgerService.postCapture/postRefund/reverse`, `RefundService`, gateway `createRefund`/`replayWebhook` on `PaymentGatewayPort`).

## How to run locally

```
pnpm install
pnpm db:local        # terminal 1: PGlite on :54329 (or set DATABASE_URL to Supabase session pooler)
pnpm seed            # migrates, seeds merchants/customers and one case per scenario
pnpm dev             # server :4000 + web :5173
```
Open http://localhost:5173. `pnpm --filter @payops/web dev:mock` runs the UI on fixtures without a backend.

## Blockers

None.

## Known gaps (deliberate, later phases)

- Nothing closes a case automatically when data becomes consistent again; the validator does this in Phase 2.
- Signals column (complaint type, urgency, quarantine) stays empty until Jev J1 in Phase 4.
- Overview "Awaiting approval" and "Resolved by investigation" read 0 until Phases 2 and 3.
- No auth yet; routes carry `// Phase 2: requireRole(...)` markers.

## Later (parked ideas, do not build yet)

- Separate Refund specialist agent
- Cross-case pattern memory (LangGraph Store), e.g. merchant webhook failure streaks
- Dark theme with its own tokens
- Razorpay test adapter (Phase 6 stretch)
- Validator outcomes block on Overview (needs Phase 2 data)

## Session log

### 2026-09-28 · Phases 0 and 1
- Switched storage to Postgres (Supabase) + pg-boss + PGlite for local/tests; removed MongoDB, Redis and the worker (D008).
- Phase 0: pnpm monorepo, strict TS, ESLint layering rules, Vitest projects, Drizzle schema + migration, server shell (health, errors, request ids, Socket.IO, pg-boss).
- Phase 1: pure reconciliation core (state matrix, rules D1–D8, settlement check, lifecycle), batched snapshot loader, case/audit/payment/overview services, simulator with all 9 scenarios, REST API, reconcile sweep job, seed script.
- Web: app shell, Overview, Payments + lifecycle drawer, Exceptions queue, Case screen with state matrix, Simulator, Audit log; realtime case notices; dev mock mode.
- Checks: typecheck, lint, 145 tests passing; verified end to end on a real server with seeded data and screenshots.
