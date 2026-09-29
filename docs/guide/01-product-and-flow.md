# 01 · Product and flow

## What problem this solves

When a customer pays online, one payment is recorded in five places:

| System | Plain meaning | If it is wrong |
|---|---|---|
| Gateway | The payment processor that took the card | Rarely wrong; treated as the source of truth |
| Order service | The shop's record of "paid or not" | Customer paid but the shop says unpaid |
| Ledger | The accounting entries | Money received but not in the books |
| Webhook | The automatic "money received" message from gateway to shop | Message failed, so the shop never updated |
| Settlement | The later batch payout to the merchant | Payout is short or missing a line |

They should tell the same story. When they do not, someone in operations has to find which one is wrong and repair it safely. That is slow, repetitive and easy to get wrong. PayOps AI automates the finding, the diagnosis and the checked repair, and keeps an audit trail.

## The life of a case, step by step

1. **A payment is created or a sweep runs.** A background job (`reconcile-sweep`) compares the five systems every minute.
2. **Detection rules open a case.** These are plain code rules, no AI. Examples: `D1` gateway captured but order not paid; `D3` ledger entry missing; `D4` duplicate capture; `D5` refund pending too long; `D6` refund missing; `D7` settlement short; `D8` risky velocity.
3. **Intake screening (Jev J1).** If a case carries customer-written text, a small model screens it. Suspicious text is quarantined so it never reaches the main model as instructions.
4. **A person clicks "Start investigation"** on the case page. This queues a job. It does not run in the web request.
5. **The investigation runs** (see file 03). It gathers evidence, finds a root cause, cites evidence, and builds a proposal.
6. **The policy engine picks a tier** (see file 04): AUTO, OPS approval, MANAGER approval, or BLOCKED.
7. **If approval is needed**, the run pauses and waits, possibly for days. A different person approves or rejects on the Approvals page.
8. **The executor runs the actions**, each once.
9. **The validator re-reads all five systems** and returns PASS, PARTIAL or FAIL.
10. **PASS closes the case as resolved.** FAIL or PARTIAL triggers a replan, at most once more, otherwise the case escalates to a person.

Every step writes to the audit log and streams to the browser live over a socket.

## The screens

| Screen | Purpose |
|---|---|
| Overview | Numbers and charts: open exceptions, exceptions by type, validator outcomes, oldest cases |
| Payments | Search any payment and see it across the five systems |
| Exceptions | The queue of open cases |
| Case page | The state matrix, live investigation steps, findings with cited evidence, the resolution and its checks |
| Approvals | Risky proposals waiting for a second person |
| Agent runs | Each investigation with steps, tokens and cost |
| Audit log | Who or what did every action |
| Simulator | Creates payments with a chosen fault for demos (also reset and undo) |
| Policy | Shows the policy rules that decide AUTO, OPS, MANAGER, BLOCKED |

People can also propose and apply fixes by hand from the case page, so the product works with the AI turned off.

Roles: VIEWER reads; OPS investigates and resolves small things; MANAGER approves bigger ones; ADMIN does everything.

## Two examples to retell

**The missing message (fully automatic).** Gateway captured ₹12,499, but the webhook to the shop failed with HTTP 500 three times, so the order says FAILED and the ledger has no entry. The system detects it, reads the evidence, names the cause `WEBHOOK_PROCESSING_FAILURE`, proposes "replay the webhook event". That only fixes our own records and moves no money, so policy grants AUTO. It runs, the validator confirms all five systems now agree, and the case resolves.

**The refund nobody started (human decides).** An order was cancelled after ₹78,000 was captured and no refund exists anywhere. The system proposes "initiate refund of ₹78,000". Refunds over ₹10,000 need a manager, so the run pauses. A manager reviews and approves. The executor sends the refund once and the validator confirms it.

The difference between these two is the point of the product: the AI does the slow investigation, and people keep authority over money.
