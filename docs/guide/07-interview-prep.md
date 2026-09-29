# 07 · Interview prep

Use the words that feel natural to you. What matters is that you can explain each choice and open the file that proves it.

## Pitch scripts

**Ten seconds.** "PayOps AI finds payments where a company's systems disagree, investigates them with AI, and fixes them safely. The AI proposes, but code and a policy engine decide what may run, and a person approves anything that moves money."

**One minute.** Add: the five systems, an example (a failed webhook fixed automatically) and a second (a ₹78,000 refund that waits for a manager), then say it is checked afterwards by an independent validator and everything is audited.

**Three minutes.** Add the architecture: a LangGraph graph with three parallel specialists, two models with different jobs, fast path versus full path, pause and resume for approvals, and replay so the demo runs with no API keys.

## The design ideas to be able to defend

1. **AI proposes, code decides.** Models never touch the database, do math, approve or execute. Amounts are integers computed by code.
2. **A fixed action menu.** The AI chooses from nine typed actions, so it cannot invent something dangerous.
3. **Evidence or it does not count.** Findings must cite evidence ids and pass fact tests.
4. **Independent verification.** The validator re-reads the data instead of trusting the executor.
5. **Two models for two jobs.** A small fast model (Jev) for classification, a larger one (Gemini) for reasoning, each with a coded fallback.
6. **Fast path saves cost.** Clear known faults skip the specialists and Gemini entirely.
7. **Durable pause.** Approvals can take days, so state is checkpointed in Postgres and the run resumes later.
8. **Replay makes the demo free and repeatable.**

## Likely questions, with short answers

**Why LangGraph instead of a loop of function calls?** The flow has branches, a parallel fan-out, loops (replan, extra evidence round), and a human pause. LangGraph gives state, conditional edges, parallel `Send`, and durable `interrupt`/resume with a Postgres checkpointer. Writing that by hand would be the same amount of code with fewer guarantees.

**Where do you use LangChain?** Only as the Gemini client (`ChatGoogleGenerativeAI` with structured output). No LangChain agents or chains. LangGraph is the orchestrator.

**How many agents are there?** Three specialist agents (payment, reconciliation, risk) run in parallel inside one graph of 19 nodes. Six of those decisions use Jev, and one step (`resolve`) uses Gemini for a diagnosis on the full path.

**How do you stop hallucinations?** Structured output checked by Zod, findings that must cite evidence and pass a fact test, a fixed root-cause list, a fixed action menu, and a validator that checks the real result afterwards.

**What if the model is wrong?** A wrong diagnosis gives a wrong proposal, but policy still gates it, risky actions need a human, and the validator catches a fix that did not work. Then `replan` tries once more or escalates. Grounding checks support, not truth, and I say so.

**How do you prevent a double refund?** Idempotency keys per step, so re-running finds the stored result. Plus four-eyes approval and precondition checks against live data.

**What happens when a run needs approval?** The graph calls `interrupt`, the checkpointer saves state to Postgres, the job ends. On approval a resume job calls the graph with the decision and it continues.

**How do you handle prompt injection?** Screening (J1), untrusted-text tags, and structure: even a fooled model cannot invent an action, and refunds still need policy and approval. There is a test scenario for it.

**How did you evaluate it?** Golden scenarios with expected root cause, actions and policy tier: 7 of 7 passed live, about $0.0017 total. One scenario named a neighbouring cause and is documented, not hidden.

**Why is the demo free?** REPLAY mode serves recorded answers. Real calls happen only when I record or run live locally.

**What would you build next?** A real gateway adapter (Razorpay test mode), a nightly reset, persistent login rate limiting, more golden scenarios (7 cover most but not all 8 faults), cross-case pattern memory, and a stricter cost cap.

## Numbers you can quote

- 8 fault scenarios plus a healthy control; 16 recorded runs
- 9 actions, 12 policy rules (P0 to P11), 6 Jev decision points, 3 specialists, 15 read-only tools, 19 graph nodes
- Limits: 60 tool calls, $0.05, 2 attempts, 2 investigation rounds per run
- Eval: 7 of 7 golden scenarios, 100% root-cause, action and tier match, $0.0017 total
- About 460 automated tests

## Honest limitations (say them before you are asked)

- Data is simulated; there is no real payment gateway yet.
- Replay only works for recorded scenarios and seeds. Other cases escalate by design.
- The free host sleeps, so the first load is slow.
- Login rate limiting is in memory, which is fine for one process only.
- Grounding proves a claim is supported by its evidence, not that it is the only possible cause.

## Before the interview

Run the app locally in `AI_MODE=REPLAY` and click through both examples, including the manager approval. Open `graph.ts` and trace a case from `loadCase` to `closeResolved` with your finger. Be ready to say which parts you built, which you directed, and what you would change.
