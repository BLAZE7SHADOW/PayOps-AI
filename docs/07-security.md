# Security: threat model and data flow

Written in P4 task 4 (D078). Every claim below names the code that enforces it and the test that would fail if it stopped being true. If code and this file disagree, the code wins and this file is a bug.

## 1. What is protected

| Asset | Why it matters |
|---|---|
| Money actions (refunds, ledger posts, order status) | A wrong or forged action moves real money in a real deployment. |
| Audit log | The record of who did what; it has to be believable. |
| Customer identity (name, email, phone, card) | Personal data. It should not spread further than it must. |
| Credentials and keys (`.env`, session secret, Gemini and Jev keys, TOTP secrets) | Whoever holds them acts as the product or as a user. |
| Operator sessions | A stolen session is an analyst's authority. |

## 2. Trust boundaries

```
 browser ──(1)── Express API ──(2)── services/core ──(3)── Postgres
                      │                    │
                      │                    └─(4)── agents (LangGraph) ──(5)── Gemini
                      │                                   │
                      └─ Socket.IO (6)                    └──(5)── Jev (TypeSafe)
 customer / merchant text ──(7)── support_notes
```

1. Browser to API: cookie session, permission table, JSON-only writes.
2. API to core: services check permissions again for the rules that depend on data (four-eyes, tier).
3. Core to Postgres: the only path to data. Models are not on it.
4. Agents get DTOs built by tools, never a database handle.
5. Anything sent to Gemini or Jev leaves our control. Section 3 lists exactly what.
6. Sockets use the same session check as HTTP.
7. Free text typed by customers or merchants is untrusted input.

## 3. Data flow to Gemini and Jev

This is the full list of outbound payloads. The model providers receive nothing else.

| Call | Provider | What is sent | Built by | Never sent |
|---|---|---|---|---|
| J1 intake | Jev | One support note, after `scrubPiiText` removes emails, phone numbers and long digit runs | `SignalIntakeService.screenNote` | Case ids, customer fields, other notes |
| J6 diagnose, J2 plan | Jev | Case type, detection rule ids, amount band, mismatched systems, four boolean flags | `buildCaseBrief` (`brief.ts`) | Ids, exact amounts, names, notes |
| J3 risk | Jev | Seven bucket labels (account age, failed attempts, card countries, device count, mismatch flag, risk flags, merchant dispute exposure) | `bucketRiskSignals` (`risk.ts`) | Counts, ids, names, device fingerprints |
| J4 grounding | Jev | Finding statements (written by Gemini, scrubbed) and the cited evidence facts: statuses, amounts in paise, flags, dates | `buildGroundingRequest` (`grounding.ts`) | Customer fields, notes |
| J5 replan | Jev | Attempt number, failed validator check ids, a one-line validator note | `replan` (`nodes.ts`) | Everything else |
| Specialist follow-up and findings | Gemini | Case brief plus the evidence slice of that agent's own tools: statuses, amounts, id-present booleans, code-computed comparisons, scrubbed strings | `buildSpecialistContext` (`context.ts`) | Other agents' evidence, customer fields, notes, raw ids (replaced by `...IdPresent` booleans) |
| Resolve | Gemini | Case brief, finding statements (scrubbed), risk tier, grounding counts, the action catalog, prior attempt summaries | `buildResolveContext` (`context.ts`) | Raw evidence facts, customer fields, notes |

Facts that do leave, and are accepted: transaction statuses, amounts in paise, rule ids, opaque evidence ids (`ev_12`) and finding ids, merchant-level dispute counts as a bucket. None identify a person on their own.

What is stored about calls: the prompt itself is not stored. Each `agent_steps` row keeps a content hash and a token estimate. Cassettes (`fixtures/cassettes`) keep model responses only; the request is reduced to a hash key.

### Defence layers

1. **Whitelisted projection.** Tools return facts field by field. No tool selects a customer name, email, phone or card (`tools.ts`). Customers are stored masked at rest (`emailMasked`, `phoneMasked`), so a raw email or phone is not in the database to leak.
2. **Scoping.** A specialist's slice contains only its own tools' evidence (`sliceEvidenceForAgent`). Risk evidence (account age, flags) never reaches Gemini: Risk goes to Jev as buckets only.
3. **Key-based masking.** `maskPiiInFacts` masks any fact whose key looks like an email or phone.
4. **Value-based scrub.** `scrubPiiText` (`shared/mask.ts`) runs over string values and finding statements, and over the note text sent to J1. It removes emails, Indian mobile numbers and 12 to 19 digit runs. It does not remove names.
5. **Notes never reach Gemini.** There is no code path that puts note text in a Gemini prompt. J1 sees a scrubbed note for classification only. Quarantined notes affect behaviour through a boolean flag in the brief.
6. **Code does the numbers.** Models receive formatted money and comparisons computed in code, so there is no reason to widen what they see.

### Tests that prove it

