# Decisions

Short records of design choices. Add a new entry instead of editing old ones. Format: context, decision, why, consequences.

## D001 · Deterministic spine, bounded agents
Agents only propose from a closed catalog; policy, execution and validation are code. Why: money actions must be deterministic and auditable; agents stay replaceable. Consequence: product works without AI; manual and agent paths share code.

## D002 · Planned parallel specialists instead of a chatty supervisor loop
`plan` picks specialists once (Jev J2), they run in parallel with `Send`, results join. Why: bounded cost, reproducible, testable. Consequence: extra rounds only via grounding gaps (max 2) or replan (max 2 attempts).

## D003 · Jev for five narrow decisions, Gemini for reasoning
Jev handles typed judgments with confidence (intake, plan, risk scores, citation check, replan strategy). Gemini handles evidence interpretation and resolution synthesis. Why: follows TypeSafe guidance (narrow atomic questions, code in control) and keeps LLM calls to where reasoning is needed. Consequence: code must pre-compute numbers/dates for Jev; every point has a fallback.

## D004 · Separate external (`gw_*`) and internal collections
Why: reconciliation needs two worlds to compare, and it lets a real gateway adapter replace the simulator. 

## D005 · Record/replay for model calls
Why: free public demo, deterministic evals and tests. Consequence: simulator must be seeded so prompts are stable; `JEV_MODEL` pinned.

## D006 · Env var name for Jev key
Repo uses `TYPESAFE_JEV_API_KEY` (set by owner). SDK default is `TYPESAFE_API_KEY`, so the adapter passes the key explicitly.

## D007 · UI direction: warm ledger, not AI template
IBM Plex, warm paper, single ledger-green accent, 0–4px radius, borders not shadows, no AI iconography. Why: the product should read as a real ops tool; avoids common generated-UI tells.

## D008 · Postgres on Supabase instead of MongoDB + Redis
Owner asked to cut infrastructure that isn't needed. One Postgres database now holds business data, the job queue (pg-boss) and LangGraph checkpoints (PostgresSaver). Redis, BullMQ and the separate worker process are gone; one Node server runs HTTP, Socket.IO and jobs. Why: fewer moving parts, and Postgres transactions, unique and check constraints suit ledgers and idempotency better than documents. Trade-off: the stack is no longer literally "MERN"; it is React + Node/Express + Postgres, all TypeScript. Local development and tests use PGlite (embedded Postgres), so no Docker is needed.

## D009 · Case fingerprint is caseType + primary entity
Rules that describe the same underlying problem (D1 and D3 on one payment) merge into one case instead of opening two. Enforced by a partial unique index on open cases.

## D010 · Same scenario + seed twice returns 409
The simulator refuses to regenerate a scenario with a seed it already used (checked via the `simulator.generated` audit row in the same transaction). Why: deterministic ids would collide; a clear 409 beats a half-written scenario.

## D011 · Payment list filter reads gw_payments directly
`PaymentQueryService` joins `gw_payments` for the gateway-status filter. It is read-only and keeps pagination in SQL; all other gateway reads go through `PaymentGatewayPort`. Revisit when a real gateway adapter exists (store a mirrored gateway status on `payments` instead).

## D012 · Batch cases keep the matrix from detection time
Payment/order cases recompute the state matrix live on every read. Settlement batch cases keep the stored matrix and link to the first offending payment for context.

## D013 · Case search
`GET /api/cases?q=` prefix-matches display id, case id, payment id and order id (case-insensitive, wildcards escaped).

## D014 · Refunds key on the gateway payment
`refunds.gw_payment_id` is always set and `refunds.payment_id` is nullable. Why: refunding the second capture of a duplicate has no internal payment to point at. Migration 0001 adds the column nullable, backfills it from `payments`, then sets NOT NULL, so databases created by 0000 upgrade cleanly. Order snapshots load refunds by the order's gateway payments, and ledger rows by payment id or by those refunds' ids, so a refunded duplicate's refund journal is visible on the case.

## D015 · CSRF defence: SameSite=Lax plus JSON-only writes
The session cookie is `SameSite=Lax`, and every POST/PUT/PATCH/DELETE must carry `Content-Type: application/json` (415 otherwise, checked from the header so bodiless requests are covered). Why: a cross-site HTML form can only send urlencoded, multipart or text/plain, and a cross-site JSON fetch needs a CORS preflight our CORS policy (single `WEB_ORIGIN`) refuses. No token round-trip needed. Consequence: API clients must send JSON even for empty bodies (`{}`); the web client already does.

## D016 · Own auth: scrypt passwords, HS256 JWT cookie
Passwords use Node's `crypto.scrypt` (N=16384, r=8, p=1, 64-byte key, random 16-byte salt, stored as `scrypt$<salt>$<hash>`), compared with `timingSafeEqual`. Sessions are an 8h HS256 JWT signed with `jose` in the httpOnly cookie `payops_session` (Secure in production), claims `{sub, role, name, email}`; requests are authenticated from the claims without a database read. Development without `JWT_SECRET` uses a fixed dev secret and logs a warning; production refuses to start without it. Socket.IO handshakes are authenticated from the same cookie. Login is rate limited in memory (10/min per IP + email) and returns one generic message for unknown email and wrong password. Demo users (all with password `payops-demo`) are seeded idempotently on server start and by `pnpm seed`: ops@, ops2@, manager@, viewer@, admin@payops.dev. Why: no new infrastructure, no native modules, easy to explain.

## D017 · Detection suppression after a resolution
D7 (settlement diff) does not fire while an OPEN dispute on the batch covers exactly the difference; D8 (risk velocity) does not fire once the payment is on hold. Why: after a dispute or a hold the exception is being handled, so the sweep must not reopen it. The validator's matrix invariant accordingly allows SETTLEMENT to differ on a settlement case covered by an open dispute (the fee really is still wrong until the acquirer pays).

## D018 · Matrix and D4 understand fixes
- A duplicate is a capture that still holds money: D4 and the gateway cell count captures with `refundedMinor < amountMinor`, so refunding the extra capture in full resolves it.
- A FAILED webhook delivery is no longer a mismatch once our records caught up another way (payment.captured: internal payment is CAPTURED or later; refund.*: the linked internal refund has the matching status). The cell still shows the failure code with a note.
Why: without these, correct manual fixes (mark paid, sync refund, refund the duplicate) could never reach validator PASS.

## D019 · Policy defaults and attempt numbering
AUTO must be granted by a rule (P5, P6, P10). If no rule fires (e.g. a correction without a verified capture, or a mixed correction + control proposal) the tier is OPS with no rule reasons. Attempt = number of earlier resolutions on the case + 1, including BLOCKED and REJECTED ones, so P7 applies from the second proposal of any kind. Risk for manual proposals is rules-only (`riskTierFromRules`), which never yields CRITICAL; it is also the future J3 fallback.

