# Risk register

Status: **Proposed** — what can go wrong, how we handle it, and what is left. Feeds the "what risk is left" part of `DECISIONS.md`.

Columns: **G** = guarantee affected (1–5, see [architecture.md](architecture.md#how-each-guarantee-is-met)). **Residual** = what remains after mitigation.

## A. Correctness risks (duplicates, lost orders, wrong order of events)

| # | Risk | G | Mitigation | Residual | Covered by |
|---|---|---|---|---|---|
| A1 | POS creates the order, response times out, we create again → duplicate | 2 | Commit `pos_state = unknown` **before** sending; next step after unknown is always a lookup by `externalRef` | Real POS with late lookup indexing could still duplicate (see A2) | Chaos test (`TIMEOUT_AFTER_CREATE_RATE`) |
| A2 | Real POS shows new orders in lookups only after a delay | 2 | Delay before lookup; post-create lookup that cancels extras | Not testable with our fake POS (it is immediately consistent). Accepted, documented | — |
| A3 | Worker lease expires while its HTTP call is still in flight → second worker acts on same check | 2 | Lease (30 s) > HTTP timeout (10 s) + margin; result written only `WHERE lease_owner = me` | Process paused longer than the lease (GC/VM freeze) | Unit test on lease-guarded update |
| A4 | Instance killed between `paid` commit and enqueue → order lost | 2 | Same transaction writes `checks` and `pos_sync` (outbox) | None | Real-Postgres test + chaos kill |
| A5 | Cancel arrives while a worker is mid-create on the same row; worker's write overwrites the new `desired` | 3 | Worker updates only `pos_state` / `status` / `pos_order_id`, never `desired`; after its step it re-evaluates, so the row stays due if `desired` changed | None if the column rule holds — enforce in code review / CLAUDE.md rule | Real-Postgres test: cancel during in-flight create |
| A6 | Cancel sent to POS before create | 3 | One row per check, one owner at a time; cancel is a `desired` flip, not a separate job | None | Chaos test (cancelled → no open order) |
| A7 | Concurrent `/pay` + `/cancel` (or double `/pay`) on one check | 2,3 | Row lock on the check (`SELECT … FOR UPDATE`) and explicit allowed transitions; repeated `/pay` is a no-op | None | Real-Postgres test |
| A8 | Cancel request times out — did the POS cancel? | 3 | Cancel is safe to repeat; fake POS returns 200 on an already-cancelled order | Real POS may reject a repeat cancel; we'd treat "already cancelled" as success | Unit test |
| A9 | Manual `/sync/retry` clicked twice, or on a running sync | 2 | Retry only resets a `failed` row (409 otherwise); next step still goes through the state machine (lookup if unknown) | None | Real-Postgres test |

## B. Rate-limit and fairness risks

| # | Risk | G | Mitigation | Residual |
|---|---|---|---|---|
| B1 | Each instance counts alone → 5 × N requests | 4 | Shared limiter in Postgres, per-restaurant row lock | None |
| B2 | Requests bunch up in the network → POS counts 6 in its window | 4 | Our limit is 4 / 10 s; 429 → reschedule, not a failure | Rare 429s still possible, handled |
| B3 | Unknown outcomes double the cost (create + lookup), a struggling restaurant eats its budget on lookups | 4 | Lookups only after unknown, never routinely | Slower recovery for that restaurant only; others unaffected |
| B4 | Worker sleeps waiting for one restaurant's budget → others starve | 4 | Never sleep: reschedule the row and move on | None |
| B5 | Clock drift between instances breaks windows | 4 | All timestamps from Postgres `now()` | None |

## C. Operational risks

| # | Risk | Mitigation | Residual |
|---|---|---|---|
| C1 | Both API instances run migrations at startup at the same time | Run migrations in a one-shot `migrate` container that the APIs depend on | None |
| C2 | Postgres is a single point of failure | Out of scope for this task; at scale: managed Postgres with failover | Accepted |
| C3 | Polling load on Postgres grows with volume | Index on `(next_attempt_at)` for due rows; batch claims | Ceiling at ~100×, see `DECISIONS.md` |
| C4 | `pos_request_log` / `pos_sync` grow forever | Periodic prune of log rows older than the window; archive finished sync rows | None at this scale |
| C5 | Repeated 500s for one check retry forever (poison row) | Backoff capped at 60 s; attempts + last error visible in `GET /sync`; alert above 10 attempts in production. Not stopped: stopping would break guarantee 2 | A long outage keeps retrying, by design |
| C6 | Chaos test flaky because "settled" is guessed with a fixed sleep | Poll until every sync row is `synced` or `failed`, with a hard timeout | Long runs with high failure rates; tune rates/timeout |
| C7 | Chaos test is slow: rate limit caps throughput (~0.4 req/s per restaurant) | Spread 200 checks over ~10 restaurants | Run takes minutes, not seconds — documented in README |
| C8 | No data isolation between restaurants in the database | Out of scope: the task has no auth or tenants. In production: Postgres Row-Level Security per restaurant, or tenant checks in every query | Accepted |
| C9 | Fake POS restart loses every order (in memory) → our lookups find nothing → duplicate creates; chaos verification sees an empty POS | Fake POS is never restarted by the chaos test. Options considered: JSON-file snapshot on a volume (~15 lines), Postgres (heavy for a test double) | **Accepted** to keep the fake small, as the spec asks. A real POS persists orders, so this is a test-environment limit, not a design gap |

## D. Spec assumptions (risk if we guessed wrong)

| # | Assumption | If wrong |
|---|---|---|
| D1 | Every POS call (create, lookup, cancel) counts toward the limit | We'd be over-conservative: slower, still correct |
| D2 | `restaurantId` may be added to the lookup query | Fake POS would need to resolve the restaurant some other way |
| D3 | A POS cancel is enough for an order already in the kitchen | Would need a staff-notification flow |

## Open questions
None. C5 resolved: retry forever, capped backoff ([sync-state-machine.md](sync-state-machine.md#retry-policy)).
