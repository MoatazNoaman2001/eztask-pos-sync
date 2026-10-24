# Rate limiting

Status: **Built** (`apps/api/src/sync/repositories/rate-limit.repository.ts`)

## Requirement

At most **5 requests per 10 seconds per restaurant**, counted across **all** API instances. Every POS call counts: create, lookup, cancel (discussion §4.2). One busy restaurant must not delay others.

## Why it must be shared

Each instance counting in memory would allow 5 × (number of instances). The counter must live where all instances see it: Postgres (already there; no Redis needed).

## Proposed design: sliding log per restaurant

Tables:
- `pos_rate_limit(restaurant_id PK)` — one row per restaurant, used as a lock.
- `pos_request_log(restaurant_id, sent_at)` — one row per POS call.

Taking a token (one short transaction, right before the HTTP call):
```sql
SELECT 1 FROM pos_rate_limit WHERE restaurant_id = :r FOR UPDATE;   -- serialise this restaurant only
SELECT count(*), min(sent_at) FROM pos_request_log
 WHERE restaurant_id = :r AND sent_at > now() - interval '10 seconds';
-- count < LIMIT → INSERT pos_request_log (:r, now()); proceed
-- else          → reschedule row: next_attempt_at = min(sent_at) + 10s
```

- The lock is per restaurant, so restaurants never wait on each other.
- Old log rows are pruned periodically.
- Uses Postgres time → no clock drift between instances. Specifically `clock_timestamp()`, not `now()`: `now()` is the transaction's start time, and a caller that waited on the lock would log its request too early ([AI_NOTES.md](../AI_NOTES.md) #3).

## Fairness

A worker that finds a restaurant out of budget **does not sleep**. It reschedules that row and moves on to the next claimed row. Rows for other restaurants keep flowing.

Optional improvement: the claim query skips restaurants known to be out of budget, so workers don't waste claims on them.

## Safety margin

We take the token *before* the request leaves; the POS counts when it *arrives*. Network jitter can bunch requests together at the POS. Draft: use a limit of **4 per 10 s** (or a 10.5 s window) on our side. A 429 is still handled (reschedule, not counted as a failure) in case the margin isn't enough.

## Throughput cost (affects the chaos test)

With 4 requests / 10 s, one restaurant gets about **0.4 POS requests per second**. A paid-then-cancelled check costs at least 2 requests; every unknown outcome adds a lookup; 500s and 429s add retries.

So the chaos test (200+ checks, ~20% cancelled, all failure modes on) must:
- spread checks across **~10 restaurants** so total throughput is ~4 req/s,
- wait for "settled" by polling until every sync row is `synced` or `failed`, with a hard timeout — never a fixed sleep,
- be documented in the README as taking minutes, not seconds.

See [risk C6, C7](risk.md#c-operational-risks).

## Alternatives considered
- **Token bucket in one row** (`tokens`, `refilled_at`): fewer rows, but allows bursts at window edges that a strict sliding window would not.
- **Redis `INCR` with TTL**: fast, but adds a second store for no gain at this volume.
