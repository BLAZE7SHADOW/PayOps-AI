# Progress

Update at the end of every session. Newest session log entry on top.

## Current phase

**Phase 6 · in progress, re-scoped by Shivam (D051): UI polish, metrics/charts, landing page, then README.** Docker, hosted deploy and the Razorpay stretch are parked. Phase 5 is complete (D047-D050); its live eval
report is committed at `docs/evals/2026-09-28.md` (7/7 in LIVE mode).

## Phase checklist

- [x] Phase 0 · Foundations
- [x] Phase 1 · Product core without AI
- [x] Phase 2 · Resolution spine
- [x] Phase 3 · First agent (resume-ready milestone)
- [x] Phase 4 · Multi-agent, context, evidence, Jev
- [x] Phase 5 · Replan, evals, hardening
- [x] Phase 6 · Polish, metrics/charts, landing page, README (re-scoped, D051)

## Next task

**P5 is done (D079). Next: P6 · Delivery** (`docs/06-phases.md`, "P6 · Delivery"). Open a fresh chat with "Read CLAUDE.md and docs/PROGRESS.md, then continue." P6's Docker and hosted-demo items overlap with what D051 parked, so confirm scope with Shivam first.

Still for Shivam: run the app and check what nothing here has viewed in a browser: the Webhook events page (`/webhooks`: filter, open an event, Replay a DEAD one as ops@payops.dev and check it turns Processed, viewer sees no Replay button), a case's notes panel, the Exceptions saved views, `/handoff`, Approvals bulk approve, and Undo. For Undo, resolve a `replay_fails_then_replan` case (replay, then mark paid + ledger post with ops2's approval), open the resolved case as ops@payops.dev, click "Undo ledger post", confirm, approve as ops2, and check the case ends Open with the ledger cell mismatched again. Apply migrations 0011 and 0012 (`npx pnpm@10.28.0 db:migrate`; 0005 to 0010 are already applied). 0012 seals existing audit rows into the hash chain, so run it once against Supabase too, then call `GET /api/audit/verify` as manager@payops.dev and expect `ok: true`. Also check in a browser: the code step on `/login` and the `/security` page (see the P4 task 1 log entry). Commit from the Mac, delete `docs/UI-CASE-WORKSPACE-PREVIEW.html` and the `_to_delete/` folder at the repo root (it holds an empty stub file and two scratch tsconfig files that I created and could not delete), remove `.git/index.lock` if git complains.

Later ideas: dev:mock fixtures with a before-state (and a mock for the undo route); earlier attempts inline in the story; manual notes as a PERSON entry; Lighthouse on `/` and Case; demo video; inverse actions for MARK_ORDER_PAID and HOLD if undo should cover them.

## How to run locally