| Test | What it proves |
|---|---|
| `packages/agents/src/egress.test.ts` | Seeds canary names, emails, phones and notes, runs five scenarios through the real graph with capturing Gemini and Jev ports, and fails if any canary appears outbound. Checked by mutation: leaking a customer name through `getOrder`, or removing the J1 scrub, makes it fail. |
| `packages/shared/src/mask.test.ts` | `scrubPiiText` on emails, phone spellings, card-length numbers, and text that must be left alone. |
| `packages/agents/src/context.test.ts` | Key masking, value scrub under unexpected keys, scrubbed finding statements in the resolve prompt, per-agent scoping. |

## 4. Threats and controls

| # | Threat | Control | Where | Test |
|---|---|---|---|---|
| T1 | A prompt-injection note makes the agent approve or execute a refund | Notes never enter a Gemini prompt (section 3). Even if one did, models propose from a closed catalog, and policy and executor are code that read case facts, not note text. J1 also flags likely injection and quarantines the note | `actions.ts`, `policy/`, `execution/`, `signal-intake.service.ts` | `injected_refund_request` scenario and the injection eval in `packages/evals`; `egress.test.ts` |
| T2 | The model hallucinates a finding to justify an action | Findings must cite evidence ids; structural predicates then J4 check support before resolve | `grounding.ts`, `grounding/predicates.ts` | `grounding.test.ts` |
| T3 | The agent proposes a wrong action that passes policy | Validator re-reads data after execution; a failure replans within limits or escalates | `validation/`, `replan` | `graph.test.ts` replan scenarios |
| T4 | One person approves their own high-value action | Four-eyes in `cannotDecideReason`; MANAGER tier needs MANAGER or ADMIN | `approval.service.ts`, `permissions.ts` | `permissions.test.ts`, approval tests |
| T5 | A route is added without an authorisation check | Test walks the real router and fails on any route without `requirePermission` or an explicit `publicRoute()` | `permissions.ts` | `apps/server/src/permissions.test.ts` |
| T6 | Credential stuffing or brute force on sign-in | scrypt password hashes, persistent rate limits, TOTP second step | `auth/password.ts`, `auth/rate-limit.ts`, `auth/totp.ts` | `auth-security.test.ts` |
| T7 | Stolen session cookie | httpOnly, SameSite=Lax, Secure in production, 8 hour signed token tied to a server-side session that can be revoked | `auth/session.ts`, `auth/session-store.ts` | `auth-security.test.ts` |
| T8 | Cross-site request forgery | SameSite=Lax cookies plus JSON-only state changes; CORS limited to `WEB_ORIGIN` | `auth/middleware.ts`, `app.ts` | `auth.test.ts` |
| T9 | Someone edits or deletes audit history | Hash chain with `verifyChain`, UPDATE and DELETE triggers, `GET /api/audit/verify` | `audit/chain.ts`, migration 0012 | `audit-chain.db.test.ts` |
| T10 | A retried or duplicated action moves money twice | Idempotency key per executor action | `execution/` | executor tests |
| T11 | Customer data spreads to model providers | Section 3 | `context.ts`, `mask.ts`, `tools.ts` | `egress.test.ts` |
| T12 | Secrets leak through logs or the repo | pino redacts auth headers, cookies and password fields; `.env` ignored; env read only through `env.ts` | `infra/logger.ts`, `.gitignore` | none (review only) |
| T13 | Spreadsheet formula injection through the audit CSV export | Cells starting with `=`, `+`, `-`, `@`, tab or CR get a leading apostrophe | `audit/csv.ts` | `csv.test.ts` |
| T14 | Oversized or malformed requests | 100 kb JSON limit, Zod `parseBody` on routes that take a body, helmet headers | `app.ts` | route tests |
| T15 | The public demo is abused to run live model calls | `AI_MODE=REPLAY` on the demo, `MAX_TOOL_CALLS` and `MAX_COST_USD` budget guard, demo sign-in only when `DEMO_MODE` | `budget-guard.ts`, `routes/auth.ts` | `budget-guard.test.ts` |

## 5. Known gaps

These are real and stated so nobody has to discover them.

- **Names are not scrubbed.** `scrubPiiText` finds emails, phones and card-like numbers. A customer's name typed into a note goes to Jev at J1. Customer fields themselves never leave, and notes never reach Gemini.
- **The scrub is pattern-based.** It will miss a phone number written in words, and it can over-remove a long reference number that happens to be 12 digits or more.
- **Evidence ids and amounts reach the providers.** They are opaque, but a provider could correlate them if it also held our data. It does not.
- **Audit chain limits.** A database owner can disable the triggers and rewrite the tail. Verification against a head saved elsewhere catches a cut tail. See D077.
- **No provider-side controls are verified here.** Whether Google or TypeSafe retain or train on prompts depends on each account's terms. Check those before using real data.
- **TOTP seeds depend on the signing secret.** They are AES-256-GCM encrypted with a key derived from `JWT_SECRET`, so leaking that secret exposes the seeds and lets anyone forge sessions. Production refuses to start without it; the dev default must never be used outside local runs.
- **No dependency or secret scanning in CI yet.** P6 covers CI.
- **Seed data is synthetic.** Nothing here has been run on real customer data.
