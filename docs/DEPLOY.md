# Free deployment (replay demo)

Three free services, no AI keys. The hosted demo runs `AI_MODE=REPLAY`, so it replays the recorded
Gemini and Jev responses in `fixtures/cassettes/` and never calls a provider. Nobody can spend your tokens.

| Piece | Service | Why |
|---|---|---|
| Database | Supabase (free) | Postgres for business data, the job queue and LangGraph checkpoints |
| API | Render (free web service) | The API is one long-lived Node process (Socket.IO, pg-boss jobs, agent runs). Vercel functions are short-lived, so they cannot host it |
| Web | Vercel (free) | Static build. `vercel.json` proxies `/api` and `/socket.io` to Render, so the browser sees one origin and the session cookie works |

## Steps

1. **Supabase.** Create a project. Copy the **Session pooler** connection string (port 5432, not 6543) from Project Settings > Database. Session mode is required for pg-boss.
2. **Render.** New > Blueprint > pick this repo (it reads `render.yaml`). Set `DATABASE_URL` to the Supabase string. Leave `WEB_ORIGIN` for step 4. First boot migrates and seeds the database.
3. **Vercel.** Import the repo (root directory: repo root; it reads `vercel.json`). Before deploying, replace both `YOUR-API-NAME.onrender.com` values in `vercel.json` with your Render URL.
4. Set `WEB_ORIGIN` on Render to the Vercel URL and redeploy the API.

Free Render services sleep after 15 minutes idle; the first request then takes about 50 seconds. A free uptime monitor that pings `/api/health` every 10 minutes avoids that.

**Bandwidth.** Render's free plan includes 5 GB of outbound traffic a month for the whole workspace, and the API's database round trips count as "service-initiated" traffic. An always-awake API that sweeps every minute and polls four job queues every 2 seconds used 5.45 GB in about two weeks and the workspace was suspended (D083). `render.yaml` therefore sets `RECONCILE_SWEEP_MS=0` and `JOB_POLL_SECONDS` (10 on Node, 30 on Python). Check Render, Billing, Included Usage after a few days. A queued job (such as Start investigation) can now wait up to 10 seconds to begin; set `JOB_POLL_SECONDS` lower if that feels slow.

## What visitors can do

- Sign in with a demo account (password `payops-demo`), open a pre-loaded case, and start an investigation. Every pre-loaded case uses a recorded seed, so it resolves from replay.
- Simulator page: each scenario lists its **recorded seeds**. Other seeds still create the case, but the investigation escalates because there is no recording for it (by design).
- **Reset demo data** wipes the shared data and generates the demo cases again with fresh dates (the same set `pnpm seed` creates). The cases appear one by one over about 3 minutes on the hosted database, and reset and undo are blocked until they finish; **Undo last reset** restores what was there. There is one level of undo, a 10 second cooldown between resets, and a lock so two resets cannot overlap.

## Recording more scenarios (on your Mac, with real keys)

`fixtures/cassettes/manifest.json` lists every recorded scenario and seed.

```
pnpm cassette:record                       # records only the pairs missing from the manifest
pnpm cassette:record --only suspicious_payment
pnpm cassette:record --all                 # re-record everything from scratch
```

This makes real, billed calls to Gemini and Jev (the whole suite is a fraction of a cent to a few cents). Runs that pause for approval are approved automatically as a manager during recording. Commit `fixtures/cassettes/` afterwards.

## Switching a deployment to live AI

On Render set `AI_MODE=LIVE`, `GEMINI_API_KEY` and `TYPESAFE_JEV_API_KEY`, then redeploy. Do this only for a private or short-lived demo: anyone with the link could then trigger billed calls. For interviews, run locally with `AI_MODE=LIVE` and keep the hosted copy on REPLAY.

## Python backend (B6, replaces the Node API)

`render.yaml` now describes one Python service, `payops-backend` (API, job worker, Socket.IO and the agents in one process). The Node API lives only in git history now (tag `ts-backend-final`).

1. Reset the Supabase database password to letters and digits only (a `@` or `/` breaks the URL), then copy the **Session pooler** string (port 5432).
2. Render: New > Blueprint > this repo > `render.yaml`. Set `DATABASE_URL` and `WEB_ORIGIN` (the Vercel URL). First boot runs the migrations and creates the demo users.
3. Open `<service-url>/api/health`; `database` and `agents` should both be ok.
4. In `vercel.json` change the three `payops-api-xatz.onrender.com` hosts to the new service host, push, and let Vercel redeploy.
5. Suspend the old `payops-api` service (do not delete it until B7) and keep UptimeRobot paused until the bandwidth looks fine.
6. After 3 to 4 days check Render, Billing, Included Usage. The target is under about 6.7 MB per awake hour.

Rollback: Render, Events, redeploy the previous deploy. The old Node service can only be revived from the tag `ts-backend-final`.