> **pnpm on this machine.** Plain `pnpm` does not work here. Run every `pnpm ...` command in this file as `npx pnpm@10.28.0 ...` (for example `npx pnpm@10.28.0 db:migrate`). To keep typing `pnpm`, add `alias pnpm='npx pnpm@10.28.0'` to `~/.zshrc` and open a new terminal. In Claude's cloud shell `pnpm` is also missing: call `node_modules/.bin/vitest` and `node_modules/.bin/tsc` directly.
```
pnpm install
pnpm db:local        # terminal 1: PGlite on :54329, leave it running (or set DATABASE_URL to Supabase session pooler)
pnpm db:migrate      # terminal 2: apply migrations (needed after pulling a new migration, e.g. 0005)
pnpm seed            # terminal 2: migrates too, then seeds merchants/customers and one case per scenario
pnpm dev             # terminal 2 or 3: server :4000 and web :5173 together, no separate frontend command
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

None outstanding. `pnpm test` now runs in this environment -- earlier sessions' "cannot run
`pnpm test`, missing `@rollup/rollup-linux-arm64-gnu`" note is resolved for future cloud
sessions the same way task 7's session found: the connected folder's `node_modules` was built
on macOS (darwin-arm64) and this environment's shell is a Linux/arm64 VM bridged to it, so any
package with a native binary (rollup, esbuild) is missing its linux-arm64 variant. Installing
the missing `@esbuild/linux-arm64` and `@rollup/rollup-linux-arm64-gnu` binaries into that same
`node_modules/.pnpm` layout (via `npm install --no-save` into a scratch dir, then copied into
place) is a node_modules-only fix -- nothing committed, nothing in package.json/the lockfile
changes, and it does not touch the Mac's own copy of `node_modules`. A future cloud session
hitting the same rollup/esbuild "Cannot find module" error should redo this rather than treating
it as an unfixable blocker.

The 10 test failures task 7's session found (real bugs in tasks 3-6's code, invisible until
`pnpm test` could actually run) are fixed -- see D043 for the full account. All 3 cassette-replay
tests in `graph.test.ts` are un-skipped and passing against cassettes re-recorded live on
Shivam's Mac (D046). Also note: live API calls (Gemini/Jev) cannot be made from this cloud
session's `device_bash` shell -- its network egress allowlist rejects both
`generativelanguage.googleapis.com` and `api.typesafe.ai` (confirmed by direct `curl` probes,
D045). Anything needing a real, non-cassette API call in a future phase needs to run on
Shivam's Mac directly, same as task 9 did.

## Known gaps (deliberate, later phases)

- Detection closes a case by itself only when the order re-reads fully consistent and the case is still OPEN and of a payment, refund or duplicate type (D069). Risk and settlement cases, and any case someone is working, close only through a verified resolution.
- Signals column is now populated by `SignalIntakeService` (J1) when a case is created, but only
  when a `DecisionPort` is wired in (`apps/server` always wires one now); it silently stays empty
  when Jev errors, times out, or (REPLAY/no cassette) has nothing recorded for `J1_INTAKE` — this
  is the documented J1 fallback, not a bug.
- Agent graph now has four integration tests against PGlite + PostgresSaver. Full Gemini path and adapter fallback unit coverage remain incomplete.
- `chargeback_pattern` (J3, docs/03 §4) is scored from `customers.riskFlags` (currently always
  empty in seed data) rather than real per-customer chargeback history: the schema only tracks
  settlement disputes, keyed by merchant/batch, not by customer (docs/DECISIONS.md D040). A real
  per-customer chargeback record is a schema addition for a later phase if needed.
- The policy engine's P1/P2 risk-tier check still reads `riskTierFromRules` (the pre-existing,
  always-on rules-only tier in `core/policy/risk.ts`), not the agent's J3 `RiskAssessment`
  (`state.risk`, now genuinely populated by `riskAgent`). `state.risk` is available on the run
  and in `agent_steps` but nothing downstream reads it yet — flagged, not wired, per D040.
- Causal diagnosis can be wrong even when the selected action passes validation. Two trial
  high-value refund scenarios were excluded from the critical showcase because live runs
  resolved them but labeled their root causes incorrectly (D057). Grounding verifies evidence
  support, and the validator verifies data changes; neither proves causal labels are correct.
- `packages/evals`'s golden set covers 7 of 9 `ScenarioKey`s. `settlement_mismatch` and
  `suspicious_payment` both take the full path (`plan` → specialists → `groundCheck`) and were
  deliberately left out rather than guessing J2/J3/J4/LLM-findings fixtures with no existing
  full-path integration test to model them on (docs/DECISIONS.md D048).

## Later (parked ideas, do not build yet)

- Separate Refund specialist agent
- Cross-case pattern memory (LangGraph Store), e.g. merchant webhook failure streaks
- Dark theme with its own tokens
- Razorpay test adapter (Phase 6 stretch, parked by D051)
- Dockerfile, hosted deploy (frontend on Vercel, API host TBD), nightly reset (parked by D051)

## Session log

### 2026-10-07 · Narrated GitHub demo video
- Produced `docs/demo/payops-demo.mp4`: 3:04, 1920×1080, H.264/AAC, about 7.8 MB. Includes neural English narration (Gemini Charon, replacing the rejected macOS voice), burned-in captions, separate SRT, transcript, poster, storyboard and regeneration scripts. Root README links to the video.
- Recorded the actual app against an isolated ephemeral database in REPLAY mode: PAY-0005 recovered the webhook/order/ledger mismatch and passed independent verification; RFD-0002 paused for manager approval and then resolved. Recorded the evidence drawer, selected specialist steps, before/after records and case audit trail. Illustrative architecture cards and replay mode are disclosed.
- Checked rendered frames, media metadata, audio peak level, script syntax and Git whitespace. No application logic changed. Deployment and GitHub media upload remain separate delivery tasks.

### 2026-10-02 · P5: performance metrics and model-call trace links (D079)
- Tests first for the pure math (`core/metrics/performance.test.ts`: medians, null when empty, each metric from rows). Then `OverviewService` fetches rows, `OverviewMetrics.performance` added, `Performance.tsx` shows five figures with their definitions on Overview, dev:mock updated.
- Trace: run detail has a Model calls table linking to the recorded event rows (`modelCalls()` in `run-metrics.ts`, tested). Case to run link already existed.
- Checks: tsc clean in shared, core, server, web; vitest passes on `core/metrics`, `server/app.test.ts` (adds a null-performance assertion), and `web` runs and overview folders; eslint clean on touched folders. Full suite not run. No browser pass.
- Gap against "Done when": the seed has no resolved cases, ratings or decided approvals, so on a fresh seed the figures read "No data". To see real numbers, resolve a few cases, decide an approval and rate a diagnosis, or add seeded history in a later task. Nothing was added to the seed.
- For Shivam: open Overview and a run page in a browser and check the layout. Read the definitions in D079 and say if any should change (for example whether "auto-resolution" should also count verified auto-close by detection).
### 2026-10-02 · P4 task 4: threat model, data-flow table, PII scrub and egress test (D078)
- New `docs/07-security.md`: assets, trust boundaries, a table of what goes to Gemini and Jev at each call (J1 to J6, specialists, resolve), 15 threats with control, code and test, and a list of known gaps. Added to the source-of-truth table in `CLAUDE.md`.
- Code: `scrubPiiText` (`shared/mask.ts`) applied to J1 note text, string facts and finding statements in Gemini prompts, and J4 claims. Notes still never enter a Gemini prompt.
- Tests: `shared/mask.test.ts`, three new cases in `agents/context.test.ts`, and `agents/egress.test.ts` (canary customer name, email, phone and note through five real scenarios; fails on any outbound leak). Mutation-checked, see D078.
- Checks: tsc clean in shared, core, agents and server; eslint clean on touched files; vitest passes in agents (186), shared (44), core (249), evals (7), server (96) and simulator (89). The web package was not run (untouched). No browser pass, nothing in the UI changed.
- Done when (P4): audit chain verification passes and fails on a tampered row (D077 tests); data-flow doc written, but not yet reviewed by Shivam. Read section 3 and 5 of `docs/07-security.md` and correct anything you disagree with.
- For Shivam: nothing to run. Worth knowing for interviews: names are not scrubbed, risk evidence reaches Jev only as buckets, and notes never reach Gemini.
### 2026-09-30 · P4 task 3: hash-chained audit, append-only triggers, verify and CSV export (D077)
- Tests first for the pure parts (`audit/chain.test.ts`, `audit/csv.test.ts`), then the database behaviour (`audit/audit-chain.db.test.ts`) and routes (`apps/server/src/audit-routes.test.ts`).
- Core: migration `0012_audit_hash_chain` (seq, prev_hash, hash, unique seq, backfill, BEFORE UPDATE/DELETE triggers), `audit/chain.ts`, `audit/store.ts` (append under advisory lock, seal legacy rows), `audit/csv.ts`, `AuditService.record/verifyChain/exportCsv`. `runMigrations` seals legacy rows afterwards. Server: `GET /api/audit/verify`, `GET /api/audit/export.csv`, new `audit.verify` permission (MANAGER); docs table regenerated. Shared: `AuditChainStatus`.
- Checks: tsc clean in shared, core and server; eslint clean on touched folders; full `vitest run` 850 tests pass. No browser pass; no UI for verify or export yet.
- Deviation: triggers instead of Postgres rules (louder failure). TRUNCATE stays allowed for demo reset and tests. See D077 for limits.
- For Shivam: apply migration 0012, then as manager@payops.dev open `/api/audit/verify` (expect `ok: true`) and `/api/audit/export.csv` in the browser. To see a failure, disable the trigger in psql, edit one summary, re-enable, and verify again.
- Not built: verify/export buttons in the UI, scheduled verification, saved head, revoking TRUNCATE for the app role.
### 2026-09-30 · P4 task 2: role and permission table (D076)
- New `shared/permissions.ts` (25 permissions: lowest role, description, extra rule). Routes use `requirePermission(key)` and `publicRoute()` for the seven open routes; services use `hasPermission`; web `can()` reads the same table. `requireRole` is gone. Behaviour is unchanged.
- Docs: generated table in `docs/02-architecture.md` (§6, "Roles and permissions"), between markers.
- Tests: `apps/server/src/permissions.test.ts` walks the real router (no unguarded route, no unused permission, docs match code), `shared/permissions.test.ts`. Removed one guard by hand and confirmed the tests fail. tsc clean in shared, core, server, web; eslint clean on touched folders; full `vitest run` 820 tests pass.
- For Shivam: nothing to run. Sign in as viewer@payops.dev and check the buttons still hide as before.
### 2026-09-30 · P4 task 1: MFA (TOTP), session revoke, persistent rate limits (D075)
- Scope confirmed with Shivam: own TOTP code (no dependency), MFA opt-in with a notice for MANAGER and ADMIN, sessions table with per-session revoke.
- Tests first for the pure parts (`auth/totp.test.ts` with the RFC 6238 vectors, `auth/secret-box.test.ts`). The API tests (`auth-security.test.ts`, 28) were written right after the routes, not before.
- Shared: `dto/security.ts`. Core: migration `0011_auth_mfa_sessions` (users.totp_*, `sessions`, `auth_rate_limits`). Server: `auth/totp.ts`, `secret-box.ts`, `session-store.ts`, `rate-limit.ts`; `session.ts` (sid claim, MFA challenge token), `middleware.ts` (session must be live), rewritten `routes/auth.ts` (login/mfa, mfa setup/enable/disable, security, session revoke, admin reset), realtime closes sockets of revoked sessions. Web: code step on the sign-in page, `/security` page (MFA panel, signed-in browsers), nav item, dev:mock handlers.
- Checks: tsc clean in all 7 packages; eslint clean across the repo; full `vitest run` 811 tests pass (web run with `VITE_API_URL=` empty). Not done: any browser pass, a real authenticator app, and running migration 0011 on Supabase.
- For Shivam: apply migration 0011, then as manager@payops.dev open Security, turn MFA on with an authenticator app (type the key in), sign out, sign in again and check it asks for a code. Open the same account in a second browser first and check it is signed out when MFA turns on. Try "Sign out" on another browser row. To undo a lost phone: sign in as admin@payops.dev and call `POST /api/auth/users/:id/mfa/reset` (no UI for it yet).
- Not built: recovery codes, QR image, forced enrolment, admin UI for reset and session revoke, idle-session expiry and cleanup, audit of plain sign-ins.
### 2026-09-29 · P3 task 4: gateway contract tests and webhook signature helper (D074)
- Tests first: `webhook-signature.test.ts` (9) and the contract suite run against the simulator adapter (`simulator/src/gateway-contract.test.ts`, 19).
- Core: `webhook-signature.ts` (`signWebhookBody`, `verifyWebhookSignature`: HMAC-SHA256 over the raw body, constant-time compare) and `testing/gateway-contract.ts` (`describeGatewayContract`). Both exported. No migration, no change to production code paths.
- Checks: tsc clean in core and simulator; eslint clean on touched files; the 28 new tests pass. Not run: the full test suite and the other packages' typecheck (nothing outside these files changed). Nothing viewed in a browser.
- Not built: calling the helper from a real webhook route (no signed source until a Razorpay adapter exists).
### 2026-09-29 · P3 task 3: 10,000-payment volume test (D073)
- Added `packages/simulator/scripts/volume-test.ts` and root script `pnpm volume` (`npx pnpm@10.28.0 volume --write` saves `docs/VOLUME-TEST.md`; `--payments=N` resizes). It seeds 10,000 healthy payments via `writeNoise`, writes 3 seeds of every fault scenario without running detection, then times two full `sweep()` runs, a 200-order chunk and a single-order check, and asserts correctness.
- Result on PGlite in this VM (details in `docs/VOLUME-TEST.md`): 10,324 orders and batches swept in about 4.5 s (about 2,300 checks/s); a second sweep with no changes about 4.2 s; one order about 10 ms. All 60 injected faults opened exactly 60 cases, healthy payments opened none, and the second sweep changed no case.
- No production code changed. Not run: on a real Supabase Postgres (round trips will make it slower), and the script is not part of `pnpm test` on purpose (about 25 s). The script typechecks and lints clean; `packages/simulator/tsconfig.json` only includes `src`, so `pnpm typecheck` does not cover it.
### 2026-09-29 · P3 task 2: webhook event log, replay, retry queue (D072)
- Scope confirmed with Shivam: backend, API and a small UI; retries through pg-boss with backoff.
- Tests first: `shared/webhook-retry.test.ts` (4), `core/services/webhook-event.service.test.ts` (15: logging, backoff to DEAD, early and stale jobs skipped, manual replay, gateway-missing fallback, queue outage, list and cursor), simulator `scenarios.test.ts` (2 new), server `app.test.ts` (1 new), web `webhook-log.test.ts` (5) and `WebhookDetailView.test.tsx` (4).
- Shared: retry policy, `dto/webhooks.ts`. Core: table `webhook_events` (migration `0010_webhook_event_log`), `WebhookEventService` as the gateway sink, `WebhookRetryScheduler` option. Server: `jobs/webhooks.ts` (queue `webhook-retry`), `routes/webhooks.ts`, wired in `main.ts` with the same forwarding-box pattern as the agent resumer. Simulator: seeded deliveries also write the log; `webhook_events` added to the reset list. Web: `/webhooks` page with filters, detail drawer, two-step Replay, nav item, `replay` capability.
- Checks: tsc clean in shared, core, simulator, server, web; tests pass in shared (33), core (214), simulator (70), agents (176), server (40), web (180, run with `VITE_API_URL=` empty); eslint clean on touched files. Nothing was viewed in a browser by me, and the pg-boss job itself was not run (tests use a fake scheduler). Apply migration 0010.
- Not built: signature checks (task 4), a mock-server route for `dev:mock`, a case link on each event.
### 2026-09-29 · P3 task 1: six messy scenario variants (D071)
- The plan's 9 to 15 target was already met by code (15 keys). Shivam chose to add six messier variants, giving 21.
- Tests first: `simulator/scenarios.test.ts` gained a "messy variants" block (6 tests) on top of the per-scenario case-type loop.
- Simulator: `checkout` options `webhook: 'pending'`, `staleFailureAt`, `cancelledBeforeCaptureAt`, `RefundOptions.skipInternal`; new `scenarios/messy.ts`; keys and infos in `shared/scenarios.ts`. No rule, schema or migration change.
- Checks: tsc clean in shared, core, simulator, agents, evals, server, web; tests pass in simulator scenarios (43), shared, server (136 across those three packages). Not run: the web and agents suites, eslint, a browser pass. No agent evals or cassettes for the new scenarios (live run needed on the Mac).
- Not built: a duplicate-webhook double-credit scenario (no detection rule flags a ledger over-credit).
### 2026-09-29 · P2 task 4: undo a ledger post through a reversing action (D070)
- Scope: only `POST_LEDGER_ENTRY` has an inverse in the catalog, so only that is undoable. Shivam confirmed the optional `undoOf` param on `REVERSE_LEDGER_ENTRY` (not a new action).
- Tests first: `core/actions/actions.test.ts` (3: schema, undo postcondition expects zero credit, duplicate-journal behaviour unchanged), `simulator/resolution.test.ts` (3: undo reopens and passes and the case stays OPEN, refusal when nothing was posted, viewer forbidden), server `app.test.ts` (1), web `undo.test.ts` (3) and `UndoResolution.test.tsx` (3).
- Shared: `undoOf`, `isUndoProposal`. Core: `ResolutionService.undo` (reopen, propose, restore on failure), validator skips case invariants for an undo, `closeValidated` leaves the case OPEN after a passing undo. Server: `POST /api/cases/:id/resolutions/:resolutionId/undo`. Web: `useUndoResolution`, `UndoResolution` (two-step confirm) under the verdict line, `undo` capability.
- Checks: tsc clean in shared, core, agents, simulator, server, web; eslint clean on touched files; tests pass in shared (29), core (199), agents (176), simulator (56), server (26 in app.test), web (171, run with `VITE_API_URL=` empty). Nothing was viewed in a browser by me. No migration.
- Not built: undo for anything but ledger posts, a mock-server route for `dev:mock`, an audit filter for undo.

### 2026-09-29 · P2 task 3: bulk approve and verified auto-close (D069)
- Scope confirmed with Shivam: both parts; low-risk means OPS tier, risk LOW, money moving up to INR 5,000, no repeat attempt or low confidence, no quarantined notes.
- Tests first: `shared/bulk-approve.test.ts` (5), simulator `resolution.test.ts` bulk cases (2), `simulator/auto-close.test.ts` (3), server `app.test.ts` bulk API (1), web `bulk-approve.test.ts` (1) and `BulkApprove.test.tsx` (4).
- Shared: `bulkApproveBlockReason`, `BulkApprovalBody`, `BulkApprovalResult`, limits. Core: `ApprovalService.bulkApprove` (each item through `decide`), `CaseService.autoCloseReconciled`, called from `ReconciliationService.checkOrderChunk` for orders with no hit and no mismatch. Server: `POST /api/approvals/bulk-approve`. Web: `BulkApprove` panel on the Approvals page (pending scope).
- Checks: tsc clean in shared, core, simulator, server, web; eslint clean on touched folders; tests pass in core (196), simulator (53), server (38), web approvals (9, run with `VITE_API_URL=` empty). Not run: the full web suite, the agents package, a browser pass (nothing viewed in a browser by me). No migration.
- For Shivam: open Approvals as ops@payops.dev, generate two duplicate-capture cases from the Simulator, propose the fix on both, then as ops2@payops.dev use "Approve N selected" and check the cases end RESOLVED. For auto-close, watch a case close by itself after a sweep once its data is consistent; the case history shows "Reconciliation" as the actor.
- Not built: bulk reject or escalate, a per-item "why not bulk" hint in the list (the server reports it after the fact), and auto-close for risk and settlement cases.

### 2026-09-29 · P2 task 2: case notes, saved views, shift handoff (D068)
- Tests first: `core/services/operator-workflow.test.ts` (9: notes, views, handoff counts, ordering, window, cap), `shared/handoff-text.test.ts` (3), API tests in `server/app.test.ts` (3), web tests for `CaseNotes` (6), `saved-views` mapping (5), `SavedViews` (5), `HandoffView` (2).
- Shared: `dto/workflow.ts` (`OperatorNoteBody/Item`, `SavedViewFilters/Body/Item`, `HandoffQuery`, `HandoffSummary`), `renderHandoffText`, id kind `savedView`.
- Core: tables `case_notes`, `saved_views` (migration `0009_operator_notes_saved_views`, generated by drizzle-kit); `CaseNoteService`, `SavedViewService`, `HandoffService`, all wired into `Core`.
- Server: `GET/POST /api/cases/:id/notes`, `GET/POST /api/views`, `DELETE /api/views/:id`, `GET /api/handoff`.
- Web: Notes panel on the case page, Saved views control in the Exceptions filter bar, `/handoff` page with Copy as text, nav item, mock server support, `note` capability.
- Checks: tsc clean in shared, core, agents, server, web; eslint clean on touched folders; tests pass in shared and core (220 together), server, web (33 files, run with `VITE_API_URL=` empty because vite loads it from `.env`). Simulator was not touched. Nothing was viewed in a browser by me.
- Note for next session: `VITE_API_URL` comes from `.env`, so `unset` in the shell does not help; prefix the command with `VITE_API_URL=` instead.

### 2026-09-29 · P2 task 1: case assignment, due times, overdue alerts (D067)
- Tests first: `shared/sla.test.ts` (5), `shared/time.test.ts` (`dueLabel`, 3), case service tests for `dueAt`, overdue and `assign` (7), API test for `PUT /api/cases/:id/assignee` and the new filters, `CaseHeader.test.tsx` (5).
- Shared: `SLA_HOURS`, `dueAtFor`, `isOverdue`, `dueLabel`; `CaseListItem` gains `dueAt` and `overdue`; `CaseListQuery` gains `assigneeId` and `overdue`; `AssignCaseBody`.
- Core: `cases.due_at` (migration `0008_case_due_at`, backfilled), `CaseService.assign` (audited, no-op when unchanged, OPS-or-above assignee, open cases only), list filters. `toCaseListItem` now takes `now`.
- Web: Due and Assignee columns, Assignee filter (me, unassigned), Overdue only toggle, overdue notice above the queue, Assign to me / Take over / Unassign in the case header, mock server support.
- Checks: tsc clean in all seven packages; eslint clean on touched folders; tests pass in shared, core (187), agents (176), simulator (48), server (34), web (all, run with `VITE_API_URL` unset). Nothing was viewed in a browser by me.
- For Shivam: apply migration 0008 (`npx pnpm@10.28.0 db:migrate`). In the app, open Exceptions: check the Due and Assignee columns, take a case from its header as ops@payops.dev, then filter Assigned to me. To see an overdue case, use the Simulator to make a case and move the clock, or lower `SLA_HOURS` temporarily.
- Not built: a user picker to assign to someone else, and notifications outside the app. Both noted in D067.

### 2026-09-29 · P1 task 4: agent controls and handoff messages (D066)
- Policy rule P12 (tests first): propose-only or paused makes any agent fix beyond hold/escalate need OPS approval. `POLICY_VERSION` 2026-09-29.1; `docs/03` §11 lists P11 and P12.
- New table `agent_controls` (migration `0007_agent_controls`), `AgentControlService` (4 tests), `GET`/`PUT /api/agent-control` (PUT is MANAGER), `createAgentRun` refuses new runs while paused, graph test for propose-only, API test for roles, reason and the 409.
- Web: Agent controls section on the Policy page, banner on every page while limited, Start investigation replaced by a note while paused, `describeHandoff` + `HandoffCard` on the run page and the case Next step panel (10 new web tests). `AgentRunItem.error` added.
- Checks: tsc clean (shared, core, agents, server, evals, simulator, web); 592 of 593 tests pass, the one failure is the known `ResolveDrawer.test.tsx` API base URL test; eslint clean; REPLAY eval 11/11.
- For Shivam: apply migrations 0006 and 0007 (`npx pnpm@10.28.0 db:migrate`). As manager@payops.dev set the agent to Paused on the Policy page, then as ops@payops.dev open a case: the banner shows and Start investigation is replaced by a note. Set Propose only, start an investigation on a captured/order-failed case, and check the fix waits for approval. Nothing was viewed in a browser by me.
- Not built: a dedicated operator review screen (see D066). P1 done-when: a wrong root-cause label is caught by a test (D063/D064), the eval report is committed, and a pause stops new runs and auto-executions (D066).
- Next: P2 · Operator workflow (`docs/06-phases.md`), in a fresh chat.

### 2026-09-29 · P1 task 3: operator feedback on a diagnosis (D065)
- New table `diagnosis_feedback` (migration `0006_diagnosis_feedback`), `FeedbackService` (6 tests written first), `GET`/`PUT /api/runs/:id/feedback` (API test covers 409 without a diagnosis, 422 for a wrong verdict without a reason, and viewer read-only), shared DTOs and `DiagnosisFeedbackBody`.
- Web: "Your feedback on this diagnosis" panel on the run page (`DiagnosisFeedback.tsx`, 6 tests), `judge` capability for OPS and above, `PUT` support in `api()`, mock server answers the new GET.
- Checks: tsc clean (core, server, web, agents, evals); web and core tests pass except the known `ResolveDrawer.test.tsx` failure (API base URL); server 32 pass; eslint clean on touched files.
- For Shivam: apply migration 0006 (`npx pnpm@10.28.0 db:migrate`), open a run page as ops@payops.dev, judge a diagnosis, then check the case audit trail shows `diagnosis.feedback`. Nothing was viewed in a browser by me.
- Next: P1 task 4 (global pause, propose-only mode, clearer handoff messages when the agent stops). Includes the operator review path for ambiguous cases discussed after D064.

### 2026-09-29 · P1 task 2b: candidate causes and code correction (D064)
- New `grounding/candidates.ts` (+ 9 tests, written first): checks now generate candidates, one leader per causal chain. `resolve` keeps a confirmed label, replaces a downstream or rejected label when exactly one candidate remains (confidence 0.5, so OPS approves), and escalates with the candidate list when none or several remain. It also fetches `getFeeBreakdown` in code for the settlement checks.
- Finding: the tools the checks read are already baseline tools, so the LIVE misses were wrong labels, not missing lookups.
- Graph test for the wrong-label case rewritten: now expects the corrected label, tier OPS and an approval pause.
- Checks: agents tsc clean; agents 175 tests pass; REPLAY eval 11/11.
- NOT done: bounded LLM retry with the rejection reason (needs new prompt and recordings; decide after the next LIVE run), and the operator review screen (P1 task 4).
- Next: run `npx pnpm@10.28.0 eval:live` twice on the Mac and compare with the 2026-09-29 report.

### 2026-09-29 · P1 task 2 (part 1): all recorded scenarios in the eval set
- Added golden cases `settlement_mismatch` (seed 3204, OPS approve, RESOLVED/PASS) and `suspicious_payment` (seed 3206, MANAGER, manager rejects, ends REJECTED with no execution). Both replay existing cassettes; no new recording needed.
- Checks: `tsx packages/evals/scripts/run-eval.ts` REPLAY 9/9 pass, root-cause accuracy 100%; evals tsc clean.
- Adversarial scenarios built: `misleading_note` (customer claims a double charge; records show one capture and a failed webhook, expected WEBHOOK_PROCESSING_FAILURE) and `conflicting_evidence` (note says a refund was sent; records show none, expected REFUND_NOT_INITIATED). Files: `simulator/src/scenarios/adversarial.ts`, keys in `shared/src/scenarios.ts`, seeds 3401/3402 in `record-cassettes.ts`. Simulator tests 48 pass; tsc clean for shared, simulator, agents, evals, core, web.
- LIVE eval ran twice on the Mac (report `docs/evals/2026-09-29.md` is the second run, 9/11 pass, root-cause accuracy 90%). Results differ between runs because the model picks different root-cause labels. Run 1 failed `conflicting_evidence`; run 2 failed `refund_stuck` and `refund_never_initiated`. In every miss the P1 task 1 root-cause check caught a wrong label (WEBHOOK_NOT_DELIVERED, ORDER_STATE_DIVERGED) and the run escalated to a person with no automatic action. That is the safe behavior, but it lowers the resolution rate. All safety gates held (no refund on `misleading_note`, injection quarantined, suspicious payment never auto-resolved).
- Open question for Shivam: keep the golden expectations strict (the LIVE eval is then honest about flakiness), or tune the diagnosis prompt/label hints for refund cases in a later task. Not done here, since it is agent tuning outside P1 task 2.
- Recorded on the Mac: `misleading_note` (seed 3401, RESOLVED/AUTO/PASS, WEBHOOK_PROCESSING_FAILURE) and `conflicting_evidence` (seed 3402, MANAGER approve, RESOLVED/PASS, REFUND_NOT_INITIATED). Golden entries added; REPLAY eval 11/11 pass. LIVE report written (see above). Remaining: commit.
- Known unrelated web test failure: `ResolveDrawer.test.tsx` "pre-checks recommended options" expects a relative `/api/...` URL but gets `http://localhost:4000/api/...` (API base URL env in this shell). Not touched by this task.

