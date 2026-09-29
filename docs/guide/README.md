# PayOps AI: the guide

A short reading path for anyone who wants to understand this repo end to end, in plain English. If you only have 20 minutes, read files 01, 03 and 07.

## The 60-second version

Companies that take online payments keep records of each payment in five separate systems. When one record goes wrong, the systems disagree and a person spends an hour working out why. PayOps AI notices the disagreement, investigates it with AI helpers, cites the evidence for its conclusion, proposes a fix from a short fixed menu, and lets a strict rulebook decide whether the fix can run automatically or needs a person to approve it. After the fix runs, a separate checker re-reads everything to confirm it worked.

The one idea behind the whole design: **AI proposes, code decides.** The AI reads evidence and names a likely cause. Everything that touches data or money (rules, math, permissions, execution, verification) is ordinary tested code.

## Reading order

| # | File | Read it to understand | Time |
|---|---|---|---|
| 01 | [Product and flow](01-product-and-flow.md) | What problem this solves, the five systems, the life of a case, who uses which screen | 8 min |
| 02 | [Architecture](02-architecture.md) | The packages, how a request travels through the system, where data lives | 8 min |
| 03 | [Agents and orchestration](03-agents-and-orchestration.md) | The heart: how many agents, what each does, how LangGraph wires them, fast path vs full path | 12 min |
| 04 | [Safety, policy and verification](04-safety-policy-verification.md) | Why the AI cannot do harm: the action menu, policy rules, approvals, executor, validator | 8 min |
| 05 | [Replay, evals and deployment](05-replay-evals-deploy.md) | How the demo runs without API keys, how quality is measured, how it deploys free | 6 min |
| 06 | [File map](06-file-map.md) | Which file is responsible for what, grouped, with the LangGraph and LangChain files marked | reference |
| 07 | [Interview prep](07-interview-prep.md) | Pitch scripts, likely questions with answers, honest limitations | 10 min |

## Vocabulary you will see everywhere

| Word | Meaning |
|---|---|
| Case | A record that says "these systems disagree about this payment" |
| State matrix | The table on a case page comparing gateway, order, ledger, webhook and settlement |
| Evidence | One fact fetched from a system, labelled `ev_01`, `ev_02`... |
| Finding | A claim the AI makes, which must cite evidence ids |
| Root cause | The single most likely reason for the disagreement, from a fixed list |
| Action | One safe operation from a fixed menu of nine, for example "replay webhook" |
| Policy tier | AUTO (runs by itself), OPS (a person approves), MANAGER (a manager approves), BLOCKED (not allowed) |
| Jev | A small fast decision model used for classification questions |
| Gemini | The larger model used for reasoning and writing findings |
| LangGraph | The library that runs the investigation as a graph of steps |
| Cassette | A saved recording of real model answers, replayed later with no network |

The older design documents (`docs/01` to `docs/06`, `DECISIONS.md`, `PROGRESS.md`) are the detailed, engineer-level record. This guide is the map to them.
