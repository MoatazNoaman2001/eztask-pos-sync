# Fake POS

Status: **Built** (`apps/fake-pos`). A small NestJS app that behaves like the third-party POS in the spec, including its bad habits.

## Endpoints

| Endpoint | Success | Errors |
|---|---|---|
| `POST /orders` `{ externalRef, restaurantId, items, total }` | 201 `{ posOrderId }` | 400 bad body, 429, 500, **422 if `total <= 0`** |
| `GET /orders?externalRef=…&restaurantId=…` | 200 list of orders with that `externalRef` | 400 if either param is missing, 429, 500 |
| `POST /orders/:posOrderId/cancel` | 200 the order (status `cancelled`) | 404 unknown order, 429, 500 |
| `GET /debug/orders` | 200 every order held | — |
| `POST /debug/reset` | 204, clears orders and the rate limiter | — |
| `GET /health` | 200 | — |

## What happens on each request

Every POS endpoint runs the same steps, in this order:

```
1. rate limit (per restaurant)   → 429
2. FAIL_RATE                     → 500, nothing done
3. business rule (create only)   → 422 if total <= 0
4. SLOW_RATE                     → wait 3–8 s
5. do the work (create / list / cancel)
6. TIMEOUT_AFTER_CREATE_RATE     → create only: order already saved, then wait 15 s before answering
```

`/debug/*` and `/health` skip all of it, so tests always see the true state.

## Choices we made (spec is silent)

| Choice | Why |
|---|---|
| **Not idempotent**: same `externalRef` twice = two orders | Required by the spec; this is what makes duplicates possible and worth guarding against |
| Rate limit counts **create, lookup and cancel** | Spec says "5 *requests*" (discussion §4.2) |
| Only **accepted** requests count toward the limit | A client that gets 429 and backs off is not punished further; matches common token-bucket POS limiters |
| `restaurantId` **required** on lookup | Lookups carry no order to read the restaurant from; needed to rate-limit them (discussion §4.2) |
| Cancel resolves the restaurant from the stored order | Cancel requests carry only `posOrderId` |
| Cancelling twice returns 200 | A caller that timed out on a cancel can safely repeat it (risk A8) |
| `FAIL_RATE` and `SLOW_RATE` apply to **all** POS endpoints | Lookups and cancels fail in real life too; makes the chaos test harder |
| `TIMEOUT_AFTER_CREATE_RATE` applies to **create only** | As named in the spec |
| 422 checked **after** the random 500 | A 422 check may first see a 500 and be retried; it still ends in 422 |
| In-memory storage | One instance, never killed by the chaos test; keeps the fake small |
| Invalid rate (e.g. `FAIL_RATE=30`) **stops startup** | A typo would otherwise silently break every request |
| `POST /debug/reset` (not in spec) | Each chaos run starts from an empty POS without restarting the container |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `FAKE_POS_PORT` | `4000` | HTTP port |
| `FAIL_RATE` | `0` | Chance (0–1) of a 500 without doing anything |
| `TIMEOUT_AFTER_CREATE_RATE` | `0` | Chance (0–1) a create saves the order, then hangs 15 s |
| `SLOW_RATE` | `0` | Chance (0–1) of answering after 3–8 s |

Rate limit (5 / 10 s) and the delays are fixed by the spec, in `src/config/pos.config.ts`.

## Code layout

```
src/
  config/pos.config.ts              env → typed config, validated at startup
  rate-limit/sliding-window.limiter.ts   per-key sliding window, clock injected for tests
  chaos/chaos.service.ts            the only place with randomness and waiting
  orders/
    orders.module.ts
    controllers/orders.controller.ts      HTTP routes only
    controllers/debug.controller.ts       /debug/orders, /debug/reset (tests only)
    services/orders.service.ts            business rules: the request pipeline above
    repositories/orders.repository.ts     data access: the only place that reads/writes orders
    dto/create-order.dto.ts               request validation
    dto/list-orders.query.ts
    types/pos-order.ts
  configure-app.ts                  shared by main.ts and the e2e tests
test/
  stub-chaos.ts                     deterministic ChaosService, typed against the real one
  orders.e2e.spec.ts                real app over HTTP, each failure mode switched on by the test
```

## Tests

`yarn workspace @eztask/fake-pos test` — 24 tests:
- **Unit**: sliding window (limit, per-restaurant, window expiry, refused requests not counted) with a fake clock; config parsing and validation.
- **E2E** (real HTTP, `ChaosService` replaced by `StubChaos`): create, non-idempotency, 422, 500 creates nothing, **order exists while the create is still hanging**, lookup, cancel twice, 404, 429 per restaurant, lookups/cancels count toward the limit, reset.
