# Progress

Update at the end of every session. Newest session log entry on top.

## Current phase

**Phase 5 · in progress.** Phase 4 is complete (see below). Phase 5 task 1 (replan node, J5,
attempt tabs) is done: `execute`/`validate`/`closeResolved`/`replan` graph nodes, J5 decision +
its two code caps, `AttemptSummary`/history now actually feeds `resolve`'s proposal (see D047),
and the Investigation screen splits its trace into per-attempt tabs once a run has replanned.
`pnpm typecheck`, `pnpm lint`, `pnpm test` (395 passed, 0 skipped) all clean. Tasks 2-6 of
docs/06-phases.md's Phase 5 (evals package, injection eval, budget guard, failure drills) are not
started.

## Phase checklist

- [x] Phase 0 · Foundations
- [x] Phase 1 · Product core without AI
- [x] Phase 2 · Resolution spine
- [x] Phase 3 · First agent (resume-ready milestone)
- [x] Phase 4 · Multi-agent, context, evidence, Jev
- [ ] Phase 5 · Replan, evals, hardening (task 1 of 6 done)
- [ ] Phase 6 · Polish, public demo, deploy

## Next task

**Phase 5 task 1 is done (replan/J5/attempt-tabs, see D047 and the session log below). Start a
new chat session for Phase 5 task 2** ("`replay_fails_then_replan` passes on attempt 2" --
already proven true by `graph.test.ts`'s new test, but docs/06-phases.md lists it as its own
task; worth re-checking whether there's anything left there beyond what task 1 already covers) or
task 3 (`packages/evals`: golden expectations, runner, markdown report). Read
`docs/06-phases.md`'s Phase 5 section and `docs/DECISIONS.md`'s D047 first. Per CLAUDE.md's
one-phase-per-chat rule this is still within Phase 5, but each task is its own reasonable
session-sized chunk (same granularity Phase 4's tasks 3-9 each got their own session) --
consider starting a fresh chat per task rather than doing the rest of Phase 5 in one sitting,
same as every prior phase.

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

- Detection never closes a case by itself; cases close through a verified resolution.
- Login rate limiting is in memory (single server process).
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

## Later (parked ideas, do not build yet)

- Separate Refund specialist agent
- Cross-case pattern memory (LangGraph Store), e.g. merchant webhook failure streaks
- Dark theme with its own tokens
- Razorpay test adapter (Phase 6 stretch)
- Validator outcomes block on Overview (needs Phase 2 data)

## Session log

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
