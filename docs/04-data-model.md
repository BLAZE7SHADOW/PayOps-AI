# 04 · Data Model (Postgres / Supabase)

Drizzle schema lives in `packages/core/src/db/schema/`. Tables use snake_case; TypeScript fields use camelCase (Drizzle maps them). All money columns are `bigint` paise named `*_minor` (`*Minor` in TS). All timestamps are `timestamptz` UTC. Mutable tables have `created_at` and `updated_at`; append-only tables (ledger, audit, agent steps) have no `updated_at`. Field lists below use the TS names.

## External world (owned by the gateway adapter)

| Table | Key fields | Indexes |
|---|---|---|
| `gw_payments` | `id`, `orderRef`, `amountMinor`, `status` (CREATED/AUTHORIZED/CAPTURED/FAILED/REFUNDED/PARTIALLY_REFUNDED), `method`, `cardLast4`, `cardNetwork`, `cardCountry`, `capturedAt` | pk `id`, `orderRef` |
| `gw_refunds` | `id`, `gwPaymentId`, `amountMinor`, `status` (PENDING/PROCESSED/FAILED), `processedAt` | `gwPaymentId` |
| `gw_webhook_deliveries` | `id` (event id), `event` (payment.captured, refund.processed…), `gwPaymentId`, `attempts[{at, httpStatus, latencyMs, error}]`, `finalStatus` | `gwPaymentId` |
| `gw_settlement_lines` | `id`, `batchId`, `gwPaymentId`, `grossMinor`, `feeMinor`, `taxMinor`, `netMinor`, `settledOn` | `batchId`, `gwPaymentId` |

## Internal world

| Table | Key fields |
|---|---|
| `merchants` | `name`, `feeContract { pctBps, fixedMinor }`, `settlementCycle` |
| `customers` | `name`, `emailMasked`, `phoneMasked`, `createdAt`, `riskFlags[]` |
| `devices` | `customerId`, `fingerprint`, `ipCountry`, `firstSeenAt` |
| `orders` | `orderId`, `merchantId`, `customerId`, `amountMinor`, `status` (PENDING/PAID/FAILED/CANCELLED/FULFILLED), `paymentId?`, `version` (optimistic lock), `timeline[{at, from, to, by}]` |
| `payments` | `paymentId`, `gwPaymentId`, `orderId`, `amountMinor`, `status` (mirror of what we believe), `hold`, `attemptCount` |
| `payment_attempts` | `paymentId?`, `customerId`, `deviceId`, `result`, `failureCode`, `cardCountry`, `at` |
| `refunds` | `id`, `gwPaymentId` (always), `paymentId?` (null when the captured payment never reached our system, e.g. a duplicate capture), `gwRefundId?`, `amountMinor`, `status`, `reason`, `requestedAt` |
| `ledger_entries` | `entryId`, `paymentId?`, `refundId?`, `account` (CUSTOMER_RECEIVABLE, MERCHANT_PAYABLE, FEES, REFUNDS), `direction` (DEBIT/CREDIT), `amountMinor`, `postedAt`, `source` (system/manual/agent-executor), `reversalOf?` (append-only) |
| `settlements` | `batchId`, `merchantId`, `expectedNetMinor`, `reportedNetMinor`, `status` (MATCHED/MISMATCH/PENDING) |
| `disputes` | `type` (SETTLEMENT/CHARGEBACK), `refs`, `amountMinor`, `status` |
| `support_notes` | `caseId?`, `paymentId?`, `authorType` (CUSTOMER/MERCHANT), `text` (untrusted), `signals` (J1 result), `quarantined` |

## Operations

