# PayOps AI demo transcript

Synthetic English narration. Simulated payment data; model responses replayed.

## 0:00 · When payment systems disagree

A customer has paid, but the order still says failed. Which record should the operations team trust? PayOps AI, built by Shivam Govind Rao, investigates these disagreements and makes the evidence, decisions, and outcome visible.

## 0:14 · One workspace for payment operations

The overview brings together open exceptions and operational metrics. From here, an analyst can find a case and follow it through resolution. This walkthrough uses simulated payments and replayed AI responses. The application, policy checks, database changes, and verification are running.

## 0:32 · The problem: money received, records out of sync

Here, the gateway captured one lakh twenty five thousand rupees. But the order says failed, the ledger entry is missing, and the webhook failed three times. The comparison makes the disagreement visible before any investigation starts.

## 0:47 · Start an investigation

The analyst starts an investigation. Code collects the initial records, and the agent workflow decides which specialists should investigate. The case story identifies whether each step came from fixed code, Jev, Gemini, or a person.

## 1:02 · How the agents work together

LangGraph coordinates a bounded workflow. Payment, reconciliation, and risk specialists examine their selected areas using read only tools. Jev supplies typed decisions, while Gemini handles the deeper investigation. Findings cite evidence, and grounding checks run before a resolution can be proposed.

## 1:20 · Follow a finding to its evidence

An explanation needs proof. The analyst can open the records behind a finding and inspect the payment, webhook, or accounting entry. This connects the agent's conclusion to the exact case, instead of asking the user to trust a summary alone.

## 1:34 · Execute through policy. Verify from records.

The model proposes an action from a fixed catalog. Policy code decides whether it can run automatically or needs approval. After execution, an independent validator reads the records again. The case shows what changed and whether the expected result was achieved.

## 1:50 · People retain authority over risky actions

A refund needs a different path. The proposal pauses for the required approval, with the amount and reason available for review. An authorized second person approves it. Only then can deterministic code execute the action and verify the result.

## 2:05 · A history an operator can inspect

The audit trail records actions and actors, while run details expose the investigation steps and model usage. These views help an operator trace how a decision became a change to the payment records.

## 2:18 · The engineering behind the demo

The project combines a React and TypeScript workbench, a Node API, Postgres, and durable agent workflows. The engineering focus is controlled automation: idempotent actions, approval boundaries, bounded retries, evidence checks, and recorded responses for repeatable demonstrations.

## 2:37 · PayOps AI · Shivam Govind Rao

The central design lesson is simple: an agent's answer becomes useful when a person can inspect the evidence and verify the outcome. Explore the repository for the architecture, evaluation reports, and instructions to run PayOps AI yourself.
