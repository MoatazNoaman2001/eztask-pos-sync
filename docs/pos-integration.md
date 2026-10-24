# POS integration

Status: **Agreed**

## The POS contract (fake POS, mirrors the spec)

| Endpoint | Does | Notes |
|---|---|---|
| `POST /orders` `{ externalRef, restaurantId, items, total }` | Creates an order → `201 { posOrderId }` | **Not idempotent**: same `externalRef` twice = two orders |
| `GET /orders?externalRef=...&restaurantId=...` | Lists orders with that `externalRef` | `restaurantId` added by us so the call is rate-limited per restaurant (discussion §4.2) |
| `POST /orders/:posOrderId/cancel` | Cancels → `200` | Restaurant resolved from the stored order |
| `GET /debug/orders` | Every order held | Used by tests only |

We always send `externalRef = checkId`.

### Failure modes (env vars, rate 0–1)

| Variable | Behaviour |
|---|---|
| `FAIL_RATE` | 500, nothing created |
| `TIMEOUT_AFTER_CREATE_RATE` | Creates the order, then waits 15 s before answering |
| `SLOW_RATE` | Correct answer after 3–8 s |

Always on: **429** over 5 requests / 10 s per restaurant (all endpoints), **422** when `total <= 0`.

## How we react to each outcome

| Outcome | Meaning | Reaction |
|---|---|---|
| `201` | Created | Store `posOrderId`, mark synced |
| `200` (cancel) | Cancelled | Mark cancelled on POS |
| `500` | Failed, nothing created | Retry with exponential backoff + jitter |
| `429` | Over the limit | Reschedule after the window; **does not** count as a failed attempt |
| `422` | Permanent rejection | Stop. Store reason. Wait for manual retry |
| Timeout / connection error | **Unknown** — may have been created | Mark `outcome unknown`; next step is always a lookup, never a blind create |

## The "timed out but maybe created" case

```
us:  POST /orders ─────────────► POS creates order #77
us:  ...                         POS sleeps 15 s
us:  timeout at 10 s             (posOrderId never received)
```

Rule: **after any unknown outcome, the next action is `GET /orders?externalRef=checkId`.**

| Lookup result | Action |
|---|---|
| 0 orders | Safe to create |
| 1 order | Adopt its `posOrderId`, mark synced |
| > 1 order (should not happen) | Keep one, cancel the rest, log loudly |

### Timeout values (draft)
- HTTP timeout **10 s**: above `SLOW_RATE`'s 8 s so slow-but-fine answers are not turned into unknowns; below the 15 s hang.
- Worker lease **30 s**: must exceed the HTTP timeout with margin, so a lease never expires while its request is still in flight (otherwise a second worker could look up too early and create a duplicate).

## Residual risk

- **Late indexing on a real POS.** Our fake POS shows an order in lookups immediately. A real one might not; then lookup-then-create can duplicate. Mitigations: short delay before the lookup; after a create, look up again and cancel extras.
- **Process pause longer than the lease** (e.g. long GC/VM freeze) could let two workers act on one check. Mitigated by writing results only if we still own the lease (compare `lease_owner` / attempt number), not fully eliminated.
