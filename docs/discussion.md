# Discussion log

Questions raised while designing, and what we decided. Newest at the bottom.

---

## 1. POS integration constraints

The POS is an external dependency we call over HTTP and cannot change; it never calls us back. Our database is the source of truth and the POS is a downstream copy we keep in sync. These properties of the POS drive every design choice below:
- **Not idempotent.** Same `externalRef` twice → two orders → kitchen cooks twice.
- **Ambiguous timeouts.** It can create the order and then fail to answer. "Failed" and "succeeded, answer lost" look identical to us.
- **Slow and flaky.** 3–8 s responses, random 500s.
- **Rate-limited per restaurant.** 5 requests / 10 s, counted across all our instances.

Our only tool against duplicates: `GET /orders?externalRef=` lets us ask "do you already have an order for this check?"

Details: [pos-integration.md](pos-integration.md)

---

## 2. Which architecture?

Five options considered:

| Option | Breaks where |
|---|---|
| A. Call POS inside `/pay` | `/pay` > 300 ms; payment fails when POS is down; crash mid-call loses the order |
| B. Fire-and-forget in memory | Instance killed → work lost; no shared rate limit; no create/cancel ordering |
| **C. Transactional outbox in Postgres + polling workers (`SKIP LOCKED`)** | Polling latency (~1 s) and DB load at very high volume |
| D. BullMQ / Redis | Dual write (commit to Postgres, crash before enqueue → lost); fixing it needs an outbox anyway |
| E. Partitioned per-restaurant queues | Needs partition ownership / leader election; overkill now, candidate for 100× |

**Decision: C.** One store, atomic writes, survives instance kills, rate limit and sync state live in the same place. D and E are argued against in `DECISIONS.md`; E is the 100× answer.

---

## 3. Why write `paid` to the DB when we don't know the POS result?

Because "paid" is a fact about **payment**, not about **delivery to the POS**. They are two separate facts:

| Fact | Decided by | Known when | Stored in |
|---|---|---|---|
| Customer paid | Us | Immediately | `checks.status = 'paid'` |
| POS has the order | Third-party POS | Later, maybe after retries | `pos_sync` row |

`/pay` writes both rows **in one transaction**: the payment, and the *intent* to deliver. It never claims the POS has the order. A worker delivers later and records the real result, visible through `GET /checks/:id/sync`.

Why not wait for the POS:
1. Guarantee 1 forbids it (< 300 ms, works when POS is down).
2. The money is taken; rejecting payment because a third party is down is wrong.
3. Waiting does not even give the truth: on timeout we still don't know.

**Decision:** payment state and delivery state are separate. `/pay` commits payment + intent atomically; delivery has its own state machine.

---

## 4. Questions about the spec, and our answers

### 4.1 How many restaurants / instances?
- **Many restaurants.** Guarantee 4 ("one busy restaurant must not delay others") can only be tested with several. The chaos test spreads checks across 5–10 restaurants.
- **Compose topology:** `api-1`, `api-2` (identical), `fake-pos` (one instance), `postgres`.

### 4.2 Do lookups and cancels count toward the rate limit?
The spec says "5 **requests**" in both guarantee 4 and the fake POS description, not "5 orders".

**Decision:** every POS call counts toward its restaurant's limit (create, lookup, cancel).
- Fake POS enforces the limit on all three endpoints. Cancel resolves the restaurant from the stored order; lookup receives `restaurantId` as a query param.
- Our limiter spends one token per POS call of any kind.
- Recorded as an assumption in `DECISIONS.md`.

### 4.3 Is the lookup immediately consistent after a create?
In **our fake POS**, yes: it stores the order before sleeping, so a lookup after a timeout always finds it.

A **real POS** might index late. Then "look up, then create" can still duplicate.
**Decision:** design against the fake, list this as residual risk in `DECISIONS.md` with mitigations (delay before lookup; post-create duplicate check that cancels extras).

### 4.4 If an order is already in the kitchen and gets cancelled?
**Decision:** a POS cancel is enough. No staff notification flow.

---

## 5. Risks found while writing the risk register