| Table | Key fields |
|---|---|
| `users` | `email`, `passwordHash`, `name`, `role` |
| `cases` | `displayId` (PAY-8291), `fingerprint` (partial unique index while status is open), `type` (PAYMENT_MISMATCH/REFUND_EXCEPTION/SETTLEMENT_MISMATCH/RISK_CASE/DUPLICATE), `severity` (LOW..CRITICAL), `priority` (number), `status` (OPEN/INVESTIGATING/AWAITING_APPROVAL/EXECUTING/RESOLVED/ESCALATED/REJECTED), `detection { ruleIds[], stateMatrix }`, `entityRefs`, `amountMinor`, `assigneeId?`, `activeRunId?`, `resolution { by: USER/AGENT, runId?, summary }`, `openedAt`, `resolvedAt?` |
| `agent_runs` | `caseId`, `threadId`, `trigger` (USER/AUTO/RESUME), `startedBy`, `status`, `aiMode`, `model`, `jevModel`, `attempts`, `rootCause?`, `proposal?`, `policy?`, `validation?`, `budget { llmCalls, jevCalls, toolCalls, tokensIn, tokensOut, costUsd }`, `startedAt`, `endedAt?`, `durationMs?` |
| `agent_steps` | `runId`, `seq`, `node`, `kind` (NODE/TOOL/LLM/DECISION), `name`, `input` (projected), `output` (projected), `contextTokens?`, `contextHash?`, `usage?`, `latencyMs`, `error?`, `at` (append-only) |
| `agent_findings` | `runId`, `caseId`, `findingId`, `agent`, `code`, `statement`, `evidenceIds[]`, `confidence`, `grounded` |
| `evidence` | `runId`, `evidenceId`, `source`, `system`, `entityRef`, `facts`, `stepId` |
| `resolutions` | one attempt to resolve a case: `caseId`, `runId?`, `attempt`, `actions` (CatalogAction[]), `rationale`, `proposedBy {type,id,name}`, `policy` (PolicyDecision), `status` (BLOCKED/AWAITING_APPROVAL/REJECTED/ESCALATED/EXECUTING/EXECUTION_FAILED/VALIDATED) |
| `approvals` | `resolutionId`, `caseId`, `tier` (OPS/MANAGER), `status` (PENDING/APPROVED/REJECTED/ESCALATED), `requestedBy`, `decidedBy?`, `comment?`, `decidedAt?` (one pending approval per case) |
| `executions` | `idempotencyKey` unique, `resolutionId`, `caseId`, `actionIndex`, `action`, `params`, `status` (STARTED/SUCCEEDED/FAILED), `summary`, `result`, `error?`, `startedAt`, `finishedAt` |
| `validation_results` | `resolutionId`, `caseId`, `attempt`, `verdict`, `checks[{ id, subject, description, expected, actual, pass, kind, actionIndex }]`, `at` |
| `disputes` | `type` (SETTLEMENT), `batchId`, `gwPaymentId?`, `amountMinor`, `status` (OPEN/WON/LOST), `reason`, `resolutionId` |
| `audit_events` | `actorType` (USER/AGENT/SYSTEM), `actorId`, `action`, `entityType`, `entityId`, `before?`, `after?`, `runId?`, `at` (append-only) |

LangGraph checkpoints: `PostgresSaver` (`@langchain/langgraph-checkpoint-postgres`) manages its own tables in the same database. pg-boss manages the `pgboss` schema.

## Detection rules (pure functions in `packages/core/src/reconciliation/rules.ts`)

| Rule | Fires when | Case type | Severity |
|---|---|---|---|
| D1 `CAPTURED_NOT_PAID` | gw CAPTURED ∧ order ≠ PAID for > 10 min | PAYMENT_MISMATCH | by amount band |
| D2 `PAID_NOT_CAPTURED` | order PAID ∧ gw ≠ CAPTURED | PAYMENT_MISMATCH | HIGH |
| D3 `LEDGER_MISSING` | gw CAPTURED ∧ no ledger credit | PAYMENT_MISMATCH | MEDIUM |
| D4 `DUPLICATE_CAPTURE` | > 1 gw CAPTURED for one orderRef | DUPLICATE | HIGH |
| D5 `REFUND_PENDING_SLA` | internal refund PENDING > 7 days | REFUND_EXCEPTION | MEDIUM |
| D6 `REFUND_MISSING` | order CANCELLED ∧ captured ∧ no refund after 48h | REFUND_EXCEPTION | by amount |
| D7 `SETTLEMENT_DIFF` | batch expected net ≠ reported net | SETTLEMENT_MISMATCH | by diff |
| D8 `RISK_VELOCITY` | ≥ 5 failed attempts in 24h then a capture ≥ ₹10,000 | RISK_CASE | HIGH |

Fingerprint = `caseType:primaryEntityId` (so D1 and D3 on the same payment merge into one case). Same fingerprint updates the open case instead of creating a new one; a partial unique index guarantees at most one open case per fingerprint.

Amount bands (code): `LOW < ₹1,000 ≤ MEDIUM < ₹10,000 ≤ HIGH < ₹50,000 ≤ CRITICAL`.

## State machines

- **Case:** OPEN → INVESTIGATING → (AWAITING_APPROVAL) → EXECUTING → RESOLVED | ESCALATED | REJECTED; ESCALATED/REJECTED → OPEN (reopen by user).
- **Run:** INVESTIGATING → AWAITING_APPROVAL → EXECUTING → VALIDATING → (INVESTIGATING on replan) → RESOLVED | ESCALATED | REJECTED | FAILED.
- **Order:** transitions enforced in OrderService with `version` check; invalid transition throws.