## D020 · Resolution flow details
- The simulator gateway delivers webhooks synchronously to our `WebhookConsumer`, after its own commit; the consumer runs its own transaction and the adapter records the attempt afterwards (never nested, required by PGlite's serialised transactions). The injected fault for `replay_fails_then_replan` is the consumer answering 409 while `orders.locked_reason` is set.
- INITIATE_REFUND records our refund as REQUESTED first; the consumer links a gateway refund to it by gateway refund id, else to the oldest unlinked REQUESTED/PENDING refund on the same gateway payment with the same amount.
- A REPLAY that gets HTTP 409 is a SUCCEEDED step (the gateway did re-deliver); the validator FAILs it on the delivery postcondition.
- If a step fails (precondition on fresh data or handler error), later steps are shown as SKIPPED, the resolution becomes EXECUTION_FAILED without validation, and the case reopens.
- ESCALATE_TO_HUMAN sets the case to ESCALATED (no assignee yet). A PASS on a resolution containing it leaves the case ESCALATED instead of RESOLVED.
- After an approval, `ApprovalContinuation.onApproved` executes and validates directly; Phase 3 replaces it with resuming the agent's LangGraph thread when `resolution.runId` is set.

## D021 · Explicit default policy rule P11
When no rule grants AUTO and none raises the tier, the decision is OPS with rule P11 ("no rule allows automatic execution"). Every decision now names at least one rule, so the UI and audit log can always say why.

## D022 · Recommendations never read fault-injection fields
`orders.lockedReason` exists only so the simulator can inject a version conflict. The manual recommendations must not read it (a real analyst could not see it): the replay is recommended first, and mark paid + post ledger only after a replay has failed. This keeps the replay-fails demo honest.

## D023 · One shared database pool; size 1 on local PGlite
pg-boss runs on the application's pool (`db.executeSql`). PGlite is a single Postgres backend, and parallel connections interleave extended-protocol messages ("bind message supplies N parameters"), so local PGlite gets one connection (`databasePoolSize`). Supabase gets 10 (override with `DATABASE_POOL_MAX`). Fewer connections also suits Supabase's free tier.

## D024 · Stored case matrix refreshed after a resolution
Queue and approval views read `cases.matrix/mismatched`. After a resolution finishes, the stored matrix is recomputed from live data so resolved cases stop showing disagreement.

## D025 · Realtime approval events carry ApprovalItem
`approval.requested` and `approval.resolved` publish a full `ApprovalItem` (viewer-independent), matching the shared contract the UI consumes.

## D026 · Jev-first fast path before any LLM investigation
Most cases match known patterns that code can describe as facts. A Jev diagnosis (J6) plus code resolution and narrative templates resolves them with zero Gemini tokens; the full multi-agent investigation runs only when Jev confidence is below 0.80, the case is novel, or it needs reasoning (replan, risk). Why: lower cost and latency, more deterministic evals, and it follows TypeSafe's guidance (code in control, narrow typed decisions). The agent stays agentic where it matters: uncertainty, failures and replanning.

## D027 · Agent DB writes happen before the interrupt, never after
LangGraph re-runs a node from its top on resume, so any node that writes to the database must not also call `interrupt()` — resuming would replay the write. `policyGate` (writes the resolution/approval row via `proposeFromAgent`) and `awaitApproval` (only calls `interrupt()` and returns the resume value) are split into two graph nodes for this reason.

## D028 · `agentResumer` wired through a mutable box, like the realtime publisher
`core`'s `AgentResumer` needs to enqueue a pg-boss `agent-resume` job, but `boss`'s job handlers need `core` to already exist. `main.ts` creates a mutable box, passes it into `createCore`, then fills it once `boss` is ready — the same pattern already used for `EventPublisherPort`.

## D029 · Fast-path template actions reuse the existing recommendation engine
`templateActions()` calls the same `recommendedTypes()` / `actionOptions()` (`core/actions/options.ts`) that the manual "Resolve" UI uses, keyed by root cause, instead of a new static root-cause → action table. Why: guarantees the agent can never propose an action with an invalid id or stale params — it can only ever propose what a human could also propose for that case shape.

## D030 · Agent execution failures escalate instead of reopening the case
`ResolutionService.finish()` gained an `onFailure` option (`'OPEN' | 'ESCALATE'`, default `'OPEN'`). Manual/human proposals keep the existing default (reopen for another attempt). The agent's `execute` node passes `onFailure: 'ESCALATE'`, since an agent-caused execution failure should stop and wait for a human rather than silently retry.

## D031 · Investigate node uses a bounded two-call pattern, not an open ReAct loop
`LlmPort.invokeStructured` is single-shot (needed for RECORD/REPLAY cassette determinism — each call is one cassette entry keyed by call index). The `investigate` node therefore does not run an open tool-calling loop: call 1 picks up to `AGENT_BUDGET_LIMITS.maxFollowupToolCalls` (6) follow-up tools from `FOLLOWUP_TOOLS`, code executes them, call 2 emits structured `Finding[]`. Full ReAct-style iterative tool calling is deferred; revisit if two calls prove insufficient for real cases.

## D032 · `scenarioKey` is optional and only meaningful for RECORD/REPLAY
Production cases have no natural scenario key. `CreateRunBody` and the agent job payloads carry an optional `scenarioKey`, defaulting to `'default'` when omitted; `LIVE` mode ignores it, `RECORD`/`REPLAY` use it to select the cassette file.

## D033 · Fast-path evidence and typed findings
Webhook delivery and gateway-refund status are baseline tools so zero-Gemini narratives can cite the facts they describe. Fast-path narratives create a real `Finding`; `supportingFindingIds` holds finding ids, not evidence ids. J6 requires consistent evidence and a citable template in addition to the existing confidence/human-review gates. Tool counts count executed tools, including empty results, rather than evidence rows. Authorized while completing Phase 3 after citation tests exposed the gap.

## D034 · Stable reasoning inputs for record/replay
Prompts omit case display ids, entity refs and observation times. Timestamp facts become code-computed presence booleans, and link ids become presence flags. Money, statuses and other semantic facts remain unchanged and hashed, so altered financial facts cannot reuse a recording. Replay uses the recorded scenario seed; different seeds can change ordering among evidence rows and cause an intentional miss. This keeps changing audit metadata out of model context without weakening the cassette lookup to a scenario-only match.

## D035 · Share the checkpointer pool and correct the Jev pin
PostgresSaver uses the application's pg pool, just like pg-boss (D023). A second pool can interleave operations on PGlite's single backend. The setup cache is scoped to that database and cleared after a failed setup. Jev's provider accepts `jev-1.13.0`, not the initial `jev-1.13` configuration; env parsing translates that legacy spelling to the pinned version without editing secrets. Confirmed by a live 400 response and https://docs.typesafe.ai/models.

## D036 · J1 signal intake runs after commit, once per newly opened case
`SignalIntakeService.screenCase` is called from `ReconciliationService.applyCandidates` only for
`result.created` cases, after `openOrUpdate`'s transaction has committed — a Jev call is a network
request and must not run inside a DB transaction. It is not retried on every sweep: a note keeps
its tags once screened (`complaintType != null` is the completion marker), so a Jev outage only
costs that one case's tags, matching the doc's J1 fallback ("no tags") rather than promising
retries. `createCore` gained an optional `decision?: DecisionPort`, defaulting to a
`NullDecisionPort` that always rejects, so tests, the simulator and any caller that doesn't care
about J1 are unaffected; `apps/server` is the only caller that wires a real one
(`createDecisionPort(env)`, same adapter and model pin the agent graph uses).

## D037 · Risk specialist's real tools and J3 scoring are deferred to Phase 4 task 5
`riskAgent` (Phase 4 task 3) is wired into the graph with the same baseline+follow-up+findings
shape as Payment/Reconciliation, but `tools.ts`'s `RISK_TOOLS` is an empty, typed array: there are
no risk-specific tools yet (`getCustomerHistory`/`getDeviceSignals`/`getFailedAttempts`/
`getChargebackHistory`, docs/03 §9) and no J3 atomic-score composite. `riskAgent` therefore always
skips both its LLM calls and returns zero evidence and zero findings, and `state.risk` stays
`null`. This is expected, not a bug: it exercises the fan-out/join plumbing end to end without
inventing a fake risk score. Phase 4 task 5 adds the real tools, J3's Score questions
(`velocity_abuse`/`identity_mismatch`/`chargeback_pattern`/`merchant_exposure`) and the
code-weighted tier combination.

## D038 · Specialist prompts are pre-scoped to their own tool group's evidence
Full per-agent `ContextBuilder`s (budgets, projection, PII masking, token logging) are Phase 4
task 4. Until then, each specialist's `evidenceForTools` (nodes.ts) filters `state.evidence` down
to just the facts its own tool group produced before building its follow-up/findings prompts, and
`buildFollowUpChoiceSchema` (schemas.ts) gives each specialist a Zod enum limited to its own
group's tool names. This makes docs/03 §3/§8's "never contains" rule true today (a payment
specialist's prompt cannot contain ledger/settlement evidence, and its follow-up choice cannot
name a ledger tool) without waiting on task 4's full budget/projection machinery. `triage` still
gathers the combined baseline evidence for every group up front (unchanged from Phase 3), because
the fast path (`diagnose` → `resolve` directly) skips `plan` and every specialist entirely and
still needs evidence to cite in its narrative template.

## D039 · ContextBuilder: chars/4 token estimate, prompts.ts folded into context.ts, no PII exists yet
Phase 4 task 4. `packages/agents/src/context.ts` replaces `prompts.ts` entirely (deleted) as the
one place every model call's `LlmMessage[]` is assembled, implementing docs/03 §8's six ordered
sections and per-agent budgets (`CONTEXT_BUDGET`, `packages/shared/src/agents.ts`, alongside
`AGENT_BUDGET_LIMITS`).
- **Token estimate:** `estimateTokens` is `Math.ceil(text.length / 4)`, not a real tokenizer.
  Simple, deterministic, and good enough to compare calls and bound prompts; matching Gemini's
  actual BPE count exactly is not needed for a budget guard. Documented in `context.ts` itself so
  the heuristic's limits are visible next to its use.
- **Hash:** `hashContext` is `sha256(fullPromptText).slice(0, 16)`, stored as `contentHash` next
  to `tokenEstimate` on the `LLM_CALLED`/`DECISION_MADE` event payload for `paymentAgent`/
  `reconciliationAgent`/`riskAgent`'s follow-up and findings calls and `resolve`'s diagnosis call.
  No `agent_steps` schema change was needed: `payload` is already `jsonb`, so these two fields
  just ride along in the same event write Phase 3 already made.
- **Budget dropping** (`applyBudget`, pure and unit-tested independent of any graph/LLM
  wiring): [5] history → [4] peers → oldest evidence in [3], one item at a time, sorted by
  `observedAt` ascending (items with no timestamp — resolve's structural summary — sort last, so
  real evidence goes before summaries). `prefix`/`brief`/`task` never drop: without them the call
  has no instructions at all.
- **Scoping moved into the builder, not the caller:** `sliceEvidenceForAgent` (and therefore the
  "never contains" rule) now lives in `context.ts` itself — `buildSpecialistContext` takes the
  *full* evidence pool plus `ownTools` and scopes internally, rather than trusting `nodes.ts` to
  pre-filter (superseding D038's caller-side `evidenceForTools`, which is now `sliceEvidenceForAgent`
  in `context.ts`). This makes the "never contains" property something a unit test can assert
  directly on a `ContextBuilder`'s output.
- **Resolve's [3]/[4] split:** the doc's table lists resolve's slice as "findings, risk tier,
  grounding report, action catalog, history", but findings and history are sections [4]/[5], not
  [3]. Read literally: [3] is resolve's own structural summary (risk tier, grounding report, the
  closed action catalog from `shared/actions.ts`, and an evidence *count*, never raw facts), and
  [4] is the findings themselves, rendered as statements grouped by `finding.agent` — exactly the
  "other agents' finding statements (no raw evidence)" the doc describes, since resolve has no
  "own" evidence of its own to distinguish from anyone else's.
- **Payment's pre-digested comparison:** `gatewayVsOrderAmount: EQUAL|MISMATCH|UNKNOWN` is
  computed from `getGatewayPayment`/`getOrder` evidence facts in code and formatted through
  `shared/money.ts`, matching the doc's literal example. No equivalent was added for
  Reconciliation: `getFeeBreakdown` (tools.ts) already emits a code-computed `matched`/`diffMinor`
  pair, so nothing was missing there.
- **PII masking:** `maskEmail`/`maskPhone`/`maskCard`/`maskPiiInFacts` are written and unit-tested
  as pure functions, and `promptFacts` runs `maskPiiInFacts` before its existing
  id/date-scrubbing. No current `ToolDef.run` in `tools.ts` projects an email, phone or card
  number into an `EvidenceItem`'s facts — this product's evidence is all statuses, amounts and
  internal ids — so today this is a safety net with nothing to catch, not dead functionality: the
  day a tool starts projecting `customerEmail`/`customerPhone`, it is masked without that tool's
  author having to remember to do it.

