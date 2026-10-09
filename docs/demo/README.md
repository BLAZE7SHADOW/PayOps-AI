# PayOps AI product demo

[![Watch the product walkthrough](poster.jpg)](payops-demo.mp4?raw=true)

[MP4 video](payops-demo.mp4?raw=true) · [Subtitles](payops-demo.srt) · [Transcript](transcript.md) · [Narration audio](narration.m4a) · [Voice preview](voice-preview.m4a) · [Storyboard](storyboard.json)

The walkthrough opens with a payment that succeeded while the order and accounting records disagree.
It introduces PayOps AI, follows one case through investigation and proof, then demonstrates automatic
resolution, independent verification, and the approval boundary for a refund. The closing explains
how reasoning, authority and verification work together.

The video uses a female neural narrator with deliberate pauses and conversational delivery. It
contains no creator credits or personal names in the narration, captions, title cards, or transcript.
The recording presents demo identities as role labels. The actual business data, findings, actions,
approval requirements and validator outcomes are preserved.

## What the viewer sees

1. A successful payment with three conflicting records.
2. The product reveal and the operations overview.
3. A ₹1,25,000 example with a failed order, missing ledger and three failed webhook attempts.
4. The actual Start investigation action and selected specialist steps.
5. A finding opened beside its exact webhook evidence, including original and current state.
6. Before-and-after record changes and independent PASS checks.
7. A separate refund approved by an authorized manager before execution.
8. The audit trail, architecture and closing product message.

The video includes English narration, burned-in subtitles, a separate SRT, a transcript, and
chapter markers. H.264 video and AAC audio support ordinary browser and phone playback. The
application is recorded at 1600 × 900 inside a 1920 × 1080 presentation frame.

## Recording facts

The app, API, database, graph, policy, approval, executor and validator run locally against a separate
in-memory database. Customers and payments are simulated. Model responses used by the investigation
are replayed from the project's cassettes; mode labels and narration disclose this. Architecture
cards are explicitly illustrative. The selected specialists and their actual contributions are
visible in the run view.

The main payment case reaches RESOLVED with independent PASS checks. The refund waits for manager
approval and reaches RESOLVED only after that approval. No production usage or performance claims
are presented.

Female narration is generated through Gemini speech using a prebuilt voice, with the public
storyboard as input. This narration generation makes provider calls; the application recording uses
REPLAY. Credentials are accessed only through the normal `env.ts` loader. No voice cloning is used.

## Share on GitHub

The root README links to the current local MP4. To use GitHub's inline player, drag the MP4 into
an issue or pull request editor, wait for its upload, and copy the generated attachment URL into
the README. Alternatively, upload the video to your chosen video host and replace the poster link.
The earlier hosted video is a separate version; a new local render does not replace that upload.

## Reproduce or edit

The production scripts require FFmpeg, Chrome, an existing Playwright installation, and the existing
Gemini credential configured through the app's environment loader. No application dependencies are
added. `PLAYWRIGHT_MODULE` can point to an existing Playwright package directory.

Use a fresh, isolated PGlite database on 54349, a separate REPLAY API on 4027, and a Vite preview on
5187 with `/api` and `/socket.io` proxied to that API. Disable reconciliation sweeps, use one database
connection, and seed the standard demo world. Do not reset an active user's database to record a video.
Temporary recording files and session cookies stay outside the repository.

```bash
DEMO_WORK=/private/tmp/payops-video-v2 DEMO_URL=http://localhost:5187 node scripts/demo/capture.cjs
DEMO_VOICE=Kore node_modules/.bin/tsx scripts/demo/narrate-neural.ts /private/tmp/payops-video-v2
python3 scripts/demo/assemble.py /private/tmp/payops-video-v2
```

Capture performs real simulated investigations and manager approval. It refuses to start if the two
required seeded cases are no longer OPEN. A new full take needs a fresh isolated database. To edit
only the words, update `storyboard.json`, regenerate the narration, and assemble it against the saved
clips. Cached speech is keyed by voice, delivery instructions and text so changed scripts do not
reuse old narration. Subtitle timing is estimated within the generated audio; it is not word-level
forced alignment.

Speech generation follows the [official Gemini speech API](https://ai.google.dev/gemini-api/docs/speech-generation).