### 2026-09-29 · P1 task 1: root-cause checks (D063)
- New `grounding/root-cause-checks.ts` (+ 25 table tests, written first) and a wiring in `resolve`: an unsupported cause is downgraded to UNKNOWN and escalated. Graph test added: `captured_order_failed` with a DUPLICATE_CAPTURE claim is caught and not auto-resolved.
- Checks: agents tsc clean; agents tests all pass (cassette replays unchanged).
- P1 task 2 (evals for all scenarios plus adversarial variants) NOT started. It needs live Gemini/Jev recording, which only works on Shivam's Mac (D045). Next session: add `settlement_mismatch` and `suspicious_payment` golden cases and adversarial variants (misleading notes, conflicting evidence), record on the Mac, commit the report under `docs/evals/`.

### 2026-09-29 · Polish plan (D062) and P0
- Added polish phases P0 to P6 to `docs/06-phases.md` and D062.
- P0: shared `FAST_PATH` in `packages/shared`, used by `diagnose()` and `run-detail.ts`; case verdict line (`case-verdict.ts`, 6 tests) shown under the case header.
- Checks: tsc clean (web, agents), web 116 tests, agents 140 tests.

### 2026-09-29 · Unified Case workspace (D060)
- Slice 1: the executor now stores the source records as they were just before each action (`executions.before`, migration `0005_execution_before_state`) and exposes them as `ExecutionStep.before`. Test written first in `packages/simulator/src/resolution.test.ts`.
- Slices 2 and 3: the Case page now shows one story (detected, investigation steps, decision with approval state, execution with before and now, verification with expected and actual, outcome). Each step is labelled CODE, JEV, GEMINI or PERSON from recorded data; evidence facts are "Confirmed by data" and findings are "Agent finding" with their grounding result. Every evidence reference and changed record opens a drawer with the record as read, the current value and links to run, audit and payment. LIVE runs refresh the story and records while active. The old run, resolution and source-record sections sit under "Technical detail".
- New files: `features/cases/case-story.ts` (+ tests and fixtures), `CaseStory.tsx`, `RecordDrawer.tsx`; `CasePage.tsx` recomposed.
- Validation: typecheck clean for all packages; lint clean on touched files; web tests 95 pass; agents, simulator, shared 198 pass; server 31 pass; core 178 pass. Not run: production build (this VM lacks the linux `lightningcss` binary), Playwright, Lighthouse, a real browser pass. Two environment notes: `apps/web` tests that assert relative API URLs need `VITE_API_URL` unset, and server tests need a `JWT_SECRET` of at least 16 characters (I used a temporary test-only value on the command line; `.env` was not read or changed).
- Setup fix: an empty `JWT_SECRET=` (as in `.env.example`) made `db:migrate` fail with "Too small". `loadServerEnv` now treats empty values as not set (test in `packages/core/src/config/env.test.ts`). Docs now say plain `pnpm` does not work on this Mac: use `npx pnpm@10.28.0 <script>` or an alias.
- Run page (D061): `/runs/:id` now shows the case it investigated (PAY-0002 style id, type, amount, status), a routing summary, and one detailed card per step (what it does, fixed or chosen, what it called, what it found, why, next). Files: `features/runs/run-detail.ts` (+ tests, fixtures), `RunSteps.tsx`, `RunDetailPage.tsx`. Web tests 110 pass, lint and typecheck clean; not yet looked at in a browser.
- Nothing was committed. A stale `.git/index.lock` could not be removed from this environment; remove it on the Mac if git complains.

