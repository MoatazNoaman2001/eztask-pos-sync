// Stop: Claude may not finish its turn while `yarn verify` (typecheck + lint + tests) fails.
import { block, readEvent, run, tail } from './lib.mjs';

const event = await readEvent();

// Already sent back once for this turn: let it stop, so a check it cannot fix
// (e.g. Postgres not running) never traps it in an endless loop.
if (event.stop_hook_active) process.exit(0);

// Nothing changed in code or config: a pure Q&A turn, skip the slow checks.
const status = run('git', ['status', '--porcelain', '--', 'apps', 'test', 'package.json', 'yarn.lock', 'tsconfig.base.json', 'eslint.config.mjs']);
if (status.ok && status.output.trim() === '') process.exit(0);

const verify = run('yarn', ['verify']);
if (!verify.ok) {
  block(`\`yarn verify\` fails. Fix it before finishing (or tell the user why you can't):\n${tail(verify.output)}`);
}