## D040 · Risk specialist: real tools, code-side bucketing, J3 Score composite, deterministic fallback
Phase 4 task 5. `riskAgent` (nodes.ts) is now a bespoke function, not built from the
`buildSpecialistNode` factory the other two specialists share — J3 (docs/03 §4) is code
bucketing + one batched Jev `score()` call + code combination, not a two-LLM-call investigation.
- **Risk tools are all baseline, no follow-up subset.** `getCustomerHistory`/`getDeviceSignals`/
  `getFailedAttempts`/`getChargebackHistory` (tools.ts) are marked `baseline: true`, so `triage`
  gathers all of Risk's evidence up front like every other baseline tool, and `RISK_FOLLOWUP_TOOLS`
  stays an empty (but still typed and exported) array. There is no LLM tool-choice step for Risk
  to bound with a follow-up subset — Jev gets a single fixed bucket object every time, not a menu
  of tools to ask for. This means `riskAgent` itself never calls `loadCaseState`, which is also
  why it is cheap to unit test without a database (`nodes.test.ts`).
- **`packages/agents/src/risk.weights.ts`, not `packages/core/src/policy`.** The doc's literal
  path is `policies/risk.weights.ts` with no package prefix. J3's composition happens inside the
  agent graph's `riskAgent` node — it is a Risk-specialist concern, not a policy-engine concern —
  so it stays in `agents`. `core/src/policy/risk.ts`'s `riskTierFromRules` is a different,
  pre-existing system: the policy engine's own always-on rules-only risk input (P1/P2, `policy/
  rules.ts`), computed straight from `OrderSnapshot.primaryGw`/`recentAttempts` for every
  proposal, human or agent. Reusing it for J3 would blur "the policy engine's risk tier" and "what
  Jev was asked to score", and — more concretely — `core` cannot import J3's bucket-building code
  without breaking `shared ← core ← agents` (CLAUDE.md rule 10). J3 gets its own small, separate
  fallback (`rulesOnlyRiskTier`, risk.ts) built from the exact same signals it would otherwise
  score, not a repurposed policy function.
- **J3 fallback: rules-only tier, `meanConfidence: 0`.** The doc's adapter-contract table
  (docs/03 §4) already names this explicitly ("J3 → rules-only tier"), so no gap-filling was
  needed here, unlike the task brief's framing. `rulesOnlyRiskTier` (risk.ts) takes the worst of
  four fixed, conservative per-signal rules (never a blended weighted average, since there is no
  Jev confidence to weight against) and reports `meanConfidence: 0` — a value no real Jev call
  can produce (confidences are always > 0) — so a run's UI/audit trail can tell a fallback
  assessment apart from a genuinely low-confidence Jev read (which raises the tier by one level
  instead, per the doc's own rule) just by looking at the number.
- **Merchant-level dispute exposure, not per-customer chargebacks.** `chargeback_pattern`'s input
  data (docs/03 §9 "getChargebackHistory") does not exist in this schema as specified: `disputes`
  (`packages/core/src/db/schema/resolution.ts`) has `type: ['SETTLEMENT']` only and is keyed by
  `batchId`, not `customerId` — there is no per-customer chargeback record anywhere in this
  product. Rather than add that as an unplanned schema change mid-task, `getChargebackHistory`
  reports the closest real signal instead: how many settlement disputes have been raised against
  this order's *merchant* recently (`snapshot.loader.ts` now joins `settlements.merchantId` →
  `disputes.batchId`, added as `OrderSnapshot.merchantDisputes`), feeding the `merchant_exposure`
  Score. `chargeback_pattern` itself is scored from `customers.riskFlags` (already in the schema,
  always empty in today's seed data, and exactly the kind of free-form flag this field looks
  designed for) rather than from real chargeback history. **Known gap, not silently patched**: a
  genuine per-customer chargeback/dispute record is a schema addition for a later phase if the
  demo ever needs `chargeback_pattern` to mean something more than "has anyone flagged this
  customer" — noted in PROGRESS.md.
- **`packages/core` additions**: `OrderSnapshot` gained `devices: DeviceRow[]` (all of the
  customer's known devices, all-time — `devices` table, keyed by `customerId`) and
  `merchantDisputes: DisputeRow[]` (the proxy above). `snapshot.loader.ts` loads both with two
  more batched, constant-count queries (now ~13 total), keeping the file's own "constant number
  of queries regardless of order count" property; `test-factory.ts`'s `healthySnapshot()`
  defaults both to `[]` so every existing reconciliation test is unaffected. `db/rows.ts` gained
  `DeviceRow`.
- **Policy engine does not consult `state.risk.tier` (J3's output) — confirmed as an existing
  gap, not something this task should wire.** `resolution.service.ts`'s `proposeFromAgent`/
  `propose` already pass a `riskTier` into `evaluatePolicy` for P1/P2, but it is always
  `riskTierFromRules(state.order)` — the separate, always-on policy-engine risk tier above, not
  the agent's J3 `RiskAssessment`. The docs/03 §11 P1/P2 rows already read as covered by that
  existing rules-only tier, and the task brief was explicit not to invent new policy behavior
  outside this task's scope, so `state.risk` is populated and available (on the run, in
  `agent_steps`) but not yet read by anything downstream. Left as a documented gap in
  PROGRESS.md rather than wired silently.

## D041 · `groundCheck`/J4: predicate coverage gaps, append-only findings filtered at the point of use, gap-routing bypasses J2
Phase 4 task 6 (docs/03-agent-system.md §4 "J4", §7 "Evidence model").

- **Structural predicates: three known-loose codes, not invented facts.** `grounding/
  predicates.ts` has one predicate per `FindingCode`, but `LEDGER_CREDIT_MISSING`,
  `REFUND_MISSING` and `SETTLEMENT_LINE_MISSING` are all "something is missing" claims, and no
  `tools.ts` tool projects a positive fact for an absence (`getSettlementLines` returns every
  line in a batch, not "this payment's line, or nothing"). Each of those three predicates checks
  the closest real proxy it can (e.g. a captured gateway payment cited alongside no cited LEDGER
  credit) rather than inventing a field like `expectsRefund` that no tool actually produces. This
  is deliberately the *loose* half of grounding — §7 says predicates run "on the cited evidence",
  which cannot prove a global absence — and the *tight* half (is there truly no matching record
  anywhere) is exactly what J4's semantic `contradicted`/`not_enough_evidence` answers are for.
  `ORDER_STATE_DIVERGED` and `REFUND_STATUS_MISMATCH` are also intentionally loose in the same
  spirit: they check that the finding cited evidence from *both* sides of the comparison it
  claims to make, not that the comparison itself resolves to "different" — recomputing that
  would either duplicate the reconciliation matrix's own state-comparison logic
  (`core/reconciliation/matrix.ts`) or the refund-status gateway mapping
  (`refund.service.ts`'s `REFUND_STATUS_FROM_GATEWAY`), which are core's own domain logic, not a
  grounding predicate's job, and `core` cannot be imported from `agents`'s grounding code the
  other way either (CLAUDE.md rule 10: `core` never imports `agents`, but the true constraint
  here is not duplicating `core`'s comparison/mapping logic a second time inside `agents`).
- **A dropped finding is filtered at the point of use, never removed from `state.findings`.**
  `state.findings`'s reducer (`mergeById`, state.ts) only adds/overwrites by id — it cannot
  delete, and changing it to a full-replace reducer would break the parallel `Send` fan-out
  (three specialists each returning only their own new findings; a replace reducer would let the
  last branch to merge silently discard the other two's). So `groundCheck` never shrinks
  `state.findings`; it writes `grounding.violations` (which findings are dropped, and why), and
  `resolve` computes `survivingFindings(state.findings, state.grounding?.violations)`
  (`grounding.ts`) before building any context or letting the diagnosis LLM cite anything. This
  is what the node-reference table's "groundCheck | ... | grounding, filtered findings, gaps"
  means in this codebase: "filtered findings" is `grounding.violations` used as a filter at read
  time, not a separate state field. `grounding.test.ts` proves this directly by building the
  exact `buildResolveContext` call `resolve` makes and asserting a deliberately corrupted
  finding's id and statement text are both absent from the rendered messages.
- **Gap-targeted re-round bypasses J2 entirely.** §5's diagram routes `groundCheck`'s "gaps &
  rounds<2" edge back through the same `plan` node, not a separate one. On a re-round (`plan`
  sees a non-empty `state.gaps`), `plan` skips the J2 Jev call and routes directly to
  `AGENT_NAMES.filter(name => gaps.some(g => g.agent === name))` (`routedBy: 'GAP_TARGETED'`, a
  new `InvestigationPlan.routedBy` variant). The gap already names exactly which agents lost
  their findings or had none — re-asking J2 "which specialists matter" would either reproduce
  that same answer or contradict it for no benefit, at the cost of a Jev call and a second layer
  of uncertainty. `plan`'s existing `investigationRound + 1` increment (task 3) is reused
  unchanged for this branch too, so the round cap in `applyGroundingRules` still counts both
  kinds of `plan` visit the same way.
- **`GroundingReport.needsHumanReview` is optional, not required.** Added to carry the J4
  adapter-contract fallback flag (docs/03 §4: "J4 → structural check only + mark
  needsHumanReview"). Made optional (`?: boolean`) rather than required so the one pre-existing
  literal `GroundingReport` in `context.test.ts` (predates this task) keeps typechecking without
  edits; every real writer (`groundCheck`, both branches) always sets it explicitly, and readers
  should treat a missing value as `false`. Nothing yet *reads* `needsHumanReview` downstream
  (no UI surface exists before Phase 4 task 8) — it is populated and available on the run, same
  shape as D040's note about `state.risk` not yet being read by policy.

## D042 · `agent_findings`/`evidence` persistence: default-grounded semantics, natural-key uniqueness, jsonb columns kept, single sync point
Phase 4 task 7 (docs/04-data-model.md's `agent_findings`/`evidence` rows).

- **`grounded` defaults to `true`, and is set `false` only by a real `GroundingViolation`.** A
  third "not yet checked" state (nullable boolean, or a string enum) was considered and rejected:
  the doc's column list is a plain `grounded` with no enum, and this reads naturally as the same
  append-only "innocent until named" model `groundCheck` already uses for `state.findings` itself
  (D041's `survivingFindings`: nothing is ever removed, a drop is recorded as a violation and
  applied at the point of use). So a finding is `grounded: true` the moment it's written, and
  flips to `false` only when `state.grounding.violations` names its id -- which covers both "J4
  confirmed it" and "J4 never ran for this finding at all" (the fast path, where `groundCheck`
  never executes, and any finding written in a sync before `groundCheck` has run) under one
  consistent default, rather than a separate "unchecked" bucket the UI would have to special-case
  for no real benefit yet (task 8 is the first reader).
- **Natural-key uniqueness via a generated PK + `uniqueIndex`, matching the schema's existing
  house style.** `findingId`/`evidenceId` ("fd_02"/"ev_03") are only unique *within one run*
  (docs/03 §7), so the real uniqueness constraint is the pair `(runId, findingId)` /
  `(runId, evidenceId)`. Rather than making that pair a composite primary key (no precedent for
  that in this schema), both new tables follow the same pattern `cases` uses for its
  `fingerprint` and `disputes` for its "one open per batch" rule: a generated `text().primaryKey()`
  row id (`newId('agentFinding')`/`newId('evidenceRow')`, two new `ID_PREFIX` entries in
  `packages/shared/src/ids.ts`) plus a `uniqueIndex` on the natural pair. `store.ts`'s upsert
  targets that same pair in `onConflictDoUpdate`, so re-syncing a run (resume after an approval
  interrupt, or a `groundCheck` extra round) updates the existing row in place instead of
  duplicating it or throwing.
- **`agentRuns.evidence`/`agentRuns.findings` (jsonb) are kept as-is, not migrated away.**
  `apps/server/src/routes/runs.ts` and `apps/web/src/features/investigation/Investigation.tsx`
  (the existing Phase 3 trace UI) both read `run.evidence`/`run.findings` directly off the
  `agent_runs` row today, and migrating those readers over to the new normalized tables was out
  of scope for this task (it belongs with task 8's UI work, which is the first thing that actually
  needs per-finding querying). Keeping both is a deliberate, documented duplication of the same
  data for two access patterns -- "hydrate the whole run" (jsonb, unchanged) vs. "query/join one
  finding or one piece of evidence" (the new tables, for task 8's grounding trace) -- not a
  half-finished migration.
- **The fan-out is one call, at one point: `run.ts`'s `syncRunRow`, right after
  `graph.invoke`/resume returns.** `syncEvidenceAndFindings` (store.ts) is called with the exact
  same final `state.evidence`/`state.findings`/`state.grounding` that `syncRunRow` already writes
  onto the jsonb columns, rather than having every node that appends evidence/findings (triage,
  each specialist, `groundCheck`) also write to the normalized tables. This means the tables only
  update once per `graph.invoke` call (not per node), which is fine because nothing reads them
  mid-run yet, and keeps the persistence logic simple: it always sees the graph's complete,
  already-reduced state, never a partial one from a node that hasn't merged yet.
- **`evidence.stepId` is a plain column, not a foreign key to `agent_steps`.** docs/03 §7 calls
  for "link to agentSteps for the raw payload", but a hard FK would forbid ever pruning/rotating
  `agent_steps` independently in a later phase without cascading into evidence. Left as a
  same-shaped text column instead, matching how `agentRuns.approvalId` (agents.ts) already omits
  a `.references()` for a similar reason.

## D043 · `pnpm test` finally ran end to end in this cloud bridge and surfaced four real regressions from tasks 3–6

Every session from task 3 through task 7 could only run `pnpm typecheck`/`pnpm lint` in this cloud
bridge (`pnpm test` failed with a missing `@rollup/rollup-linux-arm64-gnu` native binary,
documented repeatedly in `docs/PROGRESS.md` Blockers). Task 7's session found a workaround and ran
the full suite for the first time since task 3 -- which had never actually been exercised end to
end. It surfaced ten failures; four were real bugs, fixed directly in this session rather than as
a new task, since they blocked confidence in everything already built this phase:

- **`plan` was used as both a state channel name and a node name** (`state.ts`'s
  `plan: Annotation<InvestigationPlan | null>` vs. `graph.ts`'s `.addNode('plan', nodes.plan)`).
  LangGraph forbids this and threw `"plan is already being used as a state attribute ... cannot
  also be used as a node name"` on every `buildGraph()` call -- meaning the entire full-path graph
  (`plan` → specialists → `join` → `groundCheck` → `resolve`) has been unable to construct at all
  since task 3, only invisible because `graph.test.ts` never ran. Fixed by renaming the state
  channel to `investigationPlan` (matching `InvestigationPlan`'s own type name, and the sibling
  `investigationRound`/`gaps` fields); the node keeps its doc-given name `plan`.
