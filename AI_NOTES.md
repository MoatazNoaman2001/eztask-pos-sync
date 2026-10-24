# AI notes

Moments where Claude was wrong or was overruled, and how it was noticed. Kept short and honest.

## 1. `yarn check` silently ran the wrong command

**What happened:** Claude named the combined script `check` and wired it into the pre-commit hook, CI and the Stop hook. In Yarn 1, `check` is a **built-in** command (it verifies `node_modules`), and built-ins win over `package.json` scripts. So all three ran the built-in, which always passed, and none of them ever type-checked, linted or tested anything.

**How it was noticed:** while testing the Stop hook, Claude fed it a file with a deliberate type error and expected it to block. It let the change through. Running the hook's command by hand printed `success Folder in sync.`, which is the built-in's output, not our script's.

**Fix / rule added:** renamed the script to `yarn verify` everywhere. Every hook is now tested with a known-bad input, not just a good one: a check that has never failed has not been shown to work.

## 2. "Stop after ~10 failed attempts" would have broken guarantee 2

**What happened:** during design Claude recommended marking a sync `failed` after about 10 temporary errors (500s, timeouts).

**How it was noticed:** writing the retry policy against the guarantees, it collided with guarantee 2 ("every paid check eventually reaches the POS"). A 15-minute POS outage would leave paid orders that never reach the kitchen. The spec only allows stopping on a permanent rejection (422).

**Fix / rule added:** temporary errors retry forever with backoff capped at 60 s; visibility through `attempts` and `last_error`. Added to `CLAUDE.md` rule 8: "never add a max-attempts cutoff".

## 3. Two rate-limiter bugs that every test passed over

**What happened:** Claude wrote the shared rate limiter in SQL with two mistakes.
1. A fragment `now() - 10s` was embedded in `min(sent_at) - ${windowStart}` without brackets, so Postgres computed `min(sent_at) - now() - 10s`. The "wait until a slot frees" came out negative and was clamped to 1 ms: a rate-limited row would retry immediately, again and again.
2. It used `now()`, which in Postgres is the time the *transaction started*. A call that waited on the restaurant's lock logged its request too early, so the window could expire too soon and let more requests through than our limit of 4 per 10 s.

**How it was noticed:** the first test only asserted `retryInMs > 0`, and passed. A worker test then saw a postponed row due "now" instead of ~10 s later. Tightening the assertion to "between 9 and 10 s" exposed bug 2 as a flaky 10001 ms under concurrency.

**Fix / rule added:** brackets around the fragment, `clock_timestamp()` instead of `now()` in the limiter. `CLAUDE.md` rule 6 now says when `now()` is wrong. And the general lesson: assert the *value* that matters, not just its sign.
