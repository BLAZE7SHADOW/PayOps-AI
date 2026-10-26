# How to change things

Short checklists for the four most common changes. Paths are from the repo root. The reasons behind the structure are in
[02-architecture.md](02-architecture.md); this file is only the "what do I touch" list.

Run before you push: `pnpm py:test` (ruff, format check, pyright, pytest for both Python projects), `pnpm eval`,
`pnpm typecheck && pnpm lint && pnpm test` (web).

## Add an API endpoint

1. **Shapes.** Add the request and response models in `python/payops/src/payops/dto/` (Pydantic `CamelModel`: snake_case in Python, camelCase on the wire).
2. **Service.** Put the logic in a service under `src/payops/services/` (reads) or `services/writes/` (anything that changes data). Services take an `AsyncSession`. A write runs inside one transaction and appends its `audit_events` row in the same transaction (`AuditService.record`).
3. **Wire it.** If it is a new service, build it in `src/payops/container.py` (`build_services`). Routes reach it through `ServicesDep`.
4. **Route.** Add a three-line handler in `src/payops/api/routes/{read,write,ops,auth,simulator}.py`. Every route names a permission with `Depends(require_permission("..."))` (or `public_route()`); a test fails if one has neither.
5. **Permission.** If it is new, add it once to `src/payops/domain/permissions.py`, then update the table between the `permissions:start` and `permissions:end` markers in `docs/02-architecture.md` (a test compares the two), and add it to `packages/shared/src/permissions.ts` for the web.
6. **Tests.** Add API tests next to `tests/test_write_api.py` (writes) or `tests/test_contract.py` (reads against recorded responses).
7. **Web.** Add the response type to `packages/shared/src/dto/`, a hook in `apps/web/src/features/<feature>/api.ts` that calls `api<T>()` from `lib/api.ts`, and a key in `lib/query-keys.ts`. Lists use `useCursorList`.

## Add or change an action (the closed catalog)

An action is something the executor may do. Models never add one at run time. Touch, in order:

1. `python/payops/src/payops/dto/actions.py`: the type name in `ACTION_TYPES` and its validated parameters (also `packages/shared/src/actions.ts` for the web).
2. `src/payops/domain/actions/handlers.py`: its preconditions and postconditions (pure functions, registered in `PRECONDITIONS` and `POSTCONDITIONS`), and `options.py` for the manual-resolution recommendation.
3. `src/payops/services/writes/action_runtime.py`: the executor (register it in `_EXECUTORS`). It must be idempotent: the idempotency key comes from `domain/actions/idempotency.py`.
4. `src/payops/domain/policy/rules.py`: which tier it needs. If a rule is new, also `dto/policy.py` (`POLICY_RULES`) and `docs/03-agent-system.md`.
5. Tests: `tests/test_actions.py`, `tests/test_policy.py`, `tests/test_execution.py`.
6. If the agent may propose it, update the template in `src/payops/agent_tools/proposal.py`. Do not change prompt or Jev question text without a re-recording (`pnpm cassette:record`, billed).

## Add a web page

1. Create `apps/web/src/features/<feature>/` with `<Feature>Page.tsx` and `api.ts`.
2. Register the route in `apps/web/src/app/router.tsx` (lazy import) and the link in `app/Nav.tsx`.
3. Loading uses a skeleton from `ui/Skeleton`; a failed load uses `<QueryError title="..." query={q} />` from `ui/ErrorState`; an empty list uses `ui/EmptyState`. Colours and spacing come only from the tokens in `styles/` (rules in `docs/05-ui-design.md`).
4. Gate mutation controls with `can(role, '<capability>')` from `lib/permissions.ts`.
5. Test the pure parts (formatting, derived state) with Vitest next to the file.

## Change the database

1. Write a revision by hand: `cd python/payops && uv run alembic revision -m "what it does"`, then fill in `upgrade()` and `downgrade()` in `migrations/versions/`. (There is no autogenerate: the models are generated from the migrated database, and `tests/test_models.py` fails when a model and a table disagree.)
2. Update `src/payops/db/models.py` to match.
3. Apply it with `uv run python -m payops.db.migrate` (the API also applies migrations when it starts, `MIGRATE_ON_START`).
4. `tests/test_migrations.py` counts tables and the head revision; update it.
5. Anything that changes audit rows must keep the hash input byte-identical (`domain/audit.py`), or the hosted database's existing chain stops verifying.