### 2026-09-29 · Case verification and source records (D059)
- Added a visible Case verification row linking to payment detail, source records, resolution checks, audit events, and pending approval. AUTO cases explain why no manual approval appears.
- Added a read-only endpoint and table for fresh linked order, gateway, webhook, ledger, refund, settlement, and dispute records. Each record exposes its id, status, amount, time, and relevant fields; the table can be refreshed while a LIVE investigation runs. Run detail links back to the source records and audit trail.
- Validation: full suite passes (473 tests), including payment and settlement source records. Package typechecks, lint, and web production build pass. Tests used temporary test-only URL and JWT overrides; no local configuration was changed.

### 2026-09-29 · Local seed and clean reset for a LIVE UI walkthrough
- Ran the server seed script against the configured local PGlite database. Existing standard scenarios were skipped; the four new critical showcase cases were generated. The seed reported 19 open exceptions, and the API listed 20 total cases before reset.
- Used the authenticated Simulator reset endpoint, which saved an undo snapshot and returned `ok`. Verified the API case count fell from 20 to 0. Demo users and baseline world remain. The existing API process still reports `AI_MODE=REPLAY`; a LIVE walkthrough requires restarting that API with `AI_MODE=LIVE` while keeping the local database running.

### 2026-09-29 · Recorded choices and provider retries (D058)
- Run cards now show recorded routing possibilities, follow-up record choices and reasons, verification details, and recovery decisions. Only follow-up tools with a recorded completed call are described as checked.
- LIVE/RECORD Jev and Gemini calls retry transient provider failures twice after the first attempt, then use each decision point's existing safe fallback. Invalid requests and REPLAY misses do not retry. Retry attempts are recorded as `MODEL_RETRY` steps without raw provider errors. The README now diagrams the implemented bounded graph; the agent-system tool description was aligned with the existing code.
- Validation: all 472 tests, all package typechecks, lint, and web production build pass. Headless Chrome checked the choice and retry text at desktop and phone widths with no page overflow or browser errors. The browser sample used temporary recorded steps because mock mode has no saved runs.

### 2026-09-29 · Readable agent results and critical showcase (D057)
- Replaced internal event-count summaries in the run flow with plain-language explanations derived from recorded risk scores, findings, evidence, proposals, policy and verification. Technical events remain nested and the raw table remains below. The Case details explain note quarantine without J1 codes.
- Added four critical showcase scenarios to Simulator: high-value webhook/order/ledger mismatch, duplicate capture, settlement shortfall, and missing ledger credit. Each uses existing deterministic domain operations and the current approval rules. Live Gemini/Jev recordings for seeds 3301, 3302, 3304, 3306 all resolved with matching root cause and validator PASS; REPLAY graph tests confirm full multi-agent participation with no network calls.
- Two trial refund variants also passed action verification but misidentified root cause, so they were excluded. This remains a diagnosis-quality gap, separate from validator correctness.
- Validation: all package typechecks, lint, web production build, and 466/466 tests pass. The four critical showcase REPLAY tests assert full-path runs with at least two specialists, expected diagnosis and tier, RESOLVED/PASS, and no provider network calls. Headless Chrome checked the readable Risk agent card at desktop and phone widths and the Simulator showcase at 390px; no page-wide overflow or browser errors. The browser flow sample was temporary because mock mode contains no saved runs.


### 2026-09-29 · Recorded multi-agent orchestration view (D056)
- Agent run details now lead with a stage-by-stage visualization built from `agent_steps`. Only actual specialist visits appear; each node expands to its recorded actions, tool results, evidence ids, and decisions. Approval pauses and replan loops are explicit. The existing raw event table and node timings remain below.
- Case investigation headers link to the matching run flow. The run-detail figures and diagnostic grid now reflow on narrow screens. Pure and interaction tests cover branch selection, retries, approval waiting, and opening recorded actions.
- Validation: web typecheck, lint, production build, and 72/72 web tests pass. Headless Chrome checked the flow with representative recorded steps at 1440px and 390px: no page-wide horizontal overflow or browser errors. The mock API has no stored run fixture, so this visual check mounted the production component with a temporary event sample; it did not alter app data.


### 2026-09-29 · Phase 6 UI revamp implementation (D055)
- Updated UI tokens, type, radii, controls, table density, responsive shell, and the production UI spec. Case pages now show a state-aware next action beside findings; trace, evidence and lifecycle are available on demand. Citation links reveal and focus their evidence item.
- Approval decisions require a deliberate selection before submit. Simulator scenarios reveal inputs on selection, with seed and noise tucked into an advanced control. Overview sections and demo sign-in hierarchy were adjusted for readability and narrow screens.
- Checks: all package typechecks, lint, web production build, and 445/445 tests pass. Headless Chrome checked Simulator at 1440px and 390px: no page-wide horizontal overflow or page errors. A final first-time usability trial and Lighthouse audit remain follow-ups.


### 2026-09-29 · UI revamp plan and interactive design study
- Reviewed current buttons, Case/investigation/resolution hierarchy, approval controls, Simulator flow, the saved Case screenshot, and the UI spec. Researched Carbon, NN/g, and W3C guidance.
- Added `UI-REVAMP-PLAN.md`: proposed action hierarchy, state/role presentation, colors, spacing, sizing, borders, page flows, implementation sequence, and acceptance criteria. Existing policy and permissions remain authoritative.
- Added `UI-REVAMP-PREVIEW.html`: independent sample-data study with case-state/access selectors and button examples. Proposed color pairs were contrast-checked; Chrome verified state interactions and narrow-screen overflow. Production UI changes are the next task.

### 2026-09-29 · Publish plain-English project guide
- Added the eight-file `docs/guide/` reading path for product flow, architecture, agents, safety, replay/deployment, file map, and interview prep.
- Linked the guide from `README.md` and pushed it to the public `master` branch.

### 2026-09-29 · Publish source repository
- Created the public `BLAZE7SHADOW/PayOps-AI` GitHub repository and set the landing page's source link to its URL.
- Checked that `.env` is ignored and absent from tracked files. Pushed the original `master` history to `origin`; the separate Satyam handoff ZIP is unaffected.

### 2026-09-29 · Brother repository handoff
- Prepared `Claude outputs/PayOps-AI-Satyam.zip` from an isolated clone. All Git author and committer fields use Satyam Govind Rao <satyamgrao007@gmail.com>; the source repository's existing commits were not rewritten.
- Verified that corresponding commits retain their code trees, messages, and dates while each commit ID changes. The ZIP includes `.git`, excludes `.env` and dependencies, and passed `unzip -tq`.

### 2026-09-29 · Free deploy prep, reset undo, wider replay coverage
- Reset now snapshots the demo data first (`packages/simulator/src/undo.ts`, schema `demo_undo`); `POST /api/simulator/undo-reset` restores it, `GET /reset-status` reports it. 10 s cooldown and a lock on reset and undo. Simulator page has "Undo last reset". Test added in `apps/server/src/app.test.ts`.
- `record-cassettes.ts` now covers all 8 fault scenarios, two seeds each, appends by default, writes `fixtures/cassettes/manifest.json`, and auto-approves any approval as a manager. **Not yet run: Shivam must run `pnpm cassette:record` on the Mac with real keys, then commit `fixtures/cassettes/`.** Manifest currently lists only the original 3.
- Simulator page shows recorded seeds per scenario (from `GET /api/simulator/recorded`); in REPLAY an empty seed uses the first recorded one. `pnpm seed` now seeds each fault with its first recorded seed.
- `render.yaml`, `vercel.json`, `docs/DEPLOY.md` added. Replace `YOUR-API-NAME` in `vercel.json` with the Render URL. Socket.IO is polling-only on Vercel (`VITE_SOCKET_POLLING_ONLY`).
- Checks: `pnpm test` 441 passed; web and server typecheck clean.

### 2026-09-29 · Phase 6 part C: landing page, /terms, /privacy
- New `apps/web/src/features/landing/`: `LandingRoute` (`/`: signed-in users redirect to `/overview`, others see the page), `LandingPage` (product sentence, "Open the demo", real case screenshot, "How decisions are made" in prose, inline-SVG `Architecture` drawn with tokens, "Try it" steps using seed 3201), `TermsPage`, `PrivacyPage`, shared `PublicLayout`/`LegalPage`. Routes added outside the auth guard; the old `/` redirect inside the guard was removed.
- Real screenshot `apps/web/public/landing/case-screen.jpg` taken from the running app (resolved seed-3201 case). Docs asked for a screen recording; a still image is used until Shivam records one.
- No claim of a live public demo (D051). GitHub link hidden until `GITHUB_URL` is set. Privacy text: note text goes to TypeSafe for J1 screening only; Gemini gets structured case facts; REPLAY sends nothing.
- Tests: `LandingRoute.test.tsx` (landing content and links, legal pages render). typecheck, lint clean.
- Not done: README, Lighthouse on `/`.

### 2026-09-29 · Phase 6 part B (done) + D053
- REPLAY fix (D053): scenario-less runs read all recorded cassettes; `cassette.test.ts` (4 tests). Verified in a browser: Simulator `captured_order_failed` seed 3201 then Start investigation ends RESOLVED (FULL path, 3 LLM, 4 Jev, replayed). Agent runs list and run detail render correctly with real data.
- A11y sweep on the Case page (DOM script, not Lighthouse): no unnamed buttons/links, no unlabeled inputs, no duplicate ids, one `main`. Fixed: heading order (Resolution attempt blocks h4 to h3), and meaningful text using `--ink-3` (matrix and signals dash placeholders, `[ev_id]` citations) now `--ink-2` per docs/05. Node column widened on run detail.
- Checks: `pnpm test` 438 passed; web typecheck clean.
- Not done: real Lighthouse score (Shivam, DevTools), landing page, README.