- **Cancel during an in-flight create** (risk A5). **Decision:** column ownership — workers never write `desired`; explicit column updates only. Goes into `CLAUDE.md`. See [sync-state-machine.md](sync-state-machine.md#column-ownership-hard-rule).
- **Two instances migrating at once** (C1). **Decision:** one-shot `migrate` container; APIs depend on it. See [architecture.md](architecture.md#components).
- **Chaos test is slow under the rate limit** (C7). **Decision:** ~10 restaurants, poll until settled, document the runtime. See [rate-limiting.md](rate-limiting.md#throughput-cost-affects-the-chaos-test).
- **Row-Level Security?** Not needed: no auth or tenants in scope. Recorded as risk C8 with the production answer.

---

## 6. Finishing the design

### Retry forever, or stop after N temporary failures?
First instinct was "stop after ~10 and mark `failed`". **Rejected:** with the POS down for a while, checks would stop syncing and guarantee 2 ("every paid check eventually reaches the POS") breaks. The spec reserves stopping for permanent rejections (422).
**Decision:** retry temporary errors forever, backoff `1s × 2^n` capped at 60 s with jitter; make it visible via `attempts` / `last_error`; production alert above 10 attempts.

### `/sync/retry` on a sync that is not `failed`
**Decision:** 409. Retry resets `attempts` and wakes the row; it still goes through the state machine (lookup if `unknown`), so a double click can't duplicate.

### Don't store `in_progress`
**Decision:** derive it from `lease_until > now()`. A stored flag would be left stale by every killed instance.

### Schema and API
Written in [schema.md](schema.md) and [api.md](api.md). Notable choices: `total` accepts `<= 0` (so the 422 path is reachable); cancelling an `open` check creates no sync row; `/pay` on a cancelled check is 409; fake POS keeps state in memory.

---

## 7. Redis/BullMQ worker, or a worker inside the API on Postgres?

Two separate questions: **where the queue lives** (Postgres vs Redis) and **where the worker runs** (inside the API vs its own container).

Why Redis/BullMQ doesn't win here:
- **Dual write.** Commit `paid` to Postgres, crash before `queue.add()` → order lost. Fixing it needs a Postgres outbox anyway, plus a relay to Redis: more moving parts, same guarantee.
- **It doesn't remove the hard part.** BullMQ is at-least-once (a stalled job runs again after a kill), so we'd still need `unknown` → lookup before create.
- **Per-restaurant rate limit isn't built in.** Open-source BullMQ rate-limits a whole queue; per-group limits are a paid (Pro) feature. We'd write a custom limiter anyway.
- **Ordering per check** (create before cancel) needs extra work in a queue; in our model it is one row.
- **Spec:** "Redis only if your design needs them; using them is not a plus."

When Redis/Kafka would win: polling load on Postgres becomes the bottleneck (≈100×), or many consumers need push-based delivery. Then: keep the Postgres outbox as the source of truth and relay it to a queue.

**Decision:** Postgres queue, worker inside the API. At 100×: first split the worker into its own container (same image), then consider outbox → Kafka/Redis partitioned by restaurant.

---

## 8. Version control workflow

Options: commit straight to `main`; a long-lived `dev` branch merged at the end; short-lived feature branches merged through PRs.

**Decision:** commit straight to `main`. One developer, one day: branches and PRs add ceremony without catching anything the hooks don't already catch.
What keeps `main` healthy instead:
- small commits, one concern each, messages that say *why*;
- the pre-commit hook runs the same checks as CI, so every commit on `main` type-checks, lints and passes unit tests;
- history is never squashed or rewritten (the spec reads it).

With a team, we would switch to feature branches + PRs with required CI, merged without squashing.

---

## Open items

- [ ] Final review of the Proposed docs ([sync-state-machine](sync-state-machine.md), [rate-limiting](rate-limiting.md), [risk](risk.md), [schema](schema.md), [api](api.md))
- [x] Database schema
- [x] Timeout and lease values: HTTP 10 s, lease 30 s
- [x] `CLAUDE.md`
- [ ] `.claude/settings.json`, hooks, pre-commit
- [ ] `DECISIONS.md` (distil from these docs)