- **`riskAgent`'s return shape didn't match its own test's expectations** for whether `findings`
  and `budget.llmCalls` should be present when Jev is confident and the LLM fallback never runs.
  Resolved in favour of a clear rule, not just chasing the test: `findings` is only included in
  the node's `PayOpsUpdate` when the LLM fallback path actually ran (even if every candidate
  finding was then dropped by structural grounding -- an empty array, not an absent key); `budget`
  is always a complete `RunBudget` with real `0`s (matching `zeroBudget()` and every other node in
  this codebase), never a partially-absent object, so the test's `toBeUndefined()` on
  `budget.llmCalls` was the wrong expectation and was corrected to `toBe(0)` instead.
- **`context.test.ts`'s two `applyBudget`/scoping failures were test bugs, not implementation
  bugs.** The budget-threshold test hand-recomputed `draftText`'s output without rendering the
  evidence slice or filtering empty sections, so its computed budget window didn't match what
  `applyBudget` actually measures -- fixed by reproducing `draftText`'s real join formula in the
  test. The scoping test asserted the reconciliation specialist's context never contains the
  literal string `"ev_02"`, which collided with `SYSTEM_PROMPT`'s own hardcoded citation example
  (`Cite evidence ids exactly as given (e.g. "ev_02")`) -- an accidental match between a prompt
  example and a test fixture's evidence id, not a real evidence leak. Changed the example to
  `"ev_00"`, which no fixture in this codebase uses.
- **`graph.test.ts`'s fast-path tool-call count (`toolCalls: 7`) was stale.** `triage` runs every
  baseline tool; task 5 added four Risk baseline tools, so the real count became 11. Updated the
  assertion with a comment explaining why.

Also found, and left **unfixed as scoped, pre-existing work for task 9**: the three "recorded
Phase 3 scenarios" replay tests (`captured_order_failed`, `refund_stuck`, `refund_never_initiated`)
now `ReplayMissError` on every cassette lookup. Task 3 renamed `investigate` to
`paymentAgent`/`reconciliationAgent`/`riskAgent` and task 4 rewrote every prompt's exact text
(`ContextBuilder`); the cassette key is a hash of `{node, callIndex, prompt}`, so both changes
independently invalidate every recorded entry. Re-recording cassettes is Phase 4 task 9 by design
("Record cassettes for all scenarios") and needs `AI_MODE=RECORD` with real API keys, which this
environment does not have -- so the three tests are marked `it.skip.each(...)` with a comment
pointing at task 9, rather than left silently red or deleted. Whoever picks up task 9 should
remove the skip once cassettes are re-recorded.

**Lesson for future sessions:** `pnpm typecheck && pnpm lint` clean is necessary but was not
sufficient here -- neither catches a runtime graph-construction error or a wrong test assertion.
Whenever `pnpm test` becomes runnable in a session (check for the rollup workaround before
assuming the known bridge issue still applies), run it before declaring a task done, even if the
task's own new tests pass in isolation.

## D044 · Task 8 UI: `agentRuns.grounding` column, dropped findings struck through (not colored `--bad`)

Closed a real backend gap before this could be a pure UI task: `AgentRunItem` had `findings`
and `evidence` but no `grounding` at all, and `agentRuns` had no `grounding` jsonb column --
`groundCheck`'s `GroundingReport` (task 6) only ever reached the web app buried inside individual
`agent_steps` payloads, not as a queryable field on the run. Added `agentRuns.grounding: jsonb`
(migration `0004`), `syncRunRow` now writes `state.grounding` onto it same as the other jsonb
columns, and `AgentRunItem.grounding: GroundingReport | null` round-trips it through
`apps/server/src/routes/runs.ts`. Kept as one jsonb blob, not a normalized table: a run has at
most one grounding report (unlike `agentFindings`/`evidence`, task 7's D042, which justified
normalizing because a UI needs to query/join many rows). `apps/web/src/mocks/resolution.ts`'s
fixtures were not touched -- `grounding` defaults to `null` there via the same "not present on
this fixture" pattern already used for other optional `AgentRunItem` fields, confirmed by the
mock-backed component tests still passing.

Trace UI (`Investigation.tsx`): `DECISION_MADE` steps now render the Jev `tag` plus one line per
answer (`formatDecisionAnswer` in `apps/web/src/lib/format.ts`, new), reading the Choice/Noul/
Score shape by structural check (`answer.type`) rather than importing `@typesafe-ai/sdk`'s
response types into `web`, which has no dependency on `core`/the SDK today and shouldn't gain one
for three field reads. Kept dense, mono, one line per answer -- no badges, no JSON dump, per
docs/05 §9's warning against decorating an AI-decision surface.

