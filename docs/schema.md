# Database schema

Status: **Built**. Drizzle source of truth will be `apps/api/src/db/schema.ts`; migrations generated with `yarn db:generate`.

## Enums

| Enum | Values |
|---|---|
| `check_status` | `open`, `paid`, `cancelled` |
| `sync_desired` | `present`, `absent` |
| `pos_state` | `none`, `unknown`, `created`, `cancelled` |
| `sync_status` | `pending`, `retrying`, `failed`, `synced` |

`in_progress` is **not stored**: `GET /sync` derives it from `lease_until > now()`. Storing it would leave stale "in progress" rows behind every killed instance.

## `checks`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK, default `gen_random_uuid()` | Also sent to the POS as `externalRef` |
| `restaurant_id` | `text` not null | |
| `items` | `jsonb` not null | `[{ name, quantity, unitPrice }]`, validated at the API edge |
| `total` | `numeric(12,2)` not null | Any value accepted (`<= 0` must reach the POS to get its 422) |
| `status` | `check_status` not null, default `open` | |
| `created_at`, `updated_at` | `timestamptz` default `now()` | |

## `pos_sync` (the outbox, one row per paid check)

| Column | Type | Written by | Notes |
|---|---|---|---|
| `check_id` | `uuid` PK, FK → `checks.id` | HTTP | Created by `/pay` |
| `restaurant_id` | `text` not null | HTTP | Copied from the check, for the limiter |
| `desired` | `sync_desired` not null | **HTTP only** | See [column ownership](sync-state-machine.md#column-ownership-hard-rule) |
| `pos_state` | `pos_state` not null, default `none` | Worker | |
| `pos_order_id` | `text` null | Worker | |
| `status` | `sync_status` not null, default `pending` | Both | |
| `attempts` | `integer` not null, default 0 | Worker (reset by retry endpoint) | Temporary failures only; 429 not counted |
| `next_attempt_at` | `timestamptz` not null, default `now()` | Both | |
| `lease_owner` | `text` null | Worker | Instance id + random suffix |
| `lease_until` | `timestamptz` null | Worker | |
| `last_error` | `text` null | Worker | Shown in `GET /sync` |
| `created_at`, `updated_at` | `timestamptz` | | |

Index: partial index on `(next_attempt_at) WHERE status IN ('pending','retrying')` — the claim query only scans due work.

## `pos_rate_limit`

| Column | Type | Notes |
|---|---|---|
| `restaurant_id` | `text` PK | Lock row; inserted on demand with `ON CONFLICT DO NOTHING` |

## `pos_request_log`

| Column | Type | Notes |
|---|---|---|
| `id` | `bigserial` PK | |
| `restaurant_id` | `text` not null | |
| `sent_at` | `timestamptz` not null, default `now()` | |

Index: `(restaurant_id, sent_at)`. Rows older than the window are pruned periodically.

## Fake POS storage

In memory (single instance, not killed by the chaos test). Its own rate limiter is in memory too. Keeps the fake small, as the spec asks.
