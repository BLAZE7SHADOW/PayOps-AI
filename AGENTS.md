# AGENTS.md

> **pnpm on this machine.** Plain `pnpm` does not work here. Run every `pnpm ...` command in this file as `npx pnpm@10.28.0 ...` (for example `npx pnpm@10.28.0 db:migrate`). To keep typing `pnpm`, add `alias pnpm='npx pnpm@10.28.0'` to `~/.zshrc` and open a new terminal. In Claude's cloud shell `pnpm` is also missing: call `node_modules/.bin/vitest` and `node_modules/.bin/tsc` directly.

This repository's instructions for coding agents live in [`CLAUDE.md`](./CLAUDE.md). Read it fully before doing anything, then read `docs/PROGRESS.md`.

The same rules apply to every coding agent (Claude Code, Codex, Cursor, Copilot, Gemini CLI): stay in the current phase, never read or print `.env` values, models never touch the database or authorize actions, follow `docs/05-ui-design.md` for all UI, and update `docs/PROGRESS.md` at the end of each session.
