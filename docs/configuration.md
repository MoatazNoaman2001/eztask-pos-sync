# Configuration

All keys are listed, without values, in [`local.env`](../local.env). `yarn setup` (also run by `yarn install`) creates a git-ignored `.env` from it:
- local development values, a **random** database password, and the first **free** host port from 5432 (checked by connecting, since Windows lets a bind succeed on a port Docker already serves);
- never overwrites an existing `.env`;
- fails if `local.env` gains a key the script has no value for, so the two can't drift apart.

Edit `.env` freely afterwards; delete it and run `yarn setup` to start over.

- **docker compose** reads `.env` automatically. The compose file has **no values and no defaults**: every value is `${VAR:?…}`, so a missing one stops compose with a clear error instead of starting with a blank.
- **yarn scripts** that run outside Docker (e.g. `db:migrate`) load it with Node's built-in `--env-file-if-exists`; no dotenv package.
- Claude is denied from reading `.env` (`.claude/settings.json`).

## postgres (docker compose)

| Variable | Meaning |
|---|---|
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Database credentials and name |
| `POSTGRES_HOST_PORT` | Port published on your machine. Pick a free one if a local Postgres already uses 5432 |

## api

Status: **Built** (`apps/api/src/config/api.config.ts`).

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `INSTANCE_ID` | hostname | Identifies this instance in `lease_owner` and logs |
| `DATABASE_URL` | — (required) | Postgres connection string |
| `POS_BASE_URL` | — (required) | e.g. `http://fake-pos:4000` |
| `POS_HTTP_TIMEOUT_MS` | `10000` | Must stay **below** `SYNC_LEASE_MS` ([why](pos-integration.md#timeout-values-draft)) |
| `SYNC_LEASE_MS` | `30000` | How long a worker owns a claimed row |
| `SYNC_WORKER_ENABLED` | `true` | Run the sync worker in this instance. Tests that drive the worker by hand set `false` |
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
