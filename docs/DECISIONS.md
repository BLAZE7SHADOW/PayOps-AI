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
