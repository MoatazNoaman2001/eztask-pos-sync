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

`yarn install` runs `yarn setup`, which creates a git-ignored `.env` from the keys in [local.env](local.env): local values, a random database password, and a free host port for Postgres. It never overwrites an existing `.env`. Details: [docs/configuration.md](docs/configuration.md).

| Service | URL | What it is |
|---|---|---|
| `lb` | http://localhost:3000 | Load balancer in front of `api-1` and `api-2` |
| `fake-pos` | http://localhost:4000 | Fake POS (failure modes set in `docker-compose.yml`) |
| `postgres` | localhost:`POSTGRES_HOST_PORT` (from `.env`) | Database |

Stop everything: `docker compose down` (add `-v` to wipe the database).

## Try it

```bash
curl -X POST localhost:3000/checks -H 'content-type: application/json' \
  -d '{"restaurantId":"r1","items":[{"name":"Koshary","quantity":2,"unitPrice":45}],"total":90}'
curl -X POST localhost:3000/checks/<id>/pay
curl localhost:3000/checks/<id>/sync
```

Full contract: [docs/api.md](docs/api.md).

## Tests

| Command | What it runs | Needs |
|---|---|---|
| `yarn test` | Unit tests + integration tests against a real Postgres | `docker compose up -d postgres` |
| `yarn test:chaos` | Starts the stack with `docker-compose.chaos.yml` (all failure modes on), then: 200+ checks, ~20% cancelled, one API instance killed and restarted mid-run, then verifies the POS | Docker |

The chaos test takes a few minutes: the POS allows 5 requests / 10 s per restaurant, so it is throughput-bound by design ([why](docs/rate-limiting.md#throughput-cost-affects-the-chaos-test)).

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
