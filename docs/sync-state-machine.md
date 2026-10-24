# Sync state machine

Status: **Built** (`apps/api/src/sync`). Decision table: `domain/next-action.ts`; worker: `sync.worker.ts` + `services/sync-processor.service.ts`. Tests: `apps/api/test/sync.int.spec.ts`.

## Idea: desired state vs. known POS state

Instead of separate "create" and "cancel" jobs (which can race), each check has **one** `pos_sync` row with two fields:

- `desired` — what *we* want the POS to hold: `present` (paid) or `absent` (cancelled).
- `pos_state` — what we *know* the POS holds: `none`, `unknown`, `created`, `cancelled`.

The worker's job is to make `pos_state` match `desired`. Cancel just flips `desired`; ordering then falls out naturally because one worker owns the row at a time.

## Decision table (what the worker does next)

| desired | pos_state | Next action | Result |
|---|---|---|---|
| present | none | `POST /orders` | 201 → `created`; timeout → `unknown` |
| present | unknown | lookup by `externalRef` | found → `created`; none → `none` (create next) |
| present | created | — | **done** |
| absent | none | — (create never sent) | **done**, POS never touched |
| absent | unknown | lookup by `externalRef` | found → cancel each; none → **done** |
| absent | created | `POST /orders/:id/cancel` | 200 → `cancelled` |
| absent | cancelled | — | **done** |

This covers guarantee 3:
- A cancel can't reach the POS before its create: both are steps on the same row, run in order by one owner.
- Cancelled before the create was sent → `absent + none` → nothing is ever sent.
- Cancelled while the create's outcome is unknown → lookup first, then cancel whatever exists.

## Status shown to users (`GET /checks/:id/sync`)

| `status` | When |
|---|---|
| `pending` | Work to do, waiting for its turn (`next_attempt_at`) |
| `in_progress` | Leased by a worker right now — **derived** from `lease_until > now()`, not stored |
| `retrying` | Last attempt hit a temporary error; `last_error` set |
| `failed` | 422 — stopped, `last_error` holds the reason; needs `/sync/retry` |
| `synced` | `pos_state` matches `desired` |

## Retry policy

| Outcome | Counts as attempt | Next attempt |
|---|---|---|
| 500, timeout, connection error | Yes | `min(60s, 1s × 2^attempts)` ± 20% jitter |
| 429 | No | When the restaurant's window frees up |
| 422 | — | Never (status `failed`) |

**Temporary errors are retried forever** (backoff capped at 60 s). Stopping after N attempts would break guarantee 2 ("every paid check eventually reaches the POS") during a long POS outage. Guarantee 5 reserves stopping for permanent rejections. Visibility comes from `attempts` and `last_error` in `GET /sync`; in production an alert fires above a threshold (e.g. 10 attempts).

## Draft `pos_sync` columns

| Column | Purpose |
|---|---|
| `check_id` (PK, FK) | One row per check |
| `restaurant_id` | For rate limiting and fair claiming |
| `desired` | `present` / `absent` |
| `pos_state` | `none` / `unknown` / `created` / `cancelled` |
| `pos_order_id` | Set when known |
| `status` | As above |
| `attempts` | Counts real failures (not 429s) |
| `next_attempt_at` | When the row becomes claimable |
| `lease_owner`, `lease_until` | Who holds it and until when |
| `last_error` | Shown in `GET /sync` |
| `updated_at` | |

## Column ownership (hard rule)

Two writers touch a `pos_sync` row: the HTTP path (`/pay`, `/cancel`, `/sync/retry`) and the worker. They must never overwrite each other's fields.

| Column | Written by |
|---|---|
| `desired` | HTTP path only (`/pay` → `present`, `/cancel` → `absent`) |
| `pos_state`, `pos_order_id`, `last_error`, `attempts`, `lease_*` | Worker only |
| `status`, `next_attempt_at` | Both (HTTP path sets `pending` + `now()` to wake the row) |

Why: a cancel can land while a worker is mid-create on the same row ([risk A5](risk.md#a-correctness-risks-duplicates-lost-orders-wrong-order-of-events)). If the worker wrote the whole row back, it would reset `desired` to `present` and the cancel would be lost.

Worker rules that follow:
- Update with explicit column lists, never "save the whole row".
- After each step, re-read `desired` and re-evaluate the decision table; if `desired` changed mid-step, the row stays due instead of being marked `synced`.

This rule goes into `CLAUDE.md`.

## Claiming work

```sql
SELECT check_id FROM pos_sync
WHERE status IN ('pending','retrying')
  AND next_attempt_at <= now()
  AND (lease_until IS NULL OR lease_until < now())
ORDER BY next_attempt_at
LIMIT :n
FOR UPDATE SKIP LOCKED;
-- then: SET lease_owner = :me, lease_until = now() + interval '30 seconds'
```

- `SKIP LOCKED`: two instances never claim the same row.
- Lease expiry: a killed instance's rows become claimable again after 30 s.
- All times come from Postgres `now()`, so instance clock drift doesn't matter.
- Writing a result: `UPDATE ... WHERE check_id = :id AND lease_owner = :me` — a worker that lost its lease can't overwrite newer state.

## Crash walkthrough

| Killed when | State left | What happens next |
|---|---|---|
| Before `/pay` commits | Nothing | Client retries `/pay` |
| After commit, before claim | `pending` | Any worker picks it up |
| After claim, before HTTP call | Leased, `pos_state = none` | Lease expires → re-claimed → create |
| During HTTP call | Leased, POS may or may not have it | **Before** sending, the worker sets `pos_state = unknown`; after lease expiry the next worker does a lookup first |
| After POS answered, before writing | Same as above | Lookup finds the order → adopt it |
| Mid-create, while `/cancel` commits | `desired = absent`, `pos_state = unknown` | Worker's write leaves `desired` alone; row stays due → lookup → cancel what exists |

Key rule: **set `pos_state = unknown` (committed) before sending any create.** Then every crash path leads to a lookup, never a blind second create.

## Resolved questions
- Repeated 500s: retry forever with capped backoff (see [Retry policy](#retry-policy)).
- `/sync/retry` on a non-failed row: 409 (see [api.md](api.md)).

Full column types: [schema.md](schema.md).
