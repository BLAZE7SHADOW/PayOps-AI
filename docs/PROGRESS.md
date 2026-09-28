# Progress

Update at the end of every session. Newest session log entry on top.

## Current phase

**Phase 4 · in progress.** Phases 0–3 are done. Phase 4 task 1 (Jev adapter), task 2 (J1 signal
intake) and task 3 (specialist split + J2 `plan` + `Send` fan-out + `join`) are done; the rest of
Phase 4 (context builders, risk specialist + J3, groundCheck + J4, evidence persistence, UI
decision/grounding trace, cassette recordings) is not started.

## Phase checklist

- [x] Phase 0 · Foundations
- [x] Phase 1 · Product core without AI
- [x] Phase 2 · Resolution spine
- [x] Phase 3 · First agent (resume-ready milestone)
- [ ] Phase 4 · Multi-agent, context, evidence, Jev
- [ ] Phase 5 · Replan, evals, hardening
- [ ] Phase 6 · Polish, public demo, deploy

## Next task

Phase 4 task 4: ContextBuilders per agent (budgets, projection, PII masking, token estimate
logging), docs/06-phases.md Phase 4 task 4, docs/03-agent-system.md §8. Note for that session:
`riskAgent` (nodes.ts) currently has an empty tool set (`RISK_TOOLS = []` in tools.ts) by design —
task 5 (Risk specialist: signal bucketing + J3 atomic scores → tier) is what gives it real tools
and fills `state.risk`; do not build risk scoring as part of task 4. After task 4: Risk specialist
+ J3 (task 5), groundCheck + J4 (task 6), evidence/finding persistence (task 7), UI
decision/grounding trace (task 8), cassette recordings (task 9).

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

None. Note: in this cloud session, `pnpm test` fails inside the desktop bridge's Linux VM with a
missing `@rollup/rollup-linux-arm64-gnu` native binary (node_modules in the connected folder has
only the macOS binary). This is a bridge/environment artifact, not a code issue — `pnpm
typecheck` and `pnpm lint` are clean across all packages. Run `pnpm test` directly in a Terminal
on the Mac to verify.

## Known gaps (deliberate, later phases)

- Detection never closes a case by itself; cases close through a verified resolution.
- Login rate limiting is in memory (single server process).
- Signals column is now populated by `SignalIntakeService` (J1) when a case is created, but only
  when a `DecisionPort` is wired in (`apps/server` always wires one now); it silently stays empty
  when Jev errors, times out, or (REPLAY/no cassette) has nothing recorded for `J1_INTAKE` — this
  is the documented J1 fallback, not a bug.
- Agent graph now has four integration tests against PGlite + PostgresSaver. Full Gemini path and adapter fallback unit coverage remain incomplete.

## Later (parked ideas, do not build yet)

- Separate Refund specialist agent
- Cross-case pattern memory (LangGraph Store), e.g. merchant webhook failure streaks
- Dark theme with its own tokens
- Razorpay test adapter (Phase 6 stretch)
- Validator outcomes block on Overview (needs Phase 2 data)

## Session log

