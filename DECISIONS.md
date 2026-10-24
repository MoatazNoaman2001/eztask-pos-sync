# Decisions

How paid checks reach the restaurant POS, why it is built this way, and what is still at risk. Longer notes: [docs/](docs/README.md).

## The problem in one line

The POS is slow, flaky, rate-limited (5 requests / 10 s per restaurant) and **not idempotent**, and any of our API instances can die at any moment. A timeout is ambiguous: the order may or may not exist.

## Designs considered

| Design | Gets right | Breaks where |
|---|---|---|
| **A. Call the POS inside `/pay`** | Simple; the caller sees the result | `/pay` takes seconds and fails when the POS is down (guarantee 1). A kill mid-call loses the order. No shared rate limit |
| **B. Fire-and-forget in memory** (`setImmediate` / in-process queue) | `/pay` is fast | A killed instance loses its queue (guarantee 2). Nothing coordinates the rate limit or create/cancel order across instances |
| **C. Transactional outbox in Postgres + polling workers** *(chosen)* | Payment and "deliver this" commit together; workers in every instance claim rows with `FOR UPDATE SKIP LOCKED` and leases; rate limit lives in the same database | Polling adds ~1 s latency and load on Postgres as volume grows |
| **D. BullMQ / Redis queue** | Mature retries, delays, dashboards | Dual write: commit to Postgres, crash before enqueue → order lost, so an outbox is needed anyway. At-least-once delivery means the duplicate problem stays. Per-group rate limits are a paid feature. Spec: Redis only if needed |
| **E. One queue/partition per restaurant** | Ordering and rate limit fall out naturally | Needs partition ownership or leader election across instances. Overkill now; the 100× answer |

**Why C wins here:** it is the only option where *nothing can be lost between paying and queueing* without a second store. `/pay` writes `checks.status = 'paid'` and a `pos_sync` row in one transaction, then returns (16 ms through the load balancer). Everything else (retries, ordering, rate limit, crash recovery) is rows in the same database, so no work lives only in a process that can be killed.

## How it works

One `pos_sync` row per paid check, with two fields:
- `desired`: what we want the POS to hold (`present` after pay, `absent` after cancel). Written **only** by `/pay` and `/cancel`.
- `pos_state`: what we know it holds (`none`, `unknown`, `created`, `cancelled`). Written **only** by workers.

A worker compares them ([next-action.ts](apps/api/src/sync/domain/next-action.ts)) and takes one step: create, look up, cancel, or done. Each step renews the lease (re-reading `desired`), takes a rate-limit token, makes one POS call and records the result.

| Guarantee | Mechanism |
|---|---|
| 1. Pay never blocked | `/pay` is a DB transaction; no POS call on any HTTP path |
| 2. Exactly one POS order | Outbox written with the payment; `unknown` committed before every create and resolved by lookup; `SKIP LOCKED` + lease = one owner per row; owner-guarded writes |
| 3. Cancel never before create | Cancel only flips `desired` on the same row, so steps run in order. Cancelled before the create was sent → `absent` + `none` → nothing is ever sent |
| 4. Rate limit, fair | Sliding window per restaurant in Postgres, one row lock per restaurant. Out of budget → reschedule and move on, never sleep. Our limit is 4 (POS: 5) for jitter |
| 5. Failures visible, stop when permanent | 5xx/timeouts retry forever with backoff (1 s → 60 s cap); 422 → `failed` with the reason in `GET /sync`; `POST /sync/retry` restarts it |

## The "timed out but maybe created" case

1. Before sending a create, the worker **commits `pos_state = 'unknown'`**.
2. If the POS answers 201, we store `created` and the `posOrderId`. If it answers 5xx, times out, or the process dies at any point, the row stays `unknown`.
3. The next step for `unknown` is **always `GET /orders?externalRef=<checkId>`**, never a create: found → adopt it; nothing → create.
4. The HTTP timeout (10 s) is checked at startup to be below the lease (30 s), so a lease can't expire while its request is in flight. All worker writes are `WHERE lease_owner = me`.

The chaos test (5xx 20%, hang-after-create 10%, slow 10%, an instance SIGKILLed mid-run) passes repeatedly. With step 3 replaced by a blind re-create, it fails with 16 duplicate orders.

**Risk left:**
- **Late indexing on a real POS.** Our fake shows an order in lookups immediately. A real POS that indexes `externalRef` late could make "lookup found nothing" wrong → duplicate. Mitigation not built: wait before the lookup, and re-check after a create, cancelling extras.
- **Pause longer than the lease** (GC or VM freeze > 20 s mid-request) could let a second worker look up before the first's create lands. Guarded writes stop the stale worker from corrupting state, but not the duplicate itself.
- **Fake POS restart loses its orders** (in memory, to keep it small). A real POS persists them; listed so nobody reads the chaos test as covering it.

## Assumptions (spec silent or ambiguous)

- **Every POS request counts toward the limit**: create, lookup *and* cancel (the spec says "requests").
- **Lookups carry `restaurantId`** so they can be rate-limited per restaurant; the fake POS requires it.
- **Only accepted requests count** in the fake POS limiter; a 429 isn't counted again.
- **Cancelling an already-cancelled POS order returns 200**, so a timed-out cancel can be repeated.
- **A POS cancel is enough** for an order already in the kitchen; no staff notification.
- **`total <= 0` is accepted by our API**, otherwise the POS's 422 path could never be reached.
- **Pay twice / cancel twice are no-ops (200); pay after cancel is 409.** An unpaid check that is cancelled never reaches the POS.

## At 100× the volume

- **Move the worker to its own deployment** (same image, `SYNC_WORKER_ENABLED`), scaled separately from HTTP.
- **Partition by restaurant** (design E): each worker owns a hash range of restaurants, so the rate limit becomes a local counter and claims stop competing. The Postgres outbox stays the source of truth.
- **Relay the outbox to Kafka** (partitioned by restaurant) once polling Postgres is the bottleneck; `LISTEN/NOTIFY` first to cut idle polling.
- **Housekeeping:** archive synced `pos_sync` rows, prune `pos_request_log` on a schedule, partition both by time.
- **Ask the POS vendor for an idempotency key.** It would remove the lookup-before-create dance entirely.

## With another day

- Mitigate the late-indexing risk: delayed lookup plus a post-create duplicate sweep, with a test using a lagging fake POS.
- Metrics and alerts: sync lag per restaurant, attempts > 10, `failed` count, 429s received (should be ~0).
- Shutdown within Docker's grace period: on SIGTERM the worker already finishes and releases its rows, but a row mid-way through several 10 s steps can outlast the default 10 s `stop_grace_period`, get SIGKILLed and wait 30 s for its lease. Stop after the current step instead, and raise the grace period.
- Run the chaos test in CI on every push, with a seed so a failing run can be replayed.
