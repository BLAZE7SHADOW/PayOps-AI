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
