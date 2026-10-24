// PreToolUse (Bash): refuse commands that destroy work, data or history, or skip our checks.
import { block, readEvent } from './lib.mjs';

const rules = [
  { pattern: /\brm\s+-[a-z]*(rf|fr)[a-z]*\b/i, reason: 'rm -rf deletes files with no undo. Delete specific files instead.' },
  { pattern: /\bgit\s+push\b.*(--force\b|--force-with-lease\b|\s-f(\s|$))/, reason: 'Force push rewrites shared history. The reviewers read our history: never rewrite it.' },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: 'git reset --hard throws away uncommitted work.' },
  { pattern: /\bgit\s+commit\b.*--amend\b/, reason: 'Amending rewrites history. Make a new commit instead.' },
  { pattern: /\bgit\s+rebase\b/, reason: 'Rebasing rewrites history. The spec says keep the full commit history.' },
  { pattern: /\bgit\s+clean\s+-[a-z]*f/, reason: 'git clean -f deletes untracked files with no undo.' },
  { pattern: /--no-verify\b/, reason: '--no-verify skips the pre-commit checks. Fix the failing check instead.' },
  { pattern: /\bdocker\s+compose\b.*\bdown\b.*(\s-v\b|--volumes\b)/, reason: 'docker compose down -v wipes the database volume. Ask the user first.' },
  { pattern: /\bdrizzle-kit\s+(push|drop)\b/, reason: 'drizzle-kit push/drop changes the schema without a migration. Use `yarn db:generate` and commit the migration.' },
];

const event = await readEvent();
const command = event.tool_input?.command ?? '';

for (const { pattern, reason } of rules) {
  if (pattern.test(command)) {
    block(`Blocked by .claude/hooks/block-dangerous-commands.mjs: ${reason}`);
  }
}
