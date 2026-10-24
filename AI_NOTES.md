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

## 3. _(to be filled while building)_
