// PostToolUse (Edit/Write): type-check and lint right after a TypeScript file changes,
// so Claude fixes mistakes while the edit is fresh instead of at commit time.
import { block, readEvent, relativePath, run, tail } from './lib.mjs';

const event = await readEvent();
const filePath = event.tool_input?.file_path;
if (!filePath) process.exit(0);

const rel = relativePath(filePath);
const app = rel.match(/^apps\/([^/]+)\/.+\.ts$/)?.[1];
if (!app) process.exit(0);

const typecheck = run('node', ['node_modules/typescript/bin/tsc', '-p', `apps/${app}/tsconfig.json`, '--noEmit']);
if (!typecheck.ok) {
  block(`Type errors in apps/${app} after editing ${rel}:\n${tail(typecheck.output)}`);
}

const lint = run('node', ['node_modules/eslint/bin/eslint.js', rel]);
if (!lint.ok) {
  block(`Lint errors in ${rel}:\n${tail(lint.output)}`);
}
