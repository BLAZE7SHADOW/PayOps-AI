# PayOps AI demo transcript

Female neural narration. Simulated payment data; model responses replayed.

## 0:00 · One payment. Three different stories.

Payment successful. The customer sees a confirmation. But inside the business, the order says failed. The accounts show no money. And the payment processor says it was captured. Someone has to trace the missing message, compare the records, and decide what can safely be fixed.

## 0:19 · Meet PayOps AI

That is where PayOps AI comes in. It brings the investigation, the evidence, and the verified outcome into one workspace. Specialists help find the cause. Policy controls the action. Every conclusion can be checked.

## 0:35 · Let’s follow a real example

Let's see an example in the running application. These are simulated payments, using recorded model responses. The gateway captured one lakh twenty five thousand rupees. But the order is failed, the ledger is missing, and the webhook failed three times. The disagreement is visible immediately.

## 0:55 · One click starts the investigation

Start investigation begins the workflow. Code collects the minimum records first. The case then builds a readable story: what was checked, what was found, and why the next step was chosen.

## 1:09 · Selected specialists. Shared evidence.

A coordinator selects the specialists this case needs. Payment examines the gateway and order. Reconciliation looks at accounting and settlement. Risk reviews suspicious signals. This run shows which specialists were chosen, what they actually did, and the reasons behind their decisions. The workflow stays bounded.

## 1:31 · Open the proof behind the finding

Here is the proof. The payment specialist links its finding to this exact webhook record. Open it, and the original evidence shows three attempts, a failed delivery, and HTTP five hundred. The drawer also shows the current state. The explanation and the underlying record are visible together.

## 1:52 · Watch the records change. Check the result.

The proposed fix is to replay the failed message. Policy permits this state correction automatically. The executor applies it through code. The order becomes paid, the payment is captured internally, and accounting entries appear. Then an independent validator reads the records again. The checks pass, the systems agree, and the case closes.

## 2:17 · Money movement waits for approval

A refund follows a different path. The proposal pauses for manager approval, with its amount and reason available for review. An authorized second person approves it. Execution continues only after that decision, and the result is verified again.

## 2:35 · Trace the action back to its decision

The audit trail records who acted and what changed. The run details connect those actions to the investigation. An operator can trace the decision and check the outcome, from the same case.

## 2:49 · Reasoning, authority, and verification

LangGraph coordinates the agents. Jev supplies typed decisions, and Gemini handles deeper investigation. Models propose from a fixed action catalog. Code enforces policy, approval, and idempotent execution. Evidence checks and independent verification keep the result inspectable.

## 3:10 · From disagreement to a verified result

Find the cause. Open the proof. Apply a permitted fix. Verify what changed. That is PayOps AI. Explore the demo and the repository to follow the complete workflow.