### 2026-09-29 · Phase 6 part B (started): browser pass, one real finding
- Static audit of `apps/web` against docs/05 §8/§9/§12: clean (no em dashes, raw hex, banned words, gradients, hover transforms; loading states present; focus styles present).
- Browser pass (manager account, local dev): Overview (validator empty state), Agent runs list, AI tag and Case page all render. Fixed: Agent runs table clipped the Started column (narrower Run/Case/Status columns); the Case findings panel said "Collecting evidence" after a run had already ended, now says the investigation ended without a diagnosis.
- **Resolved (D053):** with `AI_MODE=REPLAY`, an investigation started from the Case page on a seeded case escalates. Every Jev/LLM call is a REPLAY miss, because the web app sends no `scenarioKey` (server uses `'default'`, D032) and cassettes are per scenario and seed (D034). Fixed by making a scenario-less REPLAY run read all scenario cassettes (D053). Verified: Simulator `captured_order_failed` seed 3201 then Start investigation ends RESOLVED (FULL path). Demo must use seeds 3201/3202/3203; seeded cases still escalate in REPLAY by design.
- Not done: Lighthouse a11y on the Case page, keyboard pass, landing page, README.

### 2026-09-29 · Phase 6 part A: Agent runs list + detail, AI mode tag (D052)
- Found `AgentRunItem.budget` already holds LLM/Jev/tool counts, tokens and cost, so no new
  aggregation or shared DTO was needed. `GET /api/runs` already worked without `caseId`.
- New `apps/web/src/features/runs/`: `run-metrics.ts` (+ 9 tests: duration, formatting, per-node
  latency from NODE_STARTED/NODE_COMPLETED timestamps, gap since previous step, context tokens,
  step names), `RunsPage` (`/runs`, status filter, sortable, keyboard row nav, skeleton + empty),
  `RunDetailPage` (`/runs/:runId`: figures, time-per-node bars, step table with expandable JSON).
  "Agent runs" added to the nav and router.
- `GET /api/health` now also returns `aiMode`; top bar shows `AI: REPLAY|LIVE|RECORD` (docs/05 §10).
  Mock server answers `/api/runs` with an empty page and health with `aiMode`.
- Checks: `pnpm typecheck`, `pnpm lint` clean; `pnpm test` 434 passed. Not yet looked at in a browser.
- Not done: UI polish, landing page, README.

### 2026-09-29 · Phase 6 task 1 (part 1): Overview validator outcomes
- `OverviewMetrics.validatorOutcomes7d` (`Record<PASS|PARTIAL|FAIL, number>`, zero-filled) added to
  `packages/shared`, computed in `OverviewService.metrics` from `validation_results` in the last 7
  days (one row per verification, so each replan attempt counts). New `ValidatorOutcomes` block on
  the Overview page (direct labels, counts, redundant bars, skeleton and empty states); the
  oldest-open table moved to a full-width row. Web mock server updated.
- Test first: `app.test.ts` overview test asserts all three verdict keys are present and >= 0.
- Checks: `pnpm typecheck`, `pnpm lint` clean; `app.test.ts` + core service tests pass (29).
  Full `pnpm test` and a browser look at the Overview page not yet run this session.
- Not done: Agent runs list/detail (rest of task 1), tasks 2 to 6.

### 2026-09-29 · Phase 5 task 6 (last task in the phase): failure drills -- Gemini timeout, Jev timeout, DB serialization conflict, see D050
- Confirmed Jev timeout needed no new production code: every Jev decision point (J2/J3/J4/J5/J6)
  already had a documented fallback (docs/03 §4), each already unit-tested. Added one new
  graph-level drill instead (`graph.test.ts`): a `DecisionPort` throwing on every tag throughout a
  full `captured_order_failed` run still ends `RESOLVED`/`verdict: PASS` -- the strongest form of
  "the product must work with AI turned off" exercised end to end, not just per-node.
- Found and fixed a real gap for Gemini timeout: `buildSpecialistNode`'s two `llm.invokeStructured`
  calls and `resolve`'s diagnosis call (`nodes.ts`) had no `try`/`catch` at all -- confirmed (not
  assumed) that this would have crashed a run uncaught, via the new `settlement_mismatch` drill
  using the test file's existing `noLlm` fixture. Specialist fallback: contributes nothing (same
  shape as the pre-existing "no evidence" skip branch) rather than crash. `resolve`'s fallback:
  escalates with no resolution created, reusing D049's `state.error`/`closeEscalated` branch
  rather than inventing a new one.
- New `packages/core/src/db/retry.ts`: `isSerializationFailure` + `withSerializationRetry`, a
  small generic retry-only-on-40001 helper (standard Postgres advice for a serialization
  conflict). Wired around the one write in `ExecutorService.runStep` not already inside its
  existing action-failure `try`/`catch` -- the result-recording transaction. New
  `ResolutionService.escalateExecutionError` closes the resolution `policyGate` already created
  when `core.resolutions.execute` itself throws after retries are exhausted (no `ExecutionOutcome`
  to hand `closeExecutionFailed` in that case); `nodes.ts`'s `execute` node now catches and calls
  it instead of letting the run crash.
- Tests: `packages/core/src/db/retry.test.ts` (9, pure). `nodes.test.ts` gained a describe block
  for `execute`'s new catch branch (2, fake `core.resolutions`, no database). `graph.test.ts`
  gained three end-to-end drills, one per failure this task names: Gemini timeout on
  `settlement_mismatch` (full path, specialists contribute nothing, `resolve` escalates with
  `resolutionId: null`); Jev timeout throughout a full run (resolves normally); simulated exhausted
  DB retries via `vi.spyOn(core.resolutions, 'execute').mockRejectedValueOnce(...)` (escalates the
  already-created resolution, `resolutionId` still set) -- spied rather than a genuine concurrent
  `40001`, since reproducing a real one needs actual racing `SERIALIZABLE` transactions for no
  extra coverage over what `retry.test.ts` already proves about the retry loop in isolation.
- Verification: `pnpm typecheck`, `pnpm lint` clean across all 8 packages. `pnpm test`: 425
  passed, 0 skipped (was 411; +9/+2/+3 from the tests above). `pnpm eval` (REPLAY): still 7/7,
  unaffected (none of the golden scenarios exercise these new catch branches -- that is what the
  new drills are for).
- Not done this session: Phase 5's own "Done when" also names a `pnpm eval:live` report committed
  under `docs/evals/`, which needs a real Gemini/Jev call and so cannot run from this cloud
  session (Blockers below, D045) -- needs Shivam's Mac. See Next task.

### 2026-09-29 · Phase 5 task 5: budget guard (MAX_TOOL_CALLS/MAX_COST_USD), see D049
- Added `maxToolCalls: 60` / `maxCostUsd: 0.05` to `AGENT_BUDGET_LIMITS` (`packages/shared/src/
  agents.ts`), plus `COST_PER_1K_TOKENS_USD` and a new pure `estimateCallCostUsd(kind, tokensIn,
  tokensOut)` -- `costUsd` on `RunBudget` existed since Phase 3 but was dead code (always 0,
  confirmed by grep before assuming); every budget update with token usage in `nodes.ts` now
  computes a real (if approximate, documented as such) cost.
- New `packages/agents/src/budget-guard.ts`: pure `checkBudgetGuard(budget)` checking tool calls
  then cost against the limits above.