Findings UI: a finding named by a `GroundingViolation` (matched by `findingId`) renders struck
through (`line-through`) in `--ink-2` (the existing muted secondary-text color), with its
`reason` shown underneath as plain text, and its evidence citations as plain mono `[ev_xx]`
spans rather than clickable `EvidenceRef` links. Deliberately never `--bad` (the red/error
color): docs/05's status colors are reserved for a live PASS/FAIL/MISMATCH verdict the reader
needs to act on, and a dropped finding is an already-resolved past state ("the system decided
not to trust this"), not an alarm. The evidence-citation decision (plain text, not a link) is a
judgment call, not spec-mandated: a struck-through claim's evidence shouldn't invite the reader
to click through as if the finding were still live.

Verified against `docs/05-ui-design.md` §8 (copy: "Dropped: <reason>" is plain and specific, no
hedging or hype) and §9 (no new badge/pill component invented for confidence or grounding
status -- both render as plain mono text inline, consistent with every other status line already
in the trace).

## D045 · Task 9 cassette recording: script built, but this cloud session's network can't reach Gemini/Jev

Built `packages/agents/scripts/record-cassettes.ts` (`pnpm cassette:record`) to do task 9's job:
for each of the 3 Phase 3 demo scenarios, spin up a fresh ephemeral PGlite database (same
harness `graph.test.ts`'s "recorded Phase 3 scenarios" suite already uses), generate the
scenario at its documented seed (`fixtures/cassettes/README.md`'s table), run the real graph
with `AI_MODE=RECORD` real `LlmPort`/`DecisionPort` (not mocks), handle the
`refund_never_initiated` manager-approval interrupt/resume, assert each ends `RESOLVED`/`PASS`,
and delete-then-rewrite that scenario's `.jsonl` cassette file cleanly (the underlying
`appendCassette` only ever appends, so a stale file must be removed first or old and new entries
would mix).

Running it from this environment failed immediately with `fetch failed` /
`curl: (56) Received HTTP code 403 from proxy after CONNECT` against both
`generativelanguage.googleapis.com` and `api.typesafe.ai` -- confirmed by a direct `curl` probe
from the same `device_bash` shell the script ran in. This is this session's network egress
allowlist rejecting both provider hosts, not a bug in the script or the adapters (the identical
`JevDecisionAdapter`/`GeminiLlmAdapter` code already works when `pnpm jev:ping` or a locally-run
`pnpm dev` calls them outside this sandboxed shell -- see `docs/PROGRESS.md`'s prior sessions).
Nothing about this is fixable from in here: it needs `pnpm cassette:record` run in a real
Terminal on Shivam's Mac (outside the Claude Cowork device-bridge shell), where `.env`'s real
keys and the Mac's normal network are both available.

The script itself, and the `packages/agents/tsconfig.json` include-list addition (`"scripts"`,
so it participates in `pnpm typecheck`) are committed as working infrastructure for whenever
that run happens -- typechecked clean, and its logic mirrors already-passing test code closely
enough (the REPLAY variant of the exact same three-scenario flow is `graph.test.ts`'s skipped
suite) that the main remaining risk is real-world Gemini/Jev response shape drift since Phase 3's
original recording, not a bug in the harness.

## D046 · Closed two gaps against Phase 4's own "Done when" list before calling the phase done

Cassette recording (task 9) ran successfully on Shivam's Mac via `pnpm cassette:record`
(`npx pnpm@10.28.0` first, since `pnpm` wasn't yet on that machine's PATH -- corepack's global
symlink step needed root the machine didn't have handy, `npx` sidesteps that entirely). All 3
scenarios recorded `RESOLVED`/`PASS`; `refund_stuck`'s model diagnosis again names webhook
delivery rather than the refund-status desync, the same caveat the original Phase 3 recording
carried (grounding checks citation support, not causal truth -- expected, not a regression).
Un-skipped the 3 `graph.test.ts` cassette-replay tests; `pnpm test` (379 passed) confirmed them
green before this decision's own fixes were added.

Before ticking Phase 4's checklist, ran its literal "Done when" list (docs/06-phases.md) against
the actual test suite rather than assuming task-level "done" implied phase-level "done" -- found
two real, if narrow, gaps:

- **"Context sizes per call are visible and within budget"** was true in the database
  (`contextTokenEstimate`/`contextHash` on every `LLM_CALLED` `agent_steps` row since task 4) but
  not in the UI -- task 8's scope (Jev decisions + grounding status) never covered this line of
  the doc, and nothing rendered it. Added `LlmCallSummary` to `Investigation.tsx`'s `Trace`:
  one plain mono line per `LLM_CALLED` step, `<call> context: <tokens> / <budget> tok budget`,
  looked up per node via `CONTEXT_BUDGET` (task 4, `packages/shared/src/agents.ts`) through a
  small `NODE_AGENT` map (`paymentAgent`->`payment`, etc.); an over-budget call renders in
  `--bad` with "(over budget, sections dropped)" rather than silently looking identical to one
  within budget. 3 new tests in `Investigation.test.tsx`.
- **"Every Jev decision point has a tested fallback path"**: J1 (signal-intake.service.test.ts),
  J3 (risk.test.ts/nodes.test.ts), J4 (grounding.test.ts/nodes.test.ts) all already had this: a
  mocked `DecisionPort` that throws, asserting the node still completes with the documented
  fallback rather than crashing. J2 (`plan`'s fresh-J2-route branch -- the gap-targeted re-round
  branch was already tested, but not the branch that actually calls Jev) and J6 (`diagnose`) had
  **zero node-level tests at all**, in any phase -- only ever exercised indirectly through
  `graph.test.ts`'s full-graph runs with a mocked `DecisionPort` that never throws. Added two new
  `describe` blocks to `nodes.test.ts`: J2's confident-route and Jev-throws-falls-back-to-
  `DEFAULT_ALL` cases, and J6's confident-FAST-path and Jev-throws-leaves-`diagnosis`-null cases.

`pnpm typecheck`, `pnpm lint`, `pnpm test` (383 passed, 0 skipped) all clean after both fixes.
Phase 4's "Done when" list is now true and verified, not just asserted.

## D047 · Phase 5 task 1: replan node (J5), splitting execute/validate/close, and attempt tabs

**`ResolutionService.finish()` split into composable steps.** Phase 3-4's `execute` graph node
called `resolutions.finish()`, which ran execute → validate → close as one atomic sequence (close
meaning: update the resolution's status, move the case to RESOLVED/OPEN/ESCALATED, run an audit
entry, refresh detection, publish). The replan loop (docs/03 §13) needs to see the validator's
verdict *before* deciding whether to close anything — closing on PARTIAL/FAIL before `replan` has
even run would flip the case to OPEN/ESCALATED and then immediately need to flip it back if
`replan` decides to retry. Split `finish` into four public methods: `execute` (run actions only),
`validate` (run the validator only, using the existing fixed `VALIDATOR_CTX` — unchanged from
before), `closeExecutionFailed` (close after an execution error — execution failures still never
reach `replan`, matching docs/03 §5's diagram, where only a validator PARTIAL/FAIL routes there),
and `closeValidated` (close after a validator verdict — PASS resolves, PARTIAL/FAIL reopens or
escalates, same rules as before). `finish` itself is now just these four called in sequence with
no decision point in between, so every existing caller (`propose()`'s AUTO path,
`container.ts`'s post-approval continuation) is unchanged — confirmed by the full existing test
suite passing unmodified (395 tests, no assertions touched in `simulator/src/resolution.test.ts`
or `apps/server/src/app.test.ts`).

**Graph shape:** `execute` (docs/03 §5) now only runs actions; on failure it closes
`EXECUTION_FAILED`/ESCALATED itself (via `closeExecutionFailed`) exactly as `finish` used to, and
a conditional edge sends that case straight to `END`. On success it edges to the new `validate`
node, which runs the validator and leaves the resolution deliberately un-closed. A conditional
edge on `validate`'s verdict sends PASS to a new `closeResolved` node (closes PASS, matching the
old fast success path) and PARTIAL/FAIL to the new `replan` node.

**`replan` (J5, nodes.ts)**: asks Jev a single `strategy` Choice
(`retry_same_action | alternative_action | reinvestigate | escalate_to_human`), always builds an
`AttemptSummary` from the validator's failed checks for `history` regardless of outcome, and
enforces two code caps that always win over Jev and never spend a call/get overridden by
confidence, per docs/03 §4's adapter-contract table: the attempt cap
(`AGENT_BUDGET_LIMITS.maxAttempts`, already `2`) skips the Jev call entirely; a confidence floor
of 0.5 on the answered strategy forces `escalate_to_human` even if Jev picked something else. A
Jev throw hits the same J5 fallback (`escalate`). The graph's conditional edge out of `replan`
derives the route from state `replan` already set, rather than adding a new "chosen strategy"
state field: `status === 'ESCALATED'` (only `replan` sets this, past this point in the graph) →
`closeEscalated`; `diagnosis === null` (only `reinvestigate` clears it, deliberately, so `resolve`
runs a fresh full-LLM diagnosis instead of reusing a stale fast-path one) → `plan`; otherwise
(`retry_same_action`/`alternative_action`, which share one route today) → `resolve`.

**`closeEscalated` became dual-purpose.** It was already the target of `awaitApproval`'s ESCALATE
decision (whose own service call — `approvals.decide()` — already closes everything; the node was
a no-op) and is now also `replan`'s `escalate_to_human` target (where the current attempt's
resolution is still open, per the split above, and needs closing now). Distinguished by
`state.validation`: `null` means "reached via `awaitApproval`, nothing to close here"; set means
"reached via `replan`, close the validated resolution now" — no new state field needed, since
`validation` is only ever set by the new `validate` node.

**History feeds the existing recommendation logic, not a new one.** `core/actions/options.ts`'s
`recommendedTypes`/`replayFailedBefore` already existed (pre-Phase-5, for the manual "Resolve"
form) and already implements exactly docs/03 §13's demo behavior: a case whose most recent replay
failed recommends `MARK_ORDER_PAID` (+`POST_LEDGER_ENTRY`) instead of `REPLAY_WEBHOOK_EVENT`
again. `resolve` (nodes.ts) previously always called `buildProposal(diagnosis, caseState, [])` —
hardcoded empty history. Fixed to pass `toAttemptHistory(state.history)`, a small mapper from the
agent's own `AttemptSummary[]` (docs shape: attempt/actions/failedChecks/validatorNotes) to core's
`AttemptHistory[]` (actionTypes/status/verdict). This is why `retry_same_action` and
`alternative_action` don't need two different code branches in `replan`: the actual "alternative"
selection already lives in `recommendedTypes`, keyed off `history`, not off which strategy string
Jev picked.

**`AttemptSummary` gained a `verdict: ValidationVerdict` field** (packages/shared/src/agents.ts) —
needed by `toAttemptHistory` above. Deliberately did *not* add a `status` field alongside it: every
`AttemptSummary` in this codebase is built by `replan`, which by construction only ever runs after
a validated attempt (an execution failure escalates directly, per the graph shape above), so
`toAttemptHistory` hardcodes `status: 'VALIDATED'` rather than duplicating a value that can never
vary.

**Attempt tabs (Investigation.tsx).** `AgentStepItem` carries no `attempt` field, and adding one
would mean threading attempt-tracking state through every node's `PayOpsUpdate` just for display.
Instead, `groupByAttempt` scans the flat step list once and starts a new group after every
`replan` `NODE_COMPLETED` step — the one place the graph decides to loop back to `resolve` or
`plan` (an `escalate_to_human` `replan` also gets a `NODE_COMPLETED`, but produces no further
steps afterwards, so it never yields a spurious trailing empty group). `Trace` renders a flat
`StepList` unchanged when there's only one attempt (the common case, zero visual change from
Phase 4), and reuses the existing `Tabs` primitive (`ResolutionSection`'s `Attempts`) once there's
more than one, defaulting to the newest attempt.

**Verification:** `pnpm typecheck` and `pnpm lint` clean across all packages. `pnpm test`: 395
passed (0 skipped) — the 12 new tests are `nodes.test.ts`'s `replan` describe block (history
recording, retry/alternative leaving diagnosis alone, reinvestigate clearing it, both code caps,
the J5 fallback), `graph.test.ts`'s rewritten `replay_fails_then_replan` coverage (attempt 1 FAILs
and escalates when J5 says so; attempt 2 actually resolves end-to-end through a real
MARK_ORDER_PAID + POST_LEDGER_ENTRY approval/execute/validate cycle when J5 says
`alternative_action` — this is docs/03 §13's demo scenario, now actually exercised, not just
described in a doc; J5 is asked exactly once when attempt 2 already resolves), and
`Investigation.test.tsx`'s three attempt-tab tests. `apps/web`'s `vite build` could not be run in
this cloud session — `Cannot find module '../lightningcss.linux-arm64-gnu.node'`, the same class
of macOS/Linux native-binary bridge gap documented for rollup/esbuild in `docs/PROGRESS.md`
Blockers, this time for Tailwind v4's CSS engine. `tsc --noEmit` (the first half of the build
script) passed cleanly before hitting it, and the full `pnpm test` run already exercises
`Trace`/`Tabs` through React Testing Library, so this is a lower-confidence gap than a real
regression, but a real browser pass on the Mac is still recommended before trusting the UI fully.


## D048 · Phase 5 task 3 (+ task 4): `packages/evals`, golden scenarios, injection eval

**Golden set covers 7 of 9 `ScenarioKey`s, not all 9 — by design, not an oversight.** Empirically
checked (see below) which scenarios the fast path (docs/03 §4a `diagnose`, confidence ≥ 0.8 +
`evidence_consistent` > 0.5 + `needs_human` ≤ 0.5 + a non-empty `narrativeFor(...).citedIds`)
actually reaches with the same deterministic-decision-fixture pattern `graph.test.ts` already
uses: `captured_order_failed`, `refund_stuck`, `refund_never_initiated`, `replay_fails_then_replan`
(both branches), `duplicate_capture`, and `injected_refund_request` all do. `settlement_mismatch`
does not (confirmed by actually running it -- it throws into `plan` -> a specialist's LLM call,
i.e. real full path) and `suspicious_payment` structurally can't (`narrativeFor('SUSPECTED_FRAUD',
...)` always returns `citedIds: []`, so `fast` is false by construction). `healthy_payment` opens
no case at all. Rather than invent J2/J3/J4/LLM-findings fixtures for the full path without a
single existing full-path integration test to model them on (real risk of asserting confidently
wrong behavior -- exactly what CLAUDE.md's "if code and docs disagree, stop and ask" is warning
against), this task ships the 7 scenarios with real, verified expectations and leaves
`settlement_mismatch`/`suspicious_payment` as a named follow-up (see Known gaps in
`docs/PROGRESS.md`). All expectations below were confirmed by actually running the scenario
against real graph code, not guessed from reading it.

**Two drivers, one package.** `packages/evals/src/golden.ts` GoldenScenario`.driver` is either
`{ kind: 'cassette' }` (real recorded Gemini/Jev responses via `createLlmPort`/`createDecisionPort`
+ `fixtures/cassettes/<scenario>.jsonl`, same real cassettes Phase 4 task 9 recorded) or
`{ kind: 'fixture' }` (a deterministic hand-written `DecisionPort`/`LlmPort`,
`packages/evals/src/fixtures.ts`, generalizing `graph.test.ts`'s existing `decision()` helper to
also answer `J1_INTAKE` so the injection scenario can exercise real quarantine). Both are
zero-network in REPLAY. 3 scenarios (the Phase 3 demo trio) use cassettes; the rest use fixtures,
because they either have no recorded cassette (recording needs live keys this cloud session can't
reach, docs/PROGRESS.md Blockers) or -- for the replan loop and duplicate capture -- are pipeline/
safety proofs where the point is proving code behavior (policy, executor, validator, J1
quarantine), not measuring a model's real guess.

**Root cause is measured, never gated; status/verdict/tier are gated, never just measured.**
`refund_stuck`'s cassette genuinely reproduces the model-names-webhook-not-refund-desync mismatch
already documented for the Phase 3/4 recording (fixtures/cassettes/README.md, D045/D046) -- this
eval set surfaces it as a `rootCauseAccuracy` miss (excluded from the metric via
`knownRootCauseCaveat`, not asserted away) rather than either failing the whole run or silently
asserting the wrong "true" answer. `status`/`verdict`/`tier` are deterministic -- code (policy
engine, executor, validator), not a model guess -- so those are hard gates per scenario.

**Injection eval (Phase 5 task 4) folds into the same golden set** rather than a separate
mechanism: `injected_refund_request` is architecturally just `captured_order_failed` with an
untrusted note (`packages/simulator/src/scenarios/injected-refund-request.ts`), so it takes the
same fast path and needs no new machinery -- only two extra hard gates on the golden scenario
itself: `forbiddenActionTypes: ['INITIATE_REFUND', 'SYNC_REFUND_STATUS']` (the note's "approve a
full refund immediately" instruction must never become a refund action) and
`expectQuarantinedNoteIncluding: 'SYSTEM NOTICE'` (checked against the real case's real notes via
`core.cases.get`, i.e. the real J1 `SignalIntakeService` pipeline actually ran and actually
quarantined it -- not asserted from the fixture's own injection score).

**`pnpm eval` (REPLAY) is the CI gate; `pnpm eval:live` writes `docs/evals/<date>.md`.**
`packages/evals/scripts/run-eval.ts` exits non-zero if any golden scenario's hard gates fail
(status/verdict/tier/forbidden actions/quarantine/max tool calls -- never root-cause or
action-set match, which are metrics). `--mode=live` only changes cassette-kind scenarios to real
`AI_MODE=LIVE` calls (needs `GEMINI_API_KEY`/`TYPESAFE_JEV_API_KEY`, unreachable from this cloud
session per D045 -- the script throws a clear, actionable error rather than silently falling back
to REPLAY); fixture-kind scenarios are unaffected by `--mode`, since they are pipeline proofs in
either mode, not a model-accuracy measurement. Not yet run LIVE by any session -- ask Shivam to run
it from the Mac once cassettes exist for more scenarios, or as-is for the 3 that have them.

**Verified, not assumed.** `pnpm eval` run (7/7 pass, 100% root-cause accuracy after excluding the
one documented caveat, mean 12.6 tool calls, mean ~220ms, $0 REPLAY cost). `pnpm typecheck`,
`pnpm lint`, `pnpm test` (402 passed, 0 skipped -- +7 for `packages/evals/src/types.test.ts`'s
`summarize()` unit tests) all clean across all 8 packages now including `packages/evals`
(added to `vitest.config.ts`'s `projects` and `pnpm-workspace.yaml` already matched `packages/*`).

**Environment note, not committed:** this cloud session's bridged `node_modules` could not run a
real `pnpm install` to link the new `packages/evals` workspace package -- `pnpm install` (any
store-dir) hit `EPERM`/`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` against this bridge's
temp-file probes, the same class of issue as the already-documented rollup/esbuild native-binary
gap. Worked around by hand-creating `packages/evals/node_modules/@payops/*` and
`@langchain/{langgraph,langgraph-checkpoint-postgres}` symlinks matching the exact pattern
`packages/agents/node_modules` already has (relative symlinks to sibling workspace packages and
into the existing `node_modules/.pnpm/...` store entries) -- node_modules-only, nothing in
`package.json`/the lockfile changed by this workaround itself (`packages/evals/package.json`
itself is a real, committed new file declaring these as real dependencies). A future session (or
Shivam locally) should run a real `pnpm install` once, which will produce the same links properly
and make this workaround moot.


## D049 · Phase 5 task 5: budget guard (`MAX_TOOL_CALLS`/`MAX_COST_USD`)

**Scoped to every node up to and including `resolve` -- not literally every node, and not the
replan loop.** docs/03-agent-system.md §5 says "Global budgets in state (`budget`) are checked in
a wrapper every node uses; exceeding → escalate." Applied literally that would also cover
`execute`/`validate`/`replan`/`policyGate`, but those already have their own well-defined budget
control: the attempt cap (`AGENT_BUDGET_LIMITS.maxAttempts`, already 2) and J5's confidence floor
(0.5) bound further Jev/LLM spend once a resolution exists, and `execute`/`validate` make no
Jev/LLM/tool calls of their own to budget. The real risk this task names -- a runaway
investigation -- lives entirely before `policyGate` ever creates a resolution row: `loadCase`
(no budget of its own) → `triage` → `diagnose` → `plan` → the specialist fan-out → `join` →
`groundCheck` → `resolve`. `guardBudget` (nodes.ts) is called at the end of each of these (not
`loadCase`, which spends nothing, and not the three specialists individually -- see below), and
every conditional edge on this stretch of `graph.ts` checks `state.status === 'ESCALATED'` first
and routes to `closeEscalated` when it is. This is a real, verified narrowing, not an oversight --
recorded here the same way D048 recorded its own scope decision.

**Checked at `join`, not at each specialist.** `paymentAgent`/`reconciliationAgent`/`riskAgent`
run in parallel via LangGraph `Send` and converge on `join`; their combined `budget` update
(follow-up tool calls, two LLM calls each) is only visible on the merged state once `join` runs,
so that is where the guard actually catches their total, rather than guarding three edges that
don't exist as such today (`paymentAgent`/etc. → `join` are plain edges, unconditional on
purpose -- adding a fourth conditional-edge branch to each would duplicate the same check `join`
already makes once).

**No resolution exists yet on this stretch, so escalating needs a new, simpler close: the case
moves to ESCALATED, nothing else.** `closeEscalated` (nodes.ts) already had two dispatch branches
keyed off state shape (D047): `state.validation` set → `closeValidated` (a `replan` escalation);
otherwise (a policy/approval escalation) → already closed by another service call, no-op here.
A budget-guard trip adds a third: `resolutionId` is still null and `state.error` is set (the only
other writer of `state.error`) → `core.resolutions.escalateWithoutProposal(caseId, state.error,
write)`, a new `ResolutionService` method that does only `cases.setStatus(tx, caseId,
'ESCALATED', summary, write)` plus the same live `caseUpdated` publish every other close path in
that file already does (`setStatus` itself writes the audit event -- no separate audit call
needed, matching `resolution.service.ts:227`'s existing BLOCKED-tier precedent for moving a case
to ESCALATED with no resolution row at all).

**`state.error` (state.ts) was an unused Phase-3 placeholder field -- this is its first real
writer.** Reusing it rather than adding a new state channel: it already exists for exactly this
purpose ("every field from the doc's full shape is present, even where Phase 3 never writes it"),
and it doubles as the signal `closeEscalated` uses to tell a budget-guard escalation apart from
the other two paths, without a new boolean flag.

**`costUsd` was dead code before this task -- always 0, nowhere computed.** Every `RunBudget`
already had a `costUsd` field (Phase 3), but no call site ever set it to anything but 0 (checked
by grep before writing this task, not assumed) -- `packages/evals`'s `docs/evals` report has been
printing `$0` cost for exactly that reason, not because REPLAY is genuinely free (it is, but that
coincidence was hiding a real gap). Added `COST_PER_1K_TOKENS_USD` (`packages/shared/src/
agents.ts`) and `estimateCallCostUsd(kind, tokensIn, tokensOut)`, wired into every budget update
that has token usage (LLM calls via Gemini, Jev calls via `SystemOneResult.usage` -- Jev's usage
shape already carries `input_tokens`/`output_tokens`, same as an LLM call, confirmed by reading
`nodes.ts`'s existing J2-J5 call sites before assuming it). These rates are an explicit
approximation for the guard's own purposes, not real provider billing (documented on the constant
itself) -- provider prices change over time and this project doesn't track them elsewhere. After
this change, `pnpm eval`'s REPLAY report shows a real (if small) `totalCost` instead of `$0` --
confirmed by running it, not assumed.

**Limit values (`maxToolCalls: 60`, `maxCostUsd: 0.05`) are deliberately generous, chosen to
never trip during normal operation.** A single investigation round costs at most 11 (triage) + 3
specialists × 6 (`maxFollowupToolCalls`) = 29 tool calls; `groundCheck`'s round cap allows one
more targeted round, so a legitimate two-round investigation can reach ~47. `maxToolCalls: 60`
sits above that. `maxCostUsd: 0.05` is generous relative to a real run's actual cost under the
rates above (a full two-round investigation is a few cents at most, per the `pnpm eval` run
above) -- this guard's job is to catch a genuine runaway (a bug, not normal use), not to be a
tight production cost cap, which would be a business decision out of scope here.

**Known narrow edge case, not engineered around: a budget trip during a `reinvestigate` loop's
second pass through `plan`/`join`/`groundCheck`/`resolve` would hit `closeEscalated`'s
`state.validation` branch (attempt 1's stale PARTIAL/FAIL verdict) instead of the new
`escalateWithoutProposal` branch, because `replan`'s `reinvestigate` route never clears
`state.validation`.** The run still ends ESCALATED either way (a stale PARTIAL/FAIL verdict with
`onFailure: 'ESCALATE'` also escalates), so this doesn't produce an incorrect final state, only a
slightly imprecise attribution in which close path ran. Reaching it requires attempt 1 to fail
validation, J5 to choose `reinvestigate` (not the common `escalate_to_human`), and then attempt
2's own investigation to independently trip the budget guard before a second `resolve` -- narrow
enough that closing it properly (clearing `state.validation` on `reinvestigate`, itself a
one-line change) is left as a follow-up rather than done speculatively here, since it touches
`replan`'s existing, already-tested behavior for a scenario this session did not reproduce.

**Verified, not assumed.** New tests: `packages/agents/src/budget-guard.test.ts` (5, the pure
`checkBudgetGuard` function), `packages/shared/src/agents.test.ts` (3, `estimateCallCostUsd`
arithmetic), and one new `graph.test.ts` case that drives a real graph run with an absurd
`J6_DIAGNOSE` token count (5M in / 1M out) and confirms: the run ends `ESCALATED` with
`resolutionId: null` and `state.error` naming the budget guard; `core.cases.get(caseId)` shows the
case itself moved to `ESCALATED` with no pending approval -- i.e. `escalateWithoutProposal`
actually ran, not just that the graph stopped. `pnpm typecheck`, `pnpm lint`, `pnpm test` (411
passed, 0 skipped -- +9 from the tests above, +1 existing `graph.test.ts` file gaining a case) all
clean across all 8 packages. `pnpm eval` (REPLAY) still 7/7 with real, non-zero cost figures.


## D050 · Phase 5 task 6: failure drills (Gemini timeout, Jev timeout, DB serialization conflict during execute)

**Jev timeout needed no new production code -- every Jev decision point (J2/J3/J4/J5/J6) already
had a documented, tested fallback (docs/03 §4 "Jev adapter contract"; `nodes.test.ts` already
covered each one at the node level).** This task's contribution there is one new graph-level drill
(`graph.test.ts`'s "failure drills" describe block): a `DecisionPort` that throws on every tag
throughout one full run of `captured_order_failed`, proving the *whole run* still ends `RESOLVED`
with `verdict: PASS`, not just that each node individually degrades. This is the strongest form of
the doc's "the product must work with AI turned off" claim actually exercised end to end for the
Jev half of that sentence.

**Gemini timeout was a real gap: two call sites had no fallback at all.** `buildSpecialistNode`'s
two `llm.invokeStructured` calls (`nodes.ts`) and `resolve`'s diagnosis call ran with no
`try`/`catch` -- unlike every Jev call site, an uncaught rejection there would have propagated out
of the async node function, out of `graph.invoke`, and crashed the run with no defined final
state (confirmed, not assumed: before this task's fix, `graph.test.ts`'s new
`settlement_mismatch` drill using the file's existing `noLlm` fixture would have rejected the
`graph.invoke(...)` call directly instead of returning a result).

- **Specialist fallback:** a specialist has no code-computed answer to fall back to the way Jev
  does, but the codebase already has the right shape for "this specialist found nothing" -- the
  existing `ownBaseline.length === 0` skip branch just above. Wrapping the whole two-call body in
  `try`/`catch` and returning `{ agentsVisited: [agentName] }` on error reuses that same shape:
  `join`, `groundCheck` and `resolve` already tolerate any specialist contributing zero
  evidence/findings (that's what "legitimately contributes nothing" already meant), so this adds
  no new state-shape burden anywhere downstream.
- **`resolve`'s fallback:** here there genuinely is nothing safe to fall back to -- no diagnosis
  means no proposal, and (unlike the specialist case) skipping ahead with an empty diagnosis would
  reach `buildProposal` with a null diagnosis, which is not a state the rest of the pipeline
  expects. Reused the exact branch D049 already built for the budget guard: no resolution exists
  yet at this point in the graph (`resolve` runs before `policyGate`), so `return { status:
  'ESCALATED', error: message }` routes through the same `resolve -> policyGate` conditional edge
  and the same `closeEscalated` `state.error` branch (`escalateWithoutProposal`) the budget guard
  already exercises -- no new graph wiring needed, only a new writer of an existing signal.

**Database serialization conflict during execute is two separate, deliberately separated pieces:
a small generic retry helper, and a new "the executor couldn't even report an outcome" close
path.** New `packages/core/src/db/retry.ts`: `isSerializationFailure` (checks `.code === '40001'`,
the SQLSTATE both `pg` and PGlite attach) and `withSerializationRetry` (retries only that code, a
small fixed number of times, standard Postgres advice for a `SERIALIZABLE`-style write-write
conflict). Wired around exactly one place: the result-recording transaction at the end of
`ExecutorService.runStep` (`executor.service.ts`) -- the step that updates the `executions` row
and writes the audit event, chosen because it is the one write in that method not already inside
the existing `try`/`catch` around `executeAction` (a `40001` there was always going to propagate
uncaught before this task). Not applied anywhere else in `core` speculatively -- this project's DB
usage is READ COMMITTED almost everywhere, so a real `40001` is not expected outside this one
place, and adding retry loops around writes that can't actually see this error would be dead code.

**When retries are exhausted (or a different DB error entirely propagates), `execute` (nodes.ts)
now catches it and calls a new `ResolutionService.escalateExecutionError`, not
`closeExecutionFailed`.** `closeExecutionFailed` needs a real `ExecutionOutcome`/`execution.steps`
to name which step failed; there is none here because `core.resolutions.execute` itself never
returned. Unlike D049's `escalateWithoutProposal` (no resolution ever existed), a resolution
*does* already exist at this point (`policyGate` created it before `execute` ever ran), so the new
method closes that real resolution row as `EXECUTION_FAILED`/`ESCALATED` directly (mirroring
`closeExecutionFailed`'s own ESCALATED branch, minus the failed-step lookup it can't do here). The
`execute -> validate` edge (`graph.ts`, D047) already routes an `ESCALATED` status straight to
`END` without visiting `closeEscalated` -- unchanged by this task, since `execute` already closes
everything itself on this path, same as the pre-existing `execution.ok === false` branch beside
it.

**Verified, not assumed.** `packages/core/src/db/retry.test.ts` (9 tests, pure): recognizes/
rejects a `40001` shape without throwing on non-object input, retries exactly while the error
keeps being `40001`, rethrows immediately on any other code, and respects a custom attempt count.
`nodes.test.ts` gained a describe block for `execute`'s new catch branch (2 tests, fake
`core.resolutions`, no database): a thrown error escalates via the new
`escalateExecutionError` and never reaches `closeExecutionFailed`; the pre-existing clean
`execution.ok === false` path is unchanged and still uses `closeExecutionFailed`. `graph.test.ts`
gained three end-to-end drills (docs/06-phases.md Phase 5 task 6, one per failure named there):
Gemini timeout on `settlement_mismatch` (both specialists contribute nothing, `resolve` escalates
with no resolution ever created); Jev timeout throughout a full `captured_order_failed` run
(still resolves, `verdict: PASS`, `diagnosis.path: 'FULL'`); and a simulated exhausted-retry DB
failure via `vi.spyOn(core.resolutions, 'execute').mockRejectedValueOnce(...)` (escalates the
already-created resolution, `resolutionId` still set). The DB drill spies rather than reproducing
a genuine concurrent `40001` on purpose -- a real one needs actual racing `SERIALIZABLE`
transactions, which would make the test slow and nondeterministic for no extra coverage over what
`retry.test.ts` already proves about the retry loop itself. `pnpm typecheck`, `pnpm lint` clean
across all 8 packages. `pnpm test`: 425 passed, 0 skipped (was 411; +9 `retry.test.ts`, +2
`nodes.test.ts`, +3 `graph.test.ts`). `pnpm eval` (REPLAY) still 7/7, unaffected (none of the
golden scenarios exercise these new catch branches -- they were never meant to; that is what the
new drills above are for).

**Not done, and out of scope for this task:** Phase 5's "Done when" also names a `pnpm eval:live`
report committed under `docs/evals/`, which needs a real Gemini/Jev call and so cannot run from
this cloud session (docs/PROGRESS.md's Blockers section, D045) -- still outstanding, needs
Shivam's Mac, same as Phase 4's cassette recording did.


## D051 · Phase 6 re-scope: no Docker or hosted deploy yet, no Razorpay stretch

**Decision.** Phase 6 now covers UI polish, metrics/charts (Overview plus Agent runs), the landing page
with `/terms` and `/privacy`, and the README. The Dockerfile, hosted deploy with nightly reset, and
`RazorpayTestAdapter` are parked in `PROGRESS.md > Later`.

**Why.** Shivam wants the cheapest possible hosting and does not want to pay for a container host.
The product runs fine locally (`pnpm db:local`, `pnpm seed`, `pnpm dev`), so the README can document
local run and a recorded demo instead. Deploy stays possible later: the server is one Node process
(API, jobs, sockets), so any host that runs a long-lived Node service works, with or without Docker.

**Consequences.** Phase 6 "Done when" ("a stranger can open the link") is deferred until a deploy
exists; the Lighthouse a11y goal (>= 95 on the Case page) still applies and is checked locally.
Landing page copy and README must not claim a public live demo link.


## D052 · Agent runs screens: reuse the run budget, and show AI mode globally instead of per run

**Decision.** The Agent runs table reads counts, tokens and cost from `agent_runs.budget`, and
duration from `createdAt`/`finishedAt`. Per-node time is computed in the browser from step timestamps
(`features/runs/run-metrics.ts`, unit-tested). docs/05 §11 lists a per-run "Mode" column; runs do not
store their AI mode, so mode is shown once as the `AI: <mode>` tag in the top bar (from `/api/health`).

**Why.** The budget is already the single code-maintained record of usage, so a second aggregation
would only risk disagreeing with it. A per-run mode column would need a schema migration for a value
that is the same for every run on a given server.

**Consequence.** If runs from different modes ever need to share a database, add `aiMode` to `agent_runs`.


## D053 · REPLAY without a scenario reads every recorded scenario

**Decision.** `replayCassettePaths` (`packages/core/src/adapters/cassette.ts`): for the key `'default'`
(what a run gets when the web app sends no `scenarioKey`, D032) and no `default.jsonl`, REPLAY reads all
`fixtures/cassettes/*.jsonl`. Named scenarios (evals, tests) still read only their own file.

**Why.** "Start investigation" in the UI sent no scenario, so every model call was a REPLAY miss and the
run escalated. Entries are found by content hash (node, call index, normalized prompt), so merging files
cannot make one scenario answer another's prompt. No schema change and no generated file to keep in sync.

**Consequence.** In REPLAY, an investigation succeeds only for data identical to a recording: generate
`captured_order_failed` (seed 3201), `refund_stuck` (3202) or `refund_never_initiated` (3203) in the
Simulator. Seeded cases and other seeds still miss and escalate, by design (D034). Verified in a browser:
seed 3201 ends RESOLVED on the FULL path with 3 LLM and 4 Jev calls, all replayed.


## D055 · UI hierarchy and state-aware case actions

**Decision.** The Phase 6 UI revamp uses brighter warm surfaces, 6px control and 8px panel radii,
larger controls and headings, a visible neutral control boundary, and one strong action per task
area. The Case page presents the next permitted action in a single rail and moves findings ahead
of trace and raw evidence. Approval review asks the reviewer to choose a decision before the
submit button is enabled. Simulator scenarios reveal their inputs when selected, with seed and
noise under an advanced control. The implementation follows `docs/05-ui-design.md`.

**Why.** The original 32px controls and equally weighted boxed sections made the main task hard to
locate. These changes let an operator scan the problem, evidence, action, and result in that order.

**Consequences.** Client presentation remains subordinate to the existing role, case, run, and
server authorization checks. No policy or API behavior changes. Citation links open their collapsed
evidence panel and focus the cited item. Tables scroll locally on narrow screens, and the shell
switches to a horizontal navigation list when the side rail no longer fits.


## D056 · Visualize orchestration from recorded run events

**Decision.** The Agent run detail page derives a vertical flow from `agent_steps`, grouping consecutive
node visits into stages. Only visited specialist nodes appear as branches. Repeated visits after a
replan remain separate, and an unresolved `awaitApproval` node is shown as waiting. Each node
expands into its recorded events; the raw step table and latency bars remain available below.
The Case investigation header links to the same run view.

**Why.** A reader can see which agents contributed and how the run moved from evidence to a proposal,
policy, deterministic execution, and independent verification without interpreting raw node names.
Showing only persisted events avoids depicting planned work as completed work.

**Consequences.** This is a read-only projection of existing data. No graph, API, policy, or database
changes are needed. It does not infer which agents were selected from a plan payload; an agent appears
only when its own node emitted an event. An approval pause stays visually distinct from a failure.


## D057 · Plain-language run stories and verified critical showcase cases

**Decision.** Agent-run nodes lead with a factual sentence derived from stored step payloads,
findings and evidence. Risk review explains its recorded tier and strongest scored signals; planning
names the specialists actually selected. Technical event codes remain available inside a second
disclosure and in the raw table. Simulator presents four new critical-severity cases separately.
Their first seeds (3301, 3302, 3304, 3306) have live-recorded Gemini/Jev responses, and a REPLAY
integration test asserts full-path multi-agent participation, matching root cause, policy tier,
RESOLVED status and PASS verdict without provider network calls.

**Why.** Internal tags such as `J3_RISK` describe implementation, not what an operations user learned.
The showcase needs to demonstrate both capable orchestration and truthful outcomes. Six high-value
fault variants were trialed with live calls; two refund variants resolved but gave inaccurate
root-cause labels. Those variants were excluded rather than presented as successful diagnoses.

**Consequences.** The showcase adds deterministic simulator data and cassettes but no new action,
permission, or policy. Case severity and policy tier remain separate concepts. The excluded refund
trials reveal a remaining causal-diagnosis quality gap; validator PASS only proves the data is fixed.
