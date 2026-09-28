# Phase 3 handoff

Phase 3 is complete. Start Phase 4 only in a new session, after reading `CLAUDE.md`, `docs/PROGRESS.md`, and the Phase 4 section of `docs/06-phases.md` plus the relevant parts of `docs/03-agent-system.md`.

## What Phase 3 now includes

- Case investigation UI: live run trace, findings and proposed resolution with evidence references, evidence facts, attempt and budget header, start control, and reconnect restoration from persisted run steps.
- Fast-path evidence is collected before diagnosis. Fast diagnoses require a consistent and citable cause, emit a typed finding with real evidence IDs, and put finding IDs in `supportingFindingIds`.
- RECORD/REPLAY prompts drop volatile display/entity IDs and observation times while keeping status, money and other semantic facts. LLM response schemas validate both LIVE and REPLAY outputs.
- `PostgresSaver` uses the app's Postgres pool. Its setup cache is scoped to the database.
- Jev uses pinned model `jev-1.13.0`. The env parser still accepts the old `jev-1.13` spelling and maps it to the valid version ID; `.env` remains private and untouched.
- Overview counts resolved cases attributed to agent runs.
- Server tsup configuration is in `apps/server/tsup.config.ts`; the unsupported CLI flags are removed.
- Three real-provider cassettes are committed in `fixtures/cassettes/`. `fixtures/cassettes/README.md` documents the scenario seeds and expected outcomes.

## Verification completed

- `corepack pnpm typecheck`, `corepack pnpm lint`, `corepack pnpm test`, and `corepack pnpm build` all pass. Use a PATH that includes `pnpm` if running recursive workspace scripts; this machine has Corepack but no standalone `pnpm` on PATH.
- The full suite has 261 passing tests, including 4 checkpointed graph tests, 3 fresh-data REPLAY tests with provider fetches blocked, and 2 prompt stability tests.
- Real LIVE browser test: captured payment reached AUTO/PASS; large refund reached MANAGER, browser closed, API restarted, manager approved, and it reached PASS without rerunning triage. Browser also observed API disconnect/reconnect, four step-recovery reads, live trace updates, keyboard evidence navigation, and zero page errors.
- Browser screenshots and machine-readable report are in ignored `.data/phase3-browser/` (`1-pending.png`, `2-resumed.png`, `3-auto.png`, `report.json`). They are local verification artifacts, not source fixtures.
- A PGlite instance on port 54329 was started only for local verification and shut down. The API server was shut down after the browser pass. Do not expect localhost:4000 or :54329 to still be running.
- TypeSafe initially rejected `jev-1.13` with HTTP 400. This was diagnosed without exposing credentials and resolved by pinning the actual accepted version. The LIVE test confirmed Jev and Gemini recording work.

## Recorded provider outcome

The three cassette scenarios all replay to the verified intended action path, with no provider network calls. The refund-stuck response's diagnosis names `WEBHOOK_NOT_DELIVERED` while proposing the correct `SYNC_REFUND_STATUS` action; it passes citation and action validation. Semantic causal grounding, risk specialist assessment, and rejected-finding handling remain Phase 4 work.

## Next

Phase 4 is not implemented. Begin the documented Jev intake/decision work, specialist planning and parallel fan-out, context budgets and masking, risk and grounding paths, findings/evidence persistence, UI decision/grounding visibility, and scenario recordings. Preserve Phase 3 cassettes unless an intentional prompt/schema change requires re-recording.
