# Architecture

Status: **Agreed** (design choice C — transactional outbox in Postgres). Reasoning in [discussion.md §2](discussion.md#2-which-architecture).

## Components

```
            ┌────────────────────── docker compose ──────────────────────┐
            │                                                             │
Customer ───┼──► lb ──┬──► api-1 ──┐                                       │
            │  (nginx) └──► api-2 ──┼──► postgres  (checks, pos_sync,      │
            │                       │              rate-limit state)     │
            │                       │                                    │
            │      workers inside each api instance ──HTTP──► fake-pos   │
            │                                                             │
            │  migrate: runs once before api-1 / api-2 start              │
            └─────────────────────────────────────────────────────────────┘
```

| Component | Role |
|---|---|
| `api-1`, `api-2` | Identical NestJS app. Serves HTTP endpoints **and** runs sync workers. Any instance can die at any time. |
| `postgres` | Single source of truth: checks, sync state, rate-limit state. All coordination between instances goes through it. |
| `fake-pos` | Separate NestJS app imitating the third-party POS, with configurable failure modes. |
| `lb` | nginx in front of `api-1` and `api-2`. Retries the other instance only for requests that never reached a dead one, so it never sends a POST twice |
| `migrate` | One-shot container: runs Drizzle migrations, then exits. `api-1` and `api-2` start only after it succeeds, so two instances never migrate at the same time ([risk C1](risk.md#c-operational-risks)). |

No Redis / BullMQ: the design does not need them (see discussion §2, option D).

## Core idea

1. **The HTTP path only writes to Postgres.** It never calls the POS.
2. **Workers deliver to the POS.** They claim work from Postgres, call the POS, and write the result back.
3. **Postgres coordinates instances.** Row locks (`FOR UPDATE SKIP LOCKED`) and leases decide who works on what; nothing is held in memory that matters after a crash.

## Request flow

### `POST /checks/:id/pay`
One transaction:
```
UPDATE checks  SET status = 'paid'
INSERT pos_sync (check_id, restaurant_id, desired = 'present', next_attempt_at = now())
```
Return 200. No network call → well under 300 ms, independent of POS health.

### `POST /checks/:id/cancel`
One transaction:
```
UPDATE checks   SET status = 'cancelled'
UPDATE pos_sync SET desired = 'absent', next_attempt_at = now()   -- if a sync row exists
```
The worker figures out what the POS needs (nothing, or a cancel). See [sync-state-machine.md](sync-state-machine.md).

### `GET /checks/:id/sync`
Reads the `pos_sync` row: state, attempts, `posOrderId`, last error, next attempt time.

### `POST /checks/:id/sync/retry`
Only valid when the sync is stopped (`failed`). Resets it to retryable with `next_attempt_at = now()`.

## Sync flow (worker loop, every instance)

```
loop:
  claim up to N due rows   (SKIP LOCKED, set lease_until = now() + 30s)
  for each row:
    take a rate-limit token for row.restaurant_id   (else reschedule, move on)
    call POS (HTTP timeout 10s)
    write result + release lease   (only if we still own the lease)
```

Details: [sync-state-machine.md](sync-state-machine.md), [rate-limiting.md](rate-limiting.md), [pos-integration.md](pos-integration.md).

### Where the worker lives

There is **no separate retry worker**. One sync worker, inside every API process, handles first attempts and retries alike.

| File (planned) | Role |
|---|---|
| `apps/api/src/sync/sync.worker.ts` | Polling loop. Starts in `onApplicationBootstrap`, stops claiming in `onApplicationShutdown` |
| `apps/api/src/sync/sync.processor.ts` | Decision table: given a row, do the next step |
| `apps/api/src/sync/rate-limiter.service.ts` | Takes a per-restaurant token in Postgres |
| `apps/api/src/pos/pos.client.ts` | HTTP calls to the POS, 10 s timeout, maps responses to outcomes |

**A retry is just data.** After a 500 the worker writes `status = retrying`, `next_attempt_at = now() + backoff` and releases the row. No timer, `setTimeout` or in-memory queue holds it. When the time comes, whichever instance polls first claims it.

So retries survive crashes: kill an instance and its scheduled retries are still rows in Postgres, picked up by the other instance (or by itself after restart).

On shutdown the worker stops claiming new rows and lets in-flight calls finish; if it is killed hard, the lease expires after 30 s and another instance takes over.

**Alternative:** run the worker as its own container (same image, `WORKER_ONLY=true`). It scales separately from HTTP and keeps POS calls off the API's event loop. Not needed at this volume; listed as a 100× change.

## How each guarantee is met

| # | Guarantee | Mechanism |
|---|---|---|
| 1 | Pay never blocked by POS | `/pay` is a DB-only transaction |
| 2 | Exactly one POS order per paid check | Outbox row in the same transaction (none lost); lookup by `externalRef` before any re-create (none duplicated); one owner per check via lock + lease |
| 3 | Cancel never before create | One sync row per check, processed by one worker at a time; cancel is a change of *desired* state, not a separate job |
| 4 | Rate limit across instances, fair per restaurant | Shared per-restaurant limiter in Postgres; out-of-budget rows are rescheduled, not waited on |
| 5 | Failures visible, permanent ones stop | 422 → `failed` with reason, no auto-retry; manual retry endpoint |
