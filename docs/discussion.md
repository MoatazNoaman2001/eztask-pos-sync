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

## 9. Building the fake POS

Choices where the spec is silent (full list in [fake-pos.md](fake-pos.md#choices-we-made-spec-is-silent)):
- **Only accepted requests count** toward the rate limit, so backing off after a 429 works.
- **`FAIL_RATE` and `SLOW_RATE` hit every endpoint**, `TIMEOUT_AFTER_CREATE_RATE` only create.
- **Cancel is repeatable** (200 on an already-cancelled order).
- **`POST /debug/reset`** added so chaos runs start clean without restarting containers.
- **Testability:** all randomness and waiting live in `ChaosService`; tests swap it for `StubChaos` (typed against the real one) and trigger each failure on purpose. The limiter takes an injected clock.
- **Env template:** `local.env` lists every key with no values; compose holds working values. Avoids a half-filled file being mistaken for real config.

---

## 10. Folder structure inside a module

Nest's docs put a feature's files side by side (`orders.controller.ts`, `orders.service.ts`, …). We use **layer folders inside each feature module** instead:

```
orders/
  controllers/    HTTP only: parse, validate, call the service
  services/       business rules
  repositories/   data access (DAO): the only place with storage / SQL
  dto/            request shapes + validation
  types/          domain types
```

**Why:** clear boundaries once Postgres arrives. Services never touch the database, so they can be unit-tested with a fake repository; repositories are tested against real Postgres. Same layout in `apps/api`, so both apps read the same way.

**Decision:** layer folders per feature module. Added to `CLAUDE.md` as a hard rule.

---

## 11. Where config values live

**Decision:** `docker-compose.yml` holds no values and no defaults: every value is `${VAR:?…}` read from a git-ignored `.env`. `local.env` lists the keys with empty values. A missing value fails loudly at `docker compose up`.

**Why:** one source of truth for values (the env), nothing that looks like config but silently overrides it, and compose behaves like a real deployment where values are injected.

**Found while doing it:** the host already runs a Windows PostgreSQL service on 5432, so connecting to "localhost:5432" reached the wrong database and failed authentication. The host port is now `POSTGRES_HOST_PORT`.

**Fresh clone:** options were a `yarn setup` script, a committed `dev.env`, or filling values by hand. **Decision: `yarn setup`**, run automatically by `yarn install`. No values in the repo, still 4 commands from a fresh clone.

---

## 12. Building the checks API

- **Transactions without leaking Drizzle into services.** A small `TransactionRunner` opens the transaction; repositories take an optional `tx` and run on it. Services draw the boundary, repositories hold the SQL (rule 14).
- **Where the sync endpoints live.** `GET/POST /checks/:id/sync` are in the checks module and use `PosSyncRepository`, exported by the sync module. Dependencies go one way (checks → sync); the worker will live in the sync module.
- **Tokens in their own file** (`db.tokens.ts`): `transaction.ts` and `database.module.ts` imported each other, which in CommonJS can make `@Inject(DB)` see `undefined`.
- **Malformed ids are 400**, not a Postgres error turned 500 (`ParseUUIDPipe`).
- **Two test levels.** `yarn test` (unit, no DB) runs in the pre-commit and Stop hooks. `yarn test:integration` (real Postgres, own `<db>_test` database re-created each run) runs in CI with a Postgres service container.
- **Tests checked against deliberate bugs.** Removing the row lock fails the concurrency test (3 of 3 runs); dropping the outbox write fails 8 tests.

---

## 13. Building the sync worker

- **One POS call per step**, up to 4 steps per claim (e.g. lookup → create). Each step renews the lease first, which also re-reads `desired`, so a cancel that lands mid-claim is seen at the next step.
- **Commit `unknown` before every create.** 5xx and timeouts leave it `unknown` (next step: lookup). 429 and 4xx set it back to `none`: the POS refused before creating anything.
- **Guarded writes.** Every worker write has `lease_owner = me`; status writes also have `desired = what I acted on`. A false return means "something changed under me": re-read and decide again.
- **Lookup/cancel failures are just "failed"** (safe to repeat). Only a create is ambiguous, and `unknown` already covers it, so the client needs four outcome kinds, not five.
- **Rate limiter bugs found by tests** (AI_NOTES #3): SQL precedence in an embedded fragment, and `now()` vs `clock_timestamp()` under lock waits.
- **Tests run the real fake POS in-process** with `StubChaos`, so each failure mode is triggered on purpose. Mutation-checked: dropping "commit unknown first", "lookup after unknown" or the `desired` guard each fails tests.

---

## 14. The compose stack

- **One image for both apps** (multi-stage `Dockerfile`): each service picks its command. Production dependencies only in the final stage; `--ignore-scripts` so `prepare` (git hooks, `.env` setup) never runs in an image.
- **Start order by health, not by sleeps:** postgres healthy → `migrate` completes → fake-pos healthy → `api-1`/`api-2` healthy → `lb`.
- **nginx** retries the other instance only when a request never reached the dead one (its default for POST). The chaos client retries `/pay` and `/cancel` itself, which is safe because both are no-ops when repeated.
- **Only wiring is written in compose** (service names, URLs built from them, `INSTANCE_ID: api-1`). Every value, including chaos rates, comes from `.env`.
- **`yarn setup` now completes an existing `.env`**: adds missing keys, fills empty ones, never changes set values, prints key names only. Needed because new keys (`LB_HOST_PORT`, `CHAOS_*`) appear as the project grows.
- **Claude can't read `.env`**, not even with `grep`: the deny rule held when Claude tried to list empty keys. The setup script reports names instead.

---

## 15. Chaos test

- **Black-box on purpose:** a plain Node script that only uses HTTP through the load balancer, the POS `/debug` endpoints and `docker compose`. It would catch bugs in wiring (nginx, compose, migrations) that in-process tests can't.
- **Clean start every run:** `POST /debug/reset` and a `TRUNCATE` of our tables, so condition 3 ("no stray POS orders") is checked against this run only. Documented in the README as wiping local data.
- **Settled = every check's `GET /sync` is `synced`**, polled every 5 s with a 10-minute cap. A `failed` sync fails the run (totals are all > 0, so none is expected).
- **Cancels in two timings:** half right after paying (usually before the create was sent), half 3–8 s later (usually after), so both orders of events are exercised.
- **Results:** passed 2 of 2 runs (≈3.5 min each). Against a deliberately broken build (after an unknown create, create again instead of looking up) it **failed with 16 duplicate orders**: the test has teeth.

---

## Open items

- [ ] Final review of the Proposed docs ([sync-state-machine](sync-state-machine.md), [rate-limiting](rate-limiting.md), [risk](risk.md), [schema](schema.md), [api](api.md))
- [x] Database schema
- [x] Timeout and lease values: HTTP 10 s, lease 30 s
- [x] `CLAUDE.md`
- [x] `.claude/settings.json`, hooks, pre-commit
- [x] `DECISIONS.md` (distilled from these docs)
- [x] Chaos test passing repeatedly, and failing on a broken build
- [x] How a reviewer gets `.env` values on a fresh clone (`yarn setup`)
