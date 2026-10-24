# EZTask — POS sync service

Sends paid checks (orders) to a restaurant's third-party POS and cancels them when the check is cancelled. Runs as several identical API instances; any can be killed at any time. The POS is slow, flaky, not idempotent and rate-limited.

Design lives in `docs/` — read `docs/architecture.md` and `docs/sync-state-machine.md` before touching sync code. Requirements: `docs/Backend-Take-Home-Task.pdf`.

## Layout
- `apps/api` — NestJS API + sync workers (Drizzle schema in `apps/api/src/db/schema.ts`)
- `apps/fake-pos` — NestJS fake POS used by tests and compose
- `test/chaos` — chaos test (2 API instances, all failure modes, kill + restart)

## Commands
```
yarn install
docker compose up            # postgres, migrate, api-1, api-2, fake-pos
yarn typecheck
yarn lint
yarn test                    # unit + real-Postgres integration tests
yarn test:chaos              # takes minutes (rate limit), needs compose running
yarn db:generate             # after editing schema.ts
```

## Hard rules
1. **Never call the POS from an HTTP request path.** Endpoints only write to Postgres; workers talk to the POS.
2. **`/pay` writes `checks.status = 'paid'` and the `pos_sync` row in one transaction.** Same for `/cancel`. No separate step that could be lost.
3. **Commit `pos_state = 'unknown'` before sending a create.** After `unknown`, the next POS call is always `GET /orders?externalRef=`, never a create.
4. **Workers never write `desired`.** Only `/pay` and `/cancel` do. Workers update explicit columns, never the whole row, and every worker write has `WHERE lease_owner = :me`.
5. **Every POS call takes a rate-limit token first** — create, lookup and cancel alike.
6. **Time comes from Postgres `now()`**, not `Date.now()`, for leases, `next_attempt_at` and rate-limit windows.
7. **Never sleep in a worker** waiting for rate budget. Reschedule the row and move on.
8. **422 → `failed`, no auto-retry. 429 → reschedule, not counted as an attempt.** Timeout/connection error → `unknown`. Temporary errors retry forever (backoff capped at 60 s) — never add a max-attempts cutoff.
9. **HTTP timeout (10 s) must stay below the lease (30 s).** Both live in one config file; change them together.
10. **Schema changes:** edit `schema.ts`, run `yarn db:generate`, commit both. Never hand-edit or rewrite a committed migration.
11. **Sync, lease and rate-limit tests run against real Postgres.** Do not mock the database for them.
12. **Strict TypeScript:** no `any`, no `@ts-ignore`, no non-null `!` to silence errors.
13. **Do not "fix" the fake POS.** It is non-idempotent and fails on purpose, as the spec says.

## When you change the design
Update the matching file in `docs/` and add a short entry to `docs/discussion.md` saying what changed and why.
