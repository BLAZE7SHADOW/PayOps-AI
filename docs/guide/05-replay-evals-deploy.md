# 05 · Replay, evals and deployment

## Why replay exists

AI calls cost money and vary between runs. For a public demo you want them free and repeatable, and you do not want strangers spending your API credits. So every model answer can be recorded once and replayed forever.

## The three AI modes

| `AI_MODE` | Behaviour | Needs keys |
|---|---|---|
| `LIVE` | Calls Gemini and Jev for real | yes |
| `RECORD` | Calls them for real and appends each answer to `fixtures/cassettes/<scenario>.jsonl` | yes |
| `REPLAY` | Serves saved answers by lookup. No network. This is the demo default | no |

Only model answers are recorded. The graph, tools, database, policy, executor and validator always run for real against the current data.

## How a replay lookup works

Each recorded call is stored with a key made from the node or tag, the call number and a hash of the prompt (`packages/core/src/adapters/cassette.ts`). Timestamps and display ids are left out of the hash so they do not matter.

One wrinkle: the three specialists run in parallel, so the "evidence so far" inside a prompt can differ from run to run. An exact-hash miss would then escalate a case that was recorded fine. So the reader has a fallback (decision D054): if a call misses but the run has already matched a recording in the same file, it uses the closest unused recording for the same step. With no earlier match it still misses, so a case that was never recorded escalates instead of borrowing another case's answers.

`fixtures/cassettes/manifest.json` lists what is recorded: all 8 fault scenarios with 2 seeds each. In REPLAY, generate a scenario using a recorded seed in the Simulator; other seeds create the case but the investigation escalates by design.

Record more with `pnpm cassette:record` (real keys, a few cents); see `docs/DEPLOY.md`.

## Evals

`packages/evals` runs golden scenarios and scores them. The live report `docs/evals/2026-09-28.md` shows 7 of 7 scenarios passing, 100% root-cause, action and policy-tier match, at a total model cost of about $0.0017. Run with `pnpm eval` (from cassettes) or `pnpm eval:live`. One scenario, `refund_stuck`, got the right fix but named a neighbouring cause; it is excluded from the accuracy metric and documented.

## Demo data controls

The Simulator page creates faulted payments. **Reset demo data** wipes and re-seeds; before wiping it saves a snapshot in a `demo_undo` schema, and **Undo last reset** restores it. There is a 10-second cooldown and a lock so two visitors cannot collide.

## Free deployment

| Piece | Service | Why |
|---|---|---|
| Web | Vercel | Static build; `vercel.json` proxies `/api` and `/socket.io` to the API so the browser sees one origin |
| API | Render free web service | The API is one long-lived Node process (sockets, jobs, agent runs). Serverless functions cannot host it |
| Database | Supabase free | Postgres (use the session pooler on port 5432) |

Render's free tier sleeps after 15 minutes idle, so the first visit takes 20 to 50 seconds. The web app shows a "waking up the server" notice with a timer. Steps are in `docs/DEPLOY.md`. To run live AI, set `AI_MODE=LIVE` and the two keys, ideally locally for interviews.
