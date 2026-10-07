# PayOps AI product demo

[![Watch the PayOps AI demo](poster.jpg)](payops-demo.mp4?raw=true)

[Download the MP4](payops-demo.mp4?raw=true) · [Subtitles](payops-demo.srt) · [Transcript](transcript.md) · [Narration audio](narration.m4a) · [Editable storyboard](storyboard.json)

The video runs for about 3 minutes 4 seconds. It includes synthetic English narration, burned-in
captions and a separate SRT file. The app is recorded at 1600 × 900 inside a 1920 × 1080 presentation
frame. H.264 video and AAC audio support normal browser and phone playback.

## Story and purpose

| Chapter | What the viewer learns |
| --- | --- |
| Problem | A successful payment can disagree with an order and accounting records. |
| Overview | An operator starts from exceptions and operational metrics. |
| Payment case | A ₹1,25,000 captured payment has a failed order, missing ledger and failed webhook. |
| Investigation | The actual Start investigation action leads to a recorded case story. |
| Multi-agent design | A diagram explains the bounded architecture, followed by the run's actual routing and specialist steps. |
| Evidence | A finding opens the exact webhook evidence, its prior state and its current record. |
| Resolution | Code executes a permitted action; before/after rows and independent checks show the result. |
| Approval | A separate refund waits for a manager, who approves it before execution. |
| Audit | The operator can inspect actions and actors for the case. |
| Implementation | React, Node, Postgres and LangGraph support controlled automation. |
| Closing | The design lesson is inspectable decisions and independently verified outcomes. |

## What is real in the recording

The UI, API, database, agent graph, policy, approval, executor and validator run locally. The gateway
and customers are simulated. Gemini and Jev responses come from the project's REPLAY cassettes;
no provider calls are made for the recording. The introductory explanation, app mode indicator and
closing card disclose this. The architecture graphic is explicitly illustrative. The actual run
shows that the reconciliation specialist did not contribute relevant records in this case.

The payment case PAY-0005 and refund case RFD-0002 both reached RESOLVED in the isolated recording
database. The payment showed independent PASS checks; the refund continued only after the manager
approved. No production usage, time savings, performance benchmark or personal employment
experience is claimed. Narration uses Gemini speech generation with the prebuilt Charon voice, not a recording or clone of Shivam's voice. Only the public storyboard is sent for speech generation; the application recording itself stays in REPLAY mode. The original macOS voice was replaced after review.

## Put it on GitHub

The root README links to this version of the video. For GitHub's inline video player, drag
`payops-demo.mp4` into a GitHub issue or pull request editor, wait for the upload, copy its generated
`user-attachments` URL, and place that URL on its own line in the README. Keep the transcript and SRT
links for readers who prefer text or separate captions. No external upload is performed by these scripts.

## Reproduce or edit

The scripts under `scripts/demo/` use FFmpeg, Gemini speech generation, Chrome and an existing Playwright
installation. Speech generation uses `GEMINI_API_KEY` through the normal `env.ts` loader and makes billable provider calls. The optional `narrate.py` is an offline macOS draft voice only. They add no application dependencies. `PLAYWRIGHT_MODULE` may point to the existing
Playwright package directory if it is not resolvable from the repo. Generated intermediates and demo
session cookies stay in `/private/tmp/payops-video`, outside the repository.

1. Start a **new, isolated** PGlite instance on port 54339 using `scripts/local-db.ts --memory` and
   `LOCAL_DB_PORT=54339`. Seed it with the normal server seed script, using the local recording
   database URL and `DATABASE_POOL_MAX=1`. Never reset an existing user's database to record a video.
2. Start the API on 4017 with that database, `AI_MODE=REPLAY`, a temporary development JWT secret,
   `RECONCILE_SWEEP_MS=0` and `WEB_ORIGIN=http://localhost:5177`.
3. Start the Vite web app on 5177 with `/api` and `/socket.io` proxied to 4017. Use an empty
   `VITE_API_URL` and disable mock mode. The browser scripts expect this URL and the normal seeded ids.
4. Make `/private/tmp/payops-video`, then run these scripts from the repository root in order:

```bash
node scripts/demo/prepare.cjs
node scripts/demo/capture-primary.cjs
node scripts/demo/capture.cjs
node scripts/demo/capture-agents.cjs
node_modules/.bin/tsx scripts/demo/narrate-neural.ts /private/tmp/payops-video
python3 scripts/demo/assemble.py /private/tmp/payops-video
```

`capture-primary.cjs` starts the first investigation; `capture.cjs` starts the refund investigation
and approves it as the seeded manager. Run them only against the isolated seeded demo. Use a fresh
recording database for another full take. Change `storyboard.json` to edit the words, then rerun
narration and assembly against the saved clips. Subtitle timing is estimated from the duration of each generated chapter; it is not word-level forced alignment.

Speech generation follows the [official Gemini speech API](https://ai.google.dev/gemini-api/docs/speech-generation).
