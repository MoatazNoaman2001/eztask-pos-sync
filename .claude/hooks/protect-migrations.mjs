// PreToolUse (Edit/Write): migration files are generated, never hand-written or hand-edited.
// An applied migration that changes later silently diverges from every database that already ran it.
import { block, readEvent, relativePath } from './lib.mjs';

const event = await readEvent();
const filePath = event.tool_input?.file_path;
if (!filePath) process.exit(0);

const rel = relativePath(filePath);

if (rel.startsWith('apps/api/drizzle/')) {
  block(
    `Blocked by .claude/hooks/protect-migrations.mjs: ${rel} is a generated migration.\n` +
      'Change apps/api/src/db/schema.ts, then run `yarn db:generate` to create a new migration.',
  );
}
