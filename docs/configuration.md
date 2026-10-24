# Configuration

All keys are listed, without values, in [`local.env`](../local.env). `docker-compose.yml` sets working values for every service. Real secrets never go in the repo: `.env` is git-ignored and Claude is denied from reading it.

## api

Status: **Planned** (wired up with the API).

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `INSTANCE_ID` | hostname | Identifies this instance in `lease_owner` and logs |
| `DATABASE_URL` | — (required) | Postgres connection string |
| `POS_BASE_URL` | — (required) | e.g. `http://fake-pos:4000` |
| `POS_HTTP_TIMEOUT_MS` | `10000` | Must stay **below** `SYNC_LEASE_MS` ([why](pos-integration.md#timeout-values-draft)) |
| `SYNC_LEASE_MS` | `30000` | How long a worker owns a claimed row |
| `SYNC_POLL_INTERVAL_MS` | `1000` | How often each worker looks for due rows |
| `SYNC_BATCH_SIZE` | `10` | Rows claimed per poll |
| `RATE_LIMIT_MAX_REQUESTS` | `4` | Our side of the POS limit (POS allows 5; 1 kept as margin) |
| `RATE_LIMIT_WINDOW_MS` | `10000` | Window for the limit above |

The API refuses to start if `POS_HTTP_TIMEOUT_MS >= SYNC_LEASE_MS`.

## fake-pos

Status: **Built**. See [fake-pos.md](fake-pos.md#configuration).

| Variable | Default | Meaning |
|---|---|---|
| `FAKE_POS_PORT` | `4000` | HTTP port |
| `FAIL_RATE` | `0` | 0–1 |
| `TIMEOUT_AFTER_CREATE_RATE` | `0` | 0–1 |
| `SLOW_RATE` | `0` | 0–1 |

Rates outside 0–1 stop startup with a clear error.