### 2026-09-28 · Phase 4 task 3: specialist split, J2 plan, Send fan-out, join
- Replaced the single `investigate` node with the doc's fan-out shape (docs/03 §5): `plan`
  (Phase 4 task 3, `packages/agents/src/nodes.ts`) asks Jev J2 for a `primary_hypothesis` Choice
  and `need_payment`/`need_reconciliation`/`need_risk` Nouls, then routes with a new pure function
  `choosePlanSpecialists` (`packages/agents/src/planning.ts`, unit-tested without a graph or a
  DecisionPort): confidence < 0.5 runs every specialist (the doc's safe default); otherwise a
  specialist runs if its own need Noul is >= 0.35, unioned with `mandatorySpecialists` (Payment
  always, since every case here traces back to a payment; Risk once the amount band reaches
  HIGH). `graph.ts`'s conditional edge out of `plan` returns a `Send` per selected specialist
  (`paymentAgent` | `reconciliationAgent` | `riskAgent`), so a specialist `plan` did not choose
  never runs. All three converge on a new `join` node (a log-only observation point — the state
  reducers already merged `agentsVisited`/`evidence`/`findings` by the time it runs), which feeds
  `resolve` exactly where `investigate` used to (`groundCheck` is task 6, not wired yet).
- Each specialist (`buildSpecialistNode` factory in `nodes.ts`) reuses `investigate`'s two-stage
  pattern (baseline already gathered by `triage`, then a bounded follow-up LLM call + a findings
  LLM call) but scoped to its own tool group only: `evidenceForTools` filters the specialist's own
  prompt down to evidence its own tools produced, and `buildFollowUpChoiceSchema`
  (`schemas.ts`) gives each specialist a Zod enum that can only name its own group's tools — a
  payment specialist call can never resolve to a ledger/settlement tool. `tools.ts` gained
  `PAYMENT_FOLLOWUP_TOOLS`/`RECONCILIATION_FOLLOWUP_TOOLS`/`RISK_FOLLOWUP_TOOLS` and a `'risk'`
  `ToolDef.group` member with an empty `RISK_TOOLS = []` (see D037/D038 in DECISIONS.md — Risk's
  real tools + J3 scoring are Phase 4 task 5, not this task). A specialist with no follow-up tools
  or no evidence in its own slice skips both LLM calls and returns zero evidence/findings, which
  is the expected shape for `riskAgent` right now.
- `triage` is unchanged: it still gathers the combined baseline evidence for every group up front,
  because the fast path (`diagnose` returning a diagnosis directly to `resolve`, skipping `plan`
  and every specialist) still needs evidence to cite in its narrative template.
- Tests: `packages/agents/src/planning.test.ts` (new) covers the confidence-floor fallback (run
  ALL), the settlement_mismatch-shaped routing case (Reconciliation included via its own Noul, not
  Payment-only), the 0.35 inclusion threshold on both sides, the Payment/Risk mandatory rules, and
  stable output ordering. `graph.test.ts`'s four scenarios and three cassette replays are
  unchanged and still pass conceptually (all exercise only the fast path, which never touches
  `plan`/specialists/`join` — verified by re-reading the fixture: its `DecisionPort` fixture always
  answers with high `root_cause` confidence and `needs_human: 0`, i.e. J6 fast). No new graph-level
  integration test for the full path (Jev-backed `plan` + real specialists) was added this session
  — the existing `noLlm`/single-shape `decision` test fixtures in `graph.test.ts` answer J6's
  question shape only; extending them for J2 is left as part of task 4 (ContextBuilders), when the
  full path's prompts actually need real per-agent context slices to test against meaningfully.
- Checks: `pnpm typecheck` and `pnpm lint` clean across all packages (root, via `pnpm -r --if-present typecheck`
  and `pnpm lint`). `pnpm test` still cannot run in this cloud session — the connected folder's
  `node_modules` only has the macOS Rollup native binary
  (`Cannot find module '@rollup/rollup-linux-arm64-gnu'`), the same bridge issue noted in
  Blockers. Ask Shivam to run `pnpm test` (including the new `planning.test.ts`) locally on the
  Mac before trusting this session's test additions fully.
- Not done this session: ContextBuilders (task 4), Risk specialist + J3 (task 5), groundCheck +
  J4 (task 6), evidence/finding persistence (task 7), UI trace (task 8), cassettes (task 9) — see
  Next task.


### 2026-09-28 · Phase 4 start: Jev smoke test + J1 signal intake
- Confirmed Phase 4 task 1 (`DecisionPort` + `JevDecisionAdapter`) was already built during Phase
  3's J6 fast-path pull-forward (D026). Added the missing piece: `pnpm jev:ping`
  (`scripts/jev-ping.ts`), a live one-question smoke test against the pinned Jev model, printing
  confidence and never the API key.
- J1 signal intake (docs/03 §4 "J1"): new `SignalIntakeService` (`packages/core/src/services/
  signal-intake.service.ts`). On a newly opened case, screens any not-yet-screened `support_notes`
  for that payment/order with one Jev call per note (`complaint_type` Choice, `urgency`/`injection`
  Nouls), writes the note's tags, quarantines text with injection probability > 0.5, and recomputes
  the case's aggregate `signals` (complaintType, urgent, quarantined) — the `cases.signals` column
  that the Exceptions queue UI (`case-cells.tsx`) already rendered but nothing ever populated.
  Fallback per the doc: a Jev error leaves that note untagged, never throws, and is retried only
  the next time the case changes.
- Added `ComplaintType` (`charged_not_delivered | double_charged | refund_not_received |
  unauthorized | other`) to `packages/shared`, tightened `CaseSignals`/`CaseSignalsRow` to it, and
  aligned the web mock fixtures' placeholder complaint-type casing to match.
- Wired `SignalIntakeService` into `createCore` (new optional `CoreOptions.decision`, defaulting
  to a `NullDecisionPort` that always falls back, so existing tests and the simulator are
  unaffected) and into `ReconciliationService.applyCandidates`, called once per newly created case
  after the DB transaction commits (it makes a network call) and before the case is published.
  `apps/server/src/main.ts` now builds a real `DecisionPort` via `createDecisionPort(env)` and
  passes it in.
- Tests: `packages/core/src/services/signal-intake.service.test.ts` (new) — tags + aggregates
  signals, quarantines on high injection probability, falls back to no tags on a Jev error without
  throwing, does not re-screen an already-tagged note, and leaves the case untouched when it has no
  support notes.
- Checks: `pnpm typecheck` and `pnpm lint` clean across all packages. `pnpm test` could not be run
  in this session — see Blockers; ask Shivam to run it locally before trusting it fully.
- Not done this session: the rest of Phase 4 (specialists, J2 plan, context builders, J3 risk, J4
  grounding, evidence persistence, UI trace, cassettes) — see Next task.


### 2026-09-28 · Phase 3 UI and verification (complete)
- Added case investigation UI: run/attempt header, start control, step trace, findings/proposal, evidence panel, and keyboard-accessible `EvidenceRef` links. Socket events invalidate persisted run/step reads; reconnect rebuilds from the API. Added guards for approval payloads sharing agent event names. Browser verification remains pending.
- Added agents graph and prompt tests: fast path reaches AUTO/PASS with cited evidence; stuck-refund sync reaches PASS; manager interrupts resume from a newly constructed graph; execution failure escalates without replanning; all three recordings replay on fresh data with provider fetches blocked.
- Verification: typecheck, lint, all 261 tests, server/web production builds, and `git diff --check` pass. Live browser verification confirms AUTO/PASS, MANAGER approval after the browser closed and server restarted, no repeated triage, socket reconnect step recovery, and evidence-link keyboard navigation.
- Local tooling: used `corepack pnpm` because `pnpm` is absent from PATH. Reinstalled the frozen lockfile dependencies for macOS (previous node_modules contained Linux binaries). Confirmed both provider keys are configured through `loadServerEnv`; no secret values were printed and no live provider calls were made.
- Fixed the invalid Jev model pin after a real 400 response (`jev-1.13.0`), shared checkpointer pool, prompt cassette stability, schema validation on recorded LLM responses, tsup config, and agent resolution overview count. No secret values were printed; `.env` was not edited. Phase 3 is complete; Phase 4 has not started. See `docs/PHASE3-HANDOFF.md`.

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
