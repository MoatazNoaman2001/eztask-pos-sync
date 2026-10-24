# API contract

Status: **Built** (`apps/api/src/checks`), covered by `apps/api/test/checks.int.spec.ts`

## Check transitions

```
open ──pay──► paid ──cancel──► cancelled
  └────────cancel─────────────────▲
```

| Request | From `open` | From `paid` | From `cancelled` |
|---|---|---|---|
| `POST /checks/:id/pay` | → `paid`, creates `pos_sync` (`desired = present`) | 200, no-op | **409** |
| `POST /checks/:id/cancel` | → `cancelled`, no `pos_sync` row (never paid, nothing to send) | → `cancelled`, `pos_sync.desired = absent`, wake row | 200, no-op |

All transitions lock the check row (`SELECT … FOR UPDATE`) inside the transaction.

## Endpoints

| Endpoint | Success | Errors |
|---|---|---|
| `POST /checks` `{ restaurantId, items[], total }` | 201 `{ id, status: "open" }` | 400 invalid body |
| `POST /checks/:id/pay` | 200 `{ id, status: "paid" }` | 404, 409 |
| `POST /checks/:id/cancel` | 200 `{ id, status: "cancelled" }` | 404 |
| `GET /checks/:id/sync` | 200, see below | 404 unknown check; 200 `{ status: "not_required" }` if never paid |
| `POST /checks/:id/sync/retry` | 202 | 404; **409** unless sync `status = failed` |

### `GET /checks/:id/sync` response
```json
{
  "checkId": "…",
  "status": "retrying",          // pending | in_progress | retrying | failed | synced | not_required
  "desired": "present",
  "posState": "unknown",
  "posOrderId": null,
  "attempts": 3,
  "nextAttemptAt": "2026-10-24T18:00:05Z",
  "lastError": "POS timeout after 10000ms"
}
```

### `POST /checks/:id/sync/retry`
Only on `failed`: sets `status = pending`, `attempts = 0`, `next_attempt_at = now()`, keeps `last_error` until the next attempt overwrites it. Retrying a 422 with the same total will fail again — that is expected.
