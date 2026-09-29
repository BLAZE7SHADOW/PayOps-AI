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

## What visitors can do

- Sign in with a demo account (password `payops-demo`), open a pre-loaded case, and start an investigation. Every pre-loaded case uses a recorded seed, so it resolves from replay.
- Simulator page: each scenario lists its **recorded seeds**. Other seeds still create the case, but the investigation escalates because there is no recording for it (by design).
- **Reset demo data** wipes and re-seeds the shared data; **Undo last reset** restores what was there. There is one level of undo, a 10 second cooldown between resets, and a lock so two resets cannot overlap.

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
