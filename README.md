# EZTask — POS sync

Sends paid checks to a restaurant's POS and cancels them when the check is cancelled — exactly once, in order, within the POS rate limit, while API instances are killed and the POS misbehaves.

Design: [docs/architecture.md](docs/architecture.md) · Decisions and trade-offs: [DECISIONS.md](DECISIONS.md) · Full design notes: [docs/](docs/README.md)

## Run from a fresh clone

Needs Docker, Node 22 and Yarn 1.

```bash
git clone git@github.com:MoatazNoaman2001/eztask-pos-sync.git && cd eztask-pos-sync
yarn install                      # also creates .env (see below) and installs git hooks
docker compose up --build -d      # the system: postgres, migrate, api-1, api-2, lb, fake-pos
yarn test:chaos                   # restarts the stack with every POS failure mode on, then runs the chaos test
```

`yarn install` runs `yarn setup`, which creates a git-ignored `.env` from the keys in [local.env](local.env): local values, a random database password, and free host ports. On an existing `.env` it only adds missing keys and fills empty ones; values you set are never changed. The ports actually used are printed by `docker compose ps`. Details: [docs/configuration.md](docs/configuration.md).

| Service | URL | What it is |
|---|---|---|
| `lb` | http://localhost:`LB_HOST_PORT` (3000 if free) | nginx load balancer in front of `api-1` and `api-2` |
| `fake-pos` | http://localhost:`FAKE_POS_PORT` (4000 if free) | Fake POS. Failure rates from `.env`; `docker-compose.chaos.yml` switches them all on |
| `postgres` | localhost:`POSTGRES_HOST_PORT` (from `.env`) | Database |

Stop everything: `docker compose down` (add `-v` to wipe the database).

## Try it

```bash
curl -X POST localhost:3000/checks -H 'content-type: application/json' \
  -d '{"restaurantId":"r1","items":[{"name":"Koshary","quantity":2,"unitPrice":45}],"total":90}'
curl -X POST localhost:3000/checks/<id>/pay
curl localhost:3000/checks/<id>/sync
```

Or click through [requests.http](requests.http) in VS Code with the REST Client extension (recommended in `.vscode/extensions.json`): create → pay → sync → cancel, a 422 with manual retry, and the POS state. It reads ports from `.env`.

Full contract: [docs/api.md](docs/api.md).

## Tests

| Command | What it runs | Needs |
|---|---|---|
| `yarn test` | Unit tests (no database). Also run by the pre-commit hook | Nothing |
| `yarn test:integration` | API against a real Postgres: transactions, row locks, concurrent pay/cancel. Uses a throw-away `<db>_test` database | `docker compose up -d postgres` |
| `yarn test:chaos` | Starts the stack with `docker-compose.chaos.yml` (all failure modes on), then: 220 checks over 10 restaurants, ~20% cancelled, `api-1` killed (SIGKILL) and restarted mid-run, waits until every sync settles, verifies the POS. Restores the normal stack at the end | Docker. **Wipes the local database and the POS first** |

The chaos test takes about 4–6 minutes (plus the image build on the first run): the POS allows 5 requests / 10 s per restaurant, so it is throughput-bound by design ([why](docs/rate-limiting.md#throughput-cost-affects-the-chaos-test)). Failure rates come from `CHAOS_*` in `.env`. It prints progress every 5 s and exits non-zero if any check fails.

It checks that:
- every paid, non-cancelled check has exactly one open POS order,
- every cancelled check has no open POS order,
- no POS order exists that doesn't belong to one of our checks.

## Claude Code setup

Rules for the agent: [CLAUDE.md](CLAUDE.md). Notes on where the AI was wrong: [AI_NOTES.md](AI_NOTES.md).

### Hooks

| Hook | What it does | Why |
|---|---|---|
| `PreToolUse` (Bash) — `.claude/hooks/block-dangerous-commands.mjs` | Blocks `rm -rf`, `git push --force`, `git reset --hard`, `--no-verify`, `docker compose down -v`, `drizzle-kit push` | These destroy work or data, or skip our checks |
| `PreToolUse` (Edit/Write) — `.claude/hooks/protect-migrations.mjs` | Blocks edits to committed migration files | Migrations must come from `yarn db:generate`; editing an applied one silently breaks other databases |
| `PostToolUse` (Edit/Write) — `.claude/hooks/typecheck-after-edit.mjs` | Type-checks the app that was just edited and feeds errors back to the agent | Catches broken code at the edit, not at commit time |
| `Stop` — `.claude/hooks/verify-before-stop.mjs` | Runs `yarn verify` (typecheck + lint + tests) when code changed; the agent can't finish while it fails | The agent must not report "done" on red code |
| Git `pre-commit` (Husky) | Runs `yarn verify` (typecheck + lint + unit tests), same as CI | Nothing unchecked reaches the history, whether a human or the agent commits |

All hooks are Node scripts, so they work on macOS, Linux and Windows without extra setup. Husky installs itself on `yarn install`. CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the same `yarn verify`.

## Repo layout

```
apps/api        NestJS API + sync workers, Drizzle schema and migrations
apps/fake-pos   NestJS fake POS
test/chaos      Chaos test
docs/           Design notes
```

## Time spent

About 5¼ hours, within the 5–7 hour budget:
- **~1¾ h design** before any code: reading the task, comparing designs, writing `docs/` and `CLAUDE.md`. The first commit is the design, not code.
- **~3½ h building and testing**, visible in the commit history (first commit 21:17, `DECISIONS.md` at 00:47).

Claude Code wrote most of the code under the rules and hooks above. Every part was reviewed, and the key safety rules were checked by breaking them on purpose and confirming the tests fail.