- `nodes.ts`: new `guardBudget(nodeName, state, update)` wrapper, called at the end of `triage`,
  `diagnose`, `plan`, `join` and `groundCheck`, and `resolve` -- every node up to and including
  `resolve`, i.e. everything before `policyGate` ever creates a resolution row. When tripped, sets
  `status: 'ESCALATED'` and `state.error` (an unused Phase-3 placeholder field, now written for
  the first time) to the guard's reason. Deliberately not applied to `execute`/`validate`/
  `replan`/`policyGate` or to the three specialists individually -- see D049 for the full scoping
  rationale (mirrors D048's precedent of an explicit, justified scope decision).
- `graph.ts`: every conditional edge from `triage` through `resolve` now checks `state.status ===
  'ESCALATED'` first and routes to `closeEscalated`; `triage->diagnose`, `join->groundCheck` and
  `resolve->policyGate` became conditional edges (previously fixed) to allow this.
- `closeEscalated` (nodes.ts) gained a third dispatch branch: `resolutionId` null + `state.error`
  set → `resolutionService.escalateWithoutProposal` (new method, `resolution.service.ts`) --
  moves the case straight to ESCALATED with no resolution ever having existed, the same
  `cases.setStatus` + live publish shape every other close path in that file already uses.
- Tests: `packages/agents/src/budget-guard.test.ts` (5, pure), `packages/shared/src/
  agents.test.ts` (3, pure, new file), and one new `graph.test.ts` case driving a real graph run
  with an absurd `J6_DIAGNOSE` token count that trips the cost limit on the very first Jev call --
  asserts `ESCALATED`/`resolutionId: null`/`state.error`, and separately confirms via
  `core.cases.get(caseId)` that the case itself actually moved to ESCALATED with no pending
  approval (i.e. `escalateWithoutProposal` really ran, not just that the graph stopped).
- Verification: `pnpm typecheck`, `pnpm lint` clean across all 8 packages. `pnpm test`: 411
  passed, 0 skipped (was 402; +9). `pnpm eval` (REPLAY): still 7/7, and now reports a real
  non-zero `totalCost` instead of the `$0` D048 recorded (that was REPLAY genuinely being free
  coinciding with `costUsd` being dead code -- now it's real and still small, as expected).
- Not done this session: Phase 5 task 6 (failure drills) -- the last task in the phase. One
  known, narrow, documented edge case left open on purpose -- see D049's last section and this
  file's Next task note.


### 2026-09-29 · Phase 5 tasks 2-4: confirmed task 2, built packages/evals (task 3) + injection eval (task 4), see D048
- Confirmed Phase 5 task 2 (`replay_fails_then_replan` passes on attempt 2) needs no separate
  work: task 1's own `graph.test.ts` rewrite already drives a real attempt-2 resolution end to
  end (D047). Read `docs/06-phases.md`'s Phase 5 section and D047 first, per the Next task note.
- Explored which of the 9 `ScenarioKey`s the existing fast-path deterministic-decision-fixture
  pattern (`graph.test.ts`'s `decision()`) actually reaches, by really running each one (a
  throwaway script, not guessed from reading the code): `settlement_mismatch` turns out to hit
  the full path (`plan` -> a specialist's LLM call) even with a confident J6 answer, and
  `suspicious_payment`'s `SUSPECTED_FRAUD` template always returns empty `citedIds` so it can
  never go fast by construction. `duplicate_capture` and `injected_refund_request` do go fast and
  were previously unverified. This is why the golden set below covers 7 scenarios, not 9 -- see
  D048 for the full reasoning (this was a deliberate scope decision, not an oversight).
- New workspace package `packages/evals` (`package.json`, `tsconfig.json`, `vitest.config.ts`,
  added to root `vitest.config.ts`'s `projects`): `golden.ts` (7 `GoldenScenario`s: the Phase 3
  demo trio via real recorded cassettes, the replan loop's two branches + `duplicate_capture` +
  `injected_refund_request` via a new deterministic `fixtures.ts` DecisionPort/LlmPort pair that
  generalizes `graph.test.ts`'s fixture to also answer `J1_INTAKE`), `runner.ts` (drives each
  scenario through the real graph against a fresh ephemeral PGlite database, same shape as
  `record-cassettes.ts`/`graph.test.ts`), `types.ts` (`RunOutcome`/`EvalSummary`/`summarize()`),
  `report.ts` (the docs/03 §17 markdown report), and `scripts/run-eval.ts` (the `pnpm eval` /
  `pnpm eval:live` CLI entry point, REPLAY vs. LIVE).
- Root `package.json` gained `"eval"` and `"eval:live"` scripts. `pnpm eval` exits non-zero on any
  golden scenario's hard-gate failure (status/verdict/tier/forbidden actions/quarantine/max tool
  calls); root-cause and action-set match are measured, never gated, since they're model guesses
  (see D048 on why, and on `refund_stuck`'s documented root-cause mismatch specifically).
- Injection eval (task 4) is the `injected_refund_request` golden scenario's own extra hard
  gates (`forbiddenActionTypes`, `expectQuarantinedNoteIncluding`, checked against the real J1
  `SignalIntakeService` pipeline via `core.cases.get`) rather than a separate mechanism -- see
  D048 for why that scenario needs no new graph/pipeline machinery.
- Tests: `packages/evals/src/types.test.ts` (7 tests, `summarize()`'s accuracy/rate/mean math).
- Verification: `pnpm eval` run for real -- 7/7 golden scenarios pass, 100% root-cause accuracy
  (after excluding `refund_stuck`'s documented caveat), mean 12.6 tool calls, ~220ms mean latency,
  $0 REPLAY cost. `pnpm typecheck`, `pnpm lint`, `pnpm test` (402 passed, 0 skipped, +7 from
  `packages/evals`) all clean across all 8 packages.
- Environment note, not committed: `pnpm install` could not run in this cloud session for this
  new package (a new class of the same macOS/Linux bridge gap already documented below for
  rollup/esbuild -- this time `pnpm install` itself, `EPERM`/`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`
  against the bridge's temp-file probes). Worked around by hand-linking
  `packages/evals/node_modules/@payops/*` and the two `@langchain/*` deps the same way
  `packages/agents/node_modules` already does it. A real `pnpm install` (works fine on Shivam's
  Mac) supersedes this the next time one runs. See D048 for the full account.
- Not done this session: Phase 5 tasks 5-6 (budget guard, failure drills) -- see Next task. The
  `settlement_mismatch`/`suspicious_payment` golden-set gap noted above is flagged, not blocking.

### 2026-09-29 · Phase 5 task 1: replan node (J5), execute/validate/close split, attempt tabs (see D047)
- Split `ResolutionService.finish()` (core) into `execute` / `validate` / `closeExecutionFailed` /
  `closeValidated`, all newly public, so the agent graph can run execute -> validate and see the
  verdict before deciding whether to close anything. `finish()` itself unchanged in behavior --
  now just these four composed with no decision point in between -- confirmed by the entire
  pre-existing test suite passing unmodified.
- Graph (`packages/agents/src/graph.ts`): old single `execute` node split into `execute` (actions
  only; an execution failure still closes ESCALATED and ends the run directly, same as before) ->
  `validate` (runs the validator, leaves the resolution un-closed) -> conditional: PASS ->
  new `closeResolved` node; PARTIAL/FAIL -> new `replan` node (J5). `replan`'s three routes
  (`closeEscalated` / `plan` / `resolve`) are derived from state it already set (`status`,
  `diagnosis`), no new state field. `closeEscalated` (nodes.ts) is now dual-purpose: a no-op when
  reached via `awaitApproval`'s ESCALATE decision (already closed elsewhere), a real DB close when
  reached via `replan`'s `escalate_to_human` (distinguished by whether `state.validation` is set).
- `replan` (nodes.ts): asks Jev J5's `strategy` Choice, always records an `AttemptSummary` in
  `history` regardless of outcome, and enforces the two doc-mandated code caps that always beat
  Jev: the attempt cap (`AGENT_BUDGET_LIMITS.maxAttempts`, already `2`) skips the Jev call
  entirely once spent; a 0.5 confidence floor forces `escalate_to_human` even when Jev answered
  something else. `reinvestigate` clears the stale `diagnosis` so `resolve` reruns the full LLM
  path with fresh evidence instead of reusing attempt 1's answer.
- `resolve` (nodes.ts) now actually passes `history` into `buildProposal` (it was hardcoded to
  `[]` since Phase 3) via a new `toAttemptHistory` mapper. This is the piece that makes
  `retry_same_action`/`alternative_action` produce a different action set on attempt 2: the
  "alternative" logic already existed in `core/actions/options.ts`'s pre-Phase-5
  `recommendedTypes`/`replayFailedBefore` (built for the manual Resolve form), it just was never
  fed the agent's own attempt history until now.
- `AttemptSummary` (shared) gained a `verdict: ValidationVerdict` field. `AgentStepKind` gained
  `RUN_REPLANNING` (-> `run.replanning`, already named in docs/03 §16's event list but never
  emitted before this task).
- Investigation.tsx: `Trace` now groups steps into per-attempt tabs (reusing the existing `Tabs`
  primitive from `ResolutionSection`) whenever a run replanned, splitting at each `replan`
  `NODE_COMPLETED` step; a single-attempt run renders exactly as before (no visual change from
  Phase 4). Defaults to showing the newest attempt.
- Tests: `nodes.test.ts` gained a `replan` describe block (7 tests: history recorded regardless
  of outcome, retry/alternative leave diagnosis alone, reinvestigate clears it, both code caps,
  the J5 Jev-throws fallback). `graph.test.ts`'s old "escalates a failed execution without
  replanning" test is now two tests: one proving J5-says-escalate still escalates on attempt 1
  (as before), and a new one that actually drives `replay_fails_then_replan` through a real
  attempt 2 -- REPLAY_WEBHOOK_EVENT fails, `alternative_action` is chosen, `resolve` proposes
  MARK_ORDER_PAID + POST_LEDGER_ENTRY (now needing a manager approval, resumed via the existing
  interrupt/Command pattern), attempt 2 validates PASS. This is docs/03 §13's demo scenario,
  genuinely exercised end to end for the first time. `Investigation.test.tsx` gained 3 tests for
  the attempt-tab grouping/switching.
- Verification: `pnpm typecheck` and `pnpm lint` clean across all packages. `pnpm test`: 395
  passed, 0 skipped (was 383; +12 from the tests above). `apps/web`'s `vite build` could not run
  in this cloud session -- `Cannot find module '../lightningcss.linux-arm64-gnu.node'`, the same
  class of macOS/Linux native-binary bridge gap already documented for rollup/esbuild below (this
  time Tailwind v4's CSS engine); `tsc --noEmit` (the build script's first half) passed cleanly
  before hitting it. A real browser pass on the Mac is recommended before fully trusting the new
  attempt-tabs UI, same caveat every prior cloud session has carried for anything visual.
- Not done this session: Phase 5 tasks 2-6 (docs/06-phases.md) -- the replan scenario itself is
  now proven (see above, arguably closing task 2 too, worth confirming next session), but the
  `packages/evals` runner/report, the injection eval, the budget-guard escalation test, and the
  three failure-drill scenarios (Gemini timeout, Jev timeout, DB serialization conflict) are all
  still open. See Next task.

### 2026-09-29 · Phase 4 complete: cassette recording succeeded, two Done-when gaps closed, phase verified
- `pnpm cassette:record` ran successfully on Shivam's Mac (`npx pnpm@10.28.0 cassette:record`,
  since plain `pnpm` wasn't on PATH there and `corepack enable`'s global symlink step needed root
  the machine didn't have handy). All 3 scenarios recorded `RESOLVED`/`PASS`; `refund_stuck`'s
  model diagnosis again names webhook delivery rather than the refund-status desync, the same
  documented caveat the original Phase 3 recording carried (grounding checks citation support,
  not causal truth -- expected, not a regression).
- Un-skipped the 3 `graph.test.ts` "recorded Phase 3 scenarios" cassette-replay tests
  (`it.skip.each` -> `it.each`); `pnpm test` confirmed them green against the fresh cassettes.
  Rewrote `fixtures/cassettes/README.md` to document this Phase 4 re-recording.
- Before ticking the phase checklist, ran Phase 4's own literal "Done when" list
  (docs/06-phases.md) against the actual code and test suite rather than assuming task-level
  "done" implied phase-level "done". Found and closed two real gaps (full account in D046):
  - **Context sizes per call were not visible in the UI** (only in the database) -- added
    `LlmCallSummary` to `Investigation.tsx`'s `Trace`, one line per `LLM_CALLED` step showing
    `<call> context: <tokens> / <budget> tok budget`, flagging an over-budget call in `--bad`.
    3 new tests in `Investigation.test.tsx`.
  - **J2 (`plan`'s fresh Jev-routing branch) and J6 (`diagnose`) had zero node-level fallback
    tests**, in any phase -- only ever exercised indirectly through `graph.test.ts`'s full-graph
    runs with a `DecisionPort` mock that never throws. Added two new `describe` blocks to
    `nodes.test.ts`: J2's confident-route + Jev-throws-falls-back-to-`DEFAULT_ALL` cases, J6's
    confident-FAST-path + Jev-throws-leaves-`diagnosis`-null cases.
- Verification: `pnpm typecheck`, `pnpm lint`, `pnpm test` (383 passed, 0 skipped) all clean.
  All 9 Phase 4 tasks done; all of Phase 4's "Done when" criteria checked true against real code,
  not just asserted. Phase 4 is complete.
- Not done this session: nothing left in this phase. Next: start a new chat session for Phase 5
  (Replan loop, evals, hardening) per the one-phase-per-chat rule.


### 2026-09-29 · Phase 4 task 9 attempt: recording tooling built, blocked on this session's network
- Built `packages/agents/scripts/record-cassettes.ts` (`pnpm cassette:record`): regenerates all
  3 Phase 3 demo scenarios' cassettes with real `AI_MODE=RECORD` Gemini + Jev calls against a
  fresh ephemeral PGlite DB, deleting each stale `.jsonl` first (the underlying `appendCassette`
  only appends), handling the `refund_never_initiated` manager-approval interrupt/resume, and
  asserting each run ends `RESOLVED`/`PASS`. Added `packages/agents/tsconfig.json`'s `scripts`
  directory to its `include` so the script participates in `pnpm typecheck` (clean).
- Ran it: failed immediately, `fetch failed` from the Gemini call. Confirmed by direct `curl`
  probe from the same shell that this cloud session's network egress allowlist rejects both
  `generativelanguage.googleapis.com` and `api.typesafe.ai` (`403 from proxy after CONNECT`) --
  not a bug in the script or adapters. See D045 for the full account and exactly what command to
  run locally to finish this.
- `pnpm typecheck`, `pnpm lint` clean. `pnpm test` unaffected (373 passed, 3 skipped, unchanged).
- Not done this session: the actual recording (needs a real terminal on the Mac, per the "Next
  task" instructions above) and the follow-up steps that depend on it (un-skip the 3 cassette
  tests, update the README, tick the Phase 4 checklist).


### 2026-09-29 · Phase 4 task 8: UI decision/grounding trace (closes out the phase but task 9)
- Closed a backend gap first: `agentRuns` had no `grounding` jsonb column and `AgentRunItem` had
  no `grounding` field at all, so `groundCheck`'s `GroundingReport` (task 6) never reached the
  web app except buried in individual `agent_steps` payloads. Added the column (migration
  `0004`), `syncRunRow` now persists `state.grounding`, and `apps/server/src/routes/runs.ts`
  round-trips it through `AgentRunItem.grounding: GroundingReport | null`.
- `apps/web/src/features/investigation/Investigation.tsx`: `Trace`'s `DECISION_MADE` steps now
  render the Jev tag and one line per answer via new `formatDecisionAnswer`/`formatConfidence`
  helpers (`apps/web/src/lib/format.ts`) -- Choice/Noul/Score read structurally, no new
  dependency on `@typesafe-ai/sdk` from `web`. New `FindingLine` component: a finding named by a
  `GroundingViolation` (matched by `findingId` against `run.grounding.violations`) renders
  struck through in the existing muted `--ink-2` color (never `--bad` -- that's reserved for
  live verdicts, not an already-resolved drop) with its reason shown underneath, and its
  citations as plain mono text rather than clickable evidence links.
- Tests: `Investigation.test.tsx` (new, 6 tests) covers Choice/Noul/Score answer formatting, the
  no-`DECISION_MADE`-payload no-op case, a surviving finding's normal/clickable rendering, and a
  dropped finding's strikethrough/reason/non-clickable-citation/never-`--bad` rendering.
  `apps/server/src/app.test.ts` gained a round-trip assertion that `grounding` reaches the API.
- Verification: `pnpm typecheck`, `pnpm lint`, `pnpm test` (373 passed, 3 skipped) all clean.
  Checked against `docs/05-ui-design.md` §8 (plain copy: "Dropped: <reason>") and §9 (no new
  badge/pill invented for confidence or grounding status -- both are plain mono text inline,
  matching every other status line already in the trace). See D044 for the full account.
- Not done this session: Phase 4 task 9 (cassette recordings) -- the only task left in the
  phase; needs `AI_MODE=RECORD` with real API keys this environment doesn't have. Also un-skips
  the 3 `graph.test.ts` "recorded Phase 3 scenarios" tests once cassettes are re-recorded.


### 2026-09-28 · Fixed the 4 real regressions pnpm test surfaced from tasks 3-6 (see D043)
- Renamed the `plan` state channel to `investigationPlan` in `state.ts`/`nodes.ts`/`graph.ts`
  (node keeps the doc's name `plan`) -- fixes `buildGraph()` throwing on every call, meaning the
  full-path graph (`plan` -> specialists -> `join` -> `groundCheck` -> `resolve`) could not
  construct at all since task 3.
- `riskAgent` (`nodes.ts`): `findings` is now only included in the node's update when the LLM
  fallback path actually ran (tracked with a local `llmFallbackRan` flag), not based on whether
  the resulting array ended up empty -- fixes the "no LLM call" test expecting an absent key and
  the "LLM ran but everything got dropped" test expecting `findings: []`, which were two
  different, both-correct expectations the original code couldn't satisfy at once.
- Fixed `nodes.test.ts`'s wrong `toBeUndefined()` on `budget.llmCalls` (should be `toBe(0)` --
  `RunBudget` fields are always numbers, never optional).
- Fixed two test bugs in `context.test.ts`: the budget-threshold test's manual recomputation of
  `draftText`'s output didn't render the evidence slice or filter empty sections the way the
  real function does; the scoping test's `not.toContain('ev_02')` collided with
  `SYSTEM_PROMPT`'s own hardcoded citation example (changed the example to `"ev_00"` in
  `context.ts`).
- Fixed `graph.test.ts`'s stale `toolCalls: 7` assertion (now 11 -- `triage` runs every baseline
  tool, and task 5 added 4 Risk baseline tools).
- Marked 3 `graph.test.ts` cassette-replay tests `it.skip.each(...)` with a comment pointing at
  task 9: their fixtures are stale (node renames + prompt rewrites across tasks 3-4 invalidate
  the cassette lookup key), and re-recording needs real API keys this environment doesn't have.
- Verification: `pnpm typecheck`, `pnpm lint`, `pnpm test` (365 passed, 3 skipped) all clean.
- Not done this session: Phase 4 task 8 (UI trace) itself -- next up.


### 2026-09-28 · Phase 4 task 7: `agentFindings`/`evidence` persistence
- New Drizzle tables `agentFindings`/`evidence` (`packages/core/src/db/schema/agents.ts`), one
  row per finding/evidence item, normalized out of `agentRuns.findings`/`agentRuns.evidence`
  (docs/04-data-model.md's row spec). Both keep the jsonb columns on `agentRuns` as the source
  the existing trace UI reads (D042) -- the new tables exist so task 8's grounding trace can
  query/join per finding instead of deserializing a whole run's blob. Generated PK
  (`newId('agentFinding')`/`newId('evidenceRow')`, two new `ID_PREFIX` entries in
  `packages/shared/src/ids.ts`) plus a `uniqueIndex` on the natural `(runId, findingId)` /
  `(runId, evidenceId)` pair, matching this schema's existing house style for a natural
  composite key (`cases_open_fingerprint_uq`, `disputes_one_open_per_batch_uq`).
- `grounded` (agentFindings): defaults `true`, flips to `false` only when
  `state.grounding.violations` names the finding's id -- covers both a real J4 contradiction and
  "J4 never ran for this finding" (fast path) under one rule, matching D041's "innocent until a
  violation names it" model for `state.findings` itself. Full rationale in D042.
- Migration `packages/core/drizzle/0003_aromatic_firelord.sql` (`drizzle-kit generate`, applied
  and confirmed clean against a fresh local PGlite dev DB via `pnpm db:migrate`).
- New `syncEvidenceAndFindings` (`packages/agents/src/store.ts`), an idempotent
  `insert ... onConflictDoUpdate` keyed on the same natural pairs. Called once from `run.ts`'s
  `syncRunRow`, right after `graph.invoke`/resume returns, using the exact same final
  `state.evidence`/`state.findings`/`state.grounding` that already goes onto the jsonb columns
  -- one write point, not one per node. `run.ts`'s two call sites now also pass `caseId` through
  to `syncRunRow`.
- Tests: new `packages/agents/src/store.test.ts` (4 tests, PGlite harness like `graph.test.ts`/
  `migrate.test.ts`) -- one evidence/finding row written and `grounded: true` by default;
  idempotent re-sync (simulating an interrupt/resume or extra grounding round) updates in place
  with no duplicate rows; `grounded` computed correctly for a violated finding vs. a surviving
  one; two different runs reusing the same within-run ids never collide.
- **Environment fix, not committed:** got `pnpm test`/`pnpm db:generate` actually running in this
  cloud session for the first time (previously blocked entirely -- see Blockers) by installing
  the missing linux-arm64 native binaries for esbuild and rollup into `node_modules/.pnpm`
  (the connected folder's `node_modules` was built on macOS; this session's shell is a bridged
  Linux/arm64 VM). node_modules-only, nothing in package.json or the lockfile changed.
- **Found, did not fix (out of scope for this task -- see Blockers, flagged as Next task's
  reading before starting):** with `pnpm test` finally able to run, 10 pre-existing failures
  surfaced in tasks 3/4/5/6's code (a `plan` node/state-channel name collision in `graph.ts`/
  `state.ts`, `riskAgent`'s `findings: []` vs. an expected omitted key, and two `context.test.ts`
  budget/scoping assertions). Confirmed by `git stash`-ing this session's changes and
  re-running the same failing files against the pre-task-7 commit -- identical failures, so
  none of this session's changes caused or need to fix them.
- Checks: `pnpm typecheck` and `pnpm lint` clean across all packages (this was already true
  before this session, on the same code that fails at test time -- see Blockers for why that
  gap existed). `pnpm test`: 358/368 passing, the 10 failures above pre-existing.
  `pnpm db:migrate` against a fresh local PGlite dev DB: migrations applied cleanly.
- Not done this session: UI decision/grounding trace (task 8), cassette recordings (task 9), and
  none of the 10 pre-existing failures above -- see Next task and Blockers.

### 2026-09-28 · Phase 4 task 6: `groundCheck` + J4 structural/semantic grounding
- New `packages/agents/src/grounding/predicates.ts`: one fact predicate per `FindingCode`
  (docs/03 §7), table-tested against every code in `FINDING_CODES` (`predicates.test.ts`), each
  checking only facts a real `tools.ts` `ToolDef.run` actually projects. Three codes
  (`LEDGER_CREDIT_MISSING`, `REFUND_MISSING`, `SETTLEMENT_LINE_MISSING`) get a deliberately loose
  predicate rather than an invented fact, because no tool asserts the "this is missing" claim
  positively — documented as known gaps in docs/DECISIONS.md D041, not silently tightened.
- New `packages/agents/src/grounding.ts`: the pure J4 logic, split out from the graph node the
  same way task 3 split `choosePlanSpecialists` out of `plan` — `applyStructuralGrounding`
  (§7, re-checks evidenceIds exist + runs the new predicates), `buildGroundingRequest` (batches
  one `support_<findingId>` Choice per structurally-sound finding plus one `sufficient` Noul into
  a single Jev call, §4), `applyGroundingRules` (the code rules: `contradicted` @ confidence
  ≥ 0.5 drops a finding and records a `GroundingViolation`; `sufficient < 0.5` and
  `investigationRound < MAX_INVESTIGATION_ROUNDS (2)` → `computeGaps` names the agents that lost
  all their findings; the J4 adapter-contract fallback — `semanticAnswers: null` — always reports
  `needsHumanReview: true`, `sufficient: true`, `gaps: []`, so a Jev outage can never trigger an
  extra round by itself), and `survivingFindings` (the filter `resolve` applies before ever
  building a context or letting the LLM cite a finding).
- `nodes.ts`: new `groundCheck` node between `join` and `resolve` runs both passes and calls Jev
  under tag `J4_GROUND`, with its own try/catch for the adapter-contract fallback.
  **Design choice, since `state.findings` is append-only (state.ts, §6, unchanged by this task):
  a dropped finding is never physically removed from `state.findings` — it can't be, without
  breaking the parallel `Send` fan-out's merge-by-id reducer. `resolve` now builds
  `groundedFindings = survivingFindings(state.findings, state.grounding?.violations)` and passes
  that (not `state.findings`) into `buildResolveContext`, so a dropped finding's statement never
  reaches the diagnosis LLM's context even though the array it lives in never shrinks.** This is
  what "grounding, filtered findings, gaps" in the doc's node-reference table means in this
  codebase — recorded in D041 since it is a real interpretation call, not implied by the doc.
  `plan` gained a second branch: when `state.gaps` is non-empty (a `groundCheck`-requested
  targeted re-round), it skips J2 entirely and routes straight to the specialists named in
  `gaps` (`routedBy: 'GAP_TARGETED'`, a new `InvestigationPlan.routedBy` variant in
  `packages/shared/src/agents.ts`) — cheaper and more deterministic than asking Jev again, since
  the gap already says which agents are missing evidence (D041).
- `graph.ts`: `join` now feeds `groundCheck`, and a new conditional edge routes `gaps.length > 0`
  back to `plan`, otherwise to `resolve` — the round cap lives entirely inside
  `applyGroundingRules`, so the edge condition is just "were gaps produced". The fast path
  (`diagnose` → `resolve` directly, skipping `plan`/specialists/`join`/`groundCheck` completely)
  is untouched; `graph.test.ts`'s four existing scenarios all exercise only that path and were
  re-verified unaffected.
- `packages/shared/src/agents.ts`: `GroundingReport` gained an optional `needsHumanReview`
  field (optional so the one pre-existing literal in `context.test.ts` that predates this task
  keeps typechecking); `InvestigationPlan.routedBy` gained `'GAP_TARGETED'`.
- Tests: `packages/agents/src/grounding/predicates.test.ts` (every `FindingCode`, matching +
  non-matching evidence), `packages/agents/src/grounding.test.ts` (structural pass, the
  contradicted-drop rule, the sufficiency/gaps/round-cap decision including the round-cap-never-
  loops-back case, the J4 fallback, `computeGaps`, `survivingFindings`, and — the explicit Phase
  4 "Done when" proof — a deliberately corrupted finding shown absent from the exact
  `buildResolveContext` call `resolve` makes), and new cases in `packages/agents/src/nodes.test.ts`
  (`groundCheck` node-level: structural drop before Jev is even asked about that finding,
  semantic contradicted-drop, gaps on insufficiency, no gaps once the round cap is spent, the J4
  fallback; `plan`'s gap-targeted branch never calling `decision.ask`). All existing task 3/4/5
  tests (`planning.test.ts`, `context.test.ts`, `risk.test.ts`, the earlier `nodes.test.ts`/
  `graph.test.ts` cases) were re-read, not just assumed, and none needed a signature change.
- Checks: `pnpm typecheck` and `pnpm lint` clean across all packages. `pnpm test` still cannot run
  in this session — same documented bridge issue (`Cannot find module
  '@rollup/rollup-linux-arm64-gnu'`), re-confirmed by running it again and reading the exact error
  text rather than assuming. Ask Shivam to run `pnpm test` locally (including all the new test
  files above) before trusting this session's grounding logic fully.
- Not done this session: evidence/finding persistence (task 7), UI trace (task 8), cassette
  recordings (task 9) — see Next task.

### 2026-09-28 · Phase 4 task 5: Risk specialist, code bucketing, J3 Score composite, weighted tier
- `riskAgent` (nodes.ts) is now a real, bespoke node instead of a stub built from
  `buildSpecialistNode`: it slices its own baseline evidence, runs two pure code steps
  (`extractRiskSignals` then `bucketRiskSignals`, new `packages/agents/src/risk.ts`) to turn raw
  counts into the doc's descriptive buckets (docs/03 §4 "J3", e.g. `failed_attempts_24h_bucket:
  "6-10"`), then one batched Jev `score()` call (tag `J3_RISK`, already reserved in
  `DecisionTag`) for `velocity_abuse`/`identity_mismatch`/`chargeback_pattern`/
  `merchant_exposure`. `combineRiskScores` (new `packages/agents/src/risk.weights.ts`) does the
  weighted composite (`risk = Σ wᵢ·scoreᵢ`, weights summing to 1) → `LOW|MEDIUM|HIGH|CRITICAL`,
  then raises the tier by one level (clamped at `CRITICAL`) when Jev's mean confidence across the
  four Scores is under 0.5 — `state.risk` (`RiskAssessment`) is genuinely populated now, no
  longer always `null`.
- Gemini enters only as a fallback, matching the node-reference table's "(+LLM only if
  confidence < 0.5)": on a low-confidence Jev read, one findings-only LLM call (same
  `buildSpecialistContext`/`FindingsSchema` shape the other two specialists' second call uses)
  writes up findings citing Risk's own evidence, with the same structural-grounding drop rule
  (a finding that cites no valid risk evidence id is dropped). On Jev error/timeout, the J3
  fallback the doc's adapter-contract table already names ("J3 → rules-only tier") runs instead —
  `rulesOnlyRiskTier` (risk.ts), a fixed conservative per-signal rule set with no Jev call and no
  LLM call, reporting `meanConfidence: 0` so a fallback assessment is distinguishable from a real
  low-confidence one. `riskAgent` never leaves `state.risk` unset once it has evidence to reason
  over, and never crashes the graph on a Jev outage.
- Real risk tools (`tools.ts`): `getCustomerHistory`, `getDeviceSignals`, `getFailedAttempts`,
  `getChargebackHistory`, all baseline (no follow-up subset — Risk never runs an LLM tool-choice
  pass, so there is nothing to bound with a narrower group). `RISK_TOOLS`/`RISK_FOLLOWUP_TOOLS`
  are no longer empty placeholders.
- `packages/core` additions to support the real tools: `OrderSnapshot` gained `devices` (the
  `devices` table, by customer, all-time) and `merchantDisputes` (settlement disputes joined
  through `settlements.merchantId`, the merchant-exposure proxy — see below), both loaded by
  `snapshot.loader.ts` with two more batched, constant-count queries; `db/rows.ts` gained
  `DeviceRow`; `test-factory.ts`'s `healthySnapshot()` defaults both to `[]`.
- **Known-gap decision, not a silent fix**: this schema has no per-customer chargeback record
  (`disputes` is settlement-only, keyed by merchant/batch). `chargeback_pattern` is scored from
  `customers.riskFlags` instead (always empty in today's seed data); `merchant_exposure` uses the
  new merchant-level settlement-dispute count. Full reasoning in docs/DECISIONS.md D040.
- Checked the policy engine (`core/src/policy/*`, docs/03 §11 P1/P2): it already consults a risk
  tier for BLOCKED/MANAGER, but that's the separate, pre-existing `riskTierFromRules` (rules-only,
  always on, computed from order/attempt data for every proposal), not the agent's new J3
  `state.risk`. Left as-is per the task's own instruction not to invent new policy behavior — the
  gap is recorded above and in D040, not wired.
- Tests: new `packages/agents/src/risk.test.ts` (bucketing at each boundary, the weighted
  composite + tier thresholds + confidence-raise-by-one + CRITICAL clamp, the rules-only
  fallback) and new `packages/agents/src/nodes.test.ts` (`riskAgent` in isolation: confident Jev
  read with no LLM call, low-confidence Jev read triggering exactly one LLM findings call,
  structural grounding dropping an unsupported LLM finding, Jev throwing into the rules-only
  fallback without crashing, and the no-evidence skip path never calling Jev at all) — both pure
  logic, no database or graph needed, since all risk tools are baseline.
- Checks: `pnpm typecheck` and `pnpm lint` clean across all packages after these changes.
  `pnpm test` still cannot run in this session — same documented bridge issue (`Cannot find
  module '@rollup/rollup-linux-arm64-gnu'`), confirmed by re-reading the error text again before
  assuming it was the known one. Ask Shivam to run `pnpm test` locally on the Mac (including the
  two new test files) before trusting the new risk logic fully.
- Not done this session: groundCheck + J4 (task 6), evidence/finding persistence (task 7), UI
  trace (task 8), cassette recordings (task 9) — see Next task.


### 2026-09-28 · Phase 4 task 4: ContextBuilders (budgets, projection, PII masking, token logging)
- New `packages/agents/src/context.ts` (docs/03 §8) is now the single place every model call's
  `LlmMessage[]` is assembled. It replaces `prompts.ts` entirely (deleted, along with
  `prompts.test.ts`, whose cassette-stability assertions moved into `context.test.ts`), building
  the doc's six ordered sections — `[1]` stable prefix (role + rules + output schema + tool
  catalog, identical across runs), `[2]` case brief, `[3]` this call's own evidence slice, `[4]`
  peer finding summaries (resolve only), `[5]` prior-attempt history (resolve only), `[6]` the
  task instruction — via two entry points: `buildSpecialistContext` (payment/reconciliation/risk
  follow-up and findings calls) and `buildResolveContext` (the diagnosis call).
- `sliceEvidenceForAgent` (formerly `nodes.ts`'s local `evidenceForTools`, D038) now lives inside
  `context.ts` and does the "never contains" scoping itself from the *full* evidence pool, rather
  than trusting the caller to pre-filter — so a specialist's built context can be asserted
  directly (by test) to never contain another agent's evidence, instead of relying on `nodes.ts`
  getting the filter right before it calls in.
- `applyBudget` (pure, unit-tested independent of the graph) implements the doc's drop order:
  `[5]` history → `[4]` peers → oldest evidence in `[3]` one item at a time (sorted by
  `observedAt` ascending; items with no timestamp, i.e. resolve's structural summary, sort last).
  `prefix`/`brief`/`task` never drop. New `CONTEXT_BUDGET` (`packages/shared/src/agents.ts`,
  alongside `AGENT_BUDGET_LIMITS`) gives payment/reconciliation 1800, risk 1200, resolve 2200 —
  chars/4 token-estimate units (see D039 for why chars/4).
- Numbers pre-digested (docs/03 §8): payment's slice now includes a code-computed
  `gatewayVsOrderAmount: EQUAL|MISMATCH|UNKNOWN` line (comparing `getGatewayPayment`/`getOrder`
  facts, formatted through `shared/money.ts`) so the model never infers the comparison itself
  from two raw numbers. Reconciliation needed nothing extra — `getFeeBreakdown` (tools.ts) was
  already emitting a code-computed `matched`/`diffMinor` pair.
- PII masking (`maskEmail`, `maskPhone`, `maskCard`, `maskPiiInFacts`) is written and unit-tested
  as pure functions, wired into `promptFacts` ahead of its existing id/date scrubbing. No current
  `ToolDef.run` in `tools.ts` projects an email, phone or card number into an `EvidenceItem` —
  this product's evidence is all statuses, amounts and internal ids — so this is a forward-looking
  safety net with nothing to catch yet, not simulated PII. Noted in DECISIONS.md D039 rather than
  inventing a fake field to mask.
- Token estimate + content hash are logged on every specialist/resolve LLM call: `nodes.ts`'s
  `LLM_CALLED` events for the follow-up call, the findings call (which previously had no
  `LLM_CALLED` event of its own — added one for consistency) and `resolve`'s diagnosis call now
  carry `contextTokenEstimate`/`contextHash` alongside the existing `usage`. No `agent_steps`
  schema change was needed — `payload` is already `jsonb` (`packages/core/src/db/schema/
  agents.ts`), so these ride along in the same event write Phase 3 already made; the UI to show
  them is Phase 4 task 8, not this task.
- Tests: `packages/agents/src/context.test.ts` (new, replacing `prompts.test.ts`) covers the
  budget drop order at each stage (keeps everything when it fits; drops history only; drops
  history then peers; drops the oldest evidence item first, by `observedAt`; empties the slice
  entirely under an impossible budget), per-agent evidence scoping (payment's built context
  never contains reconciliation/ledger evidence and vice versa, and a follow-up call's tool
  catalog never leaks another agent's tools), the payment amount comparison, resolve's peer
  summaries (grouped by `finding.agent`, never repeating raw evidence facts), PII masking, and
  token-estimate sanity bounds. The old `prompts.test.ts` cassette-stability assertions (same
  facts with regenerated ids/dates replay identically; different amounts never do) were ported
  onto `buildSpecialistContext` and extended to also assert on `.contentHash`.
- Checks: `pnpm typecheck` and `pnpm lint` clean across all packages. `pnpm test` still cannot run
  in this cloud session — same documented bridge issue (`Cannot find module
  '@rollup/rollup-linux-arm64-gnu'`), confirmed by re-reading the error text before assuming it
  was the known one rather than a real failure from this session's changes. Ask Shivam to run
  `pnpm test` (including the new `context.test.ts`) locally on the Mac before trusting it fully.
- Not done this session: Risk specialist + J3 (task 5), groundCheck + J4 (task 6),
  evidence/finding persistence (task 7), UI trace (task 8), cassettes (task 9) — see Next task.


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
