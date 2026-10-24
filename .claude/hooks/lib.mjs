// Shared helpers for Claude Code hooks.
// Contract: Claude sends the hook event as JSON on stdin. Exit code 2 = block,
// and whatever we write to stderr is shown to Claude so it can fix the problem.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

export async function readEvent() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

export function block(message) {
  process.stderr.write(message.trim() + '\n');
  process.exit(2);
}

// Project-relative path with forward slashes, so rules work the same on Windows.
export function relativePath(filePath) {
  return path.relative(projectDir, path.resolve(projectDir, filePath)).split(path.sep).join('/');
}

export function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectDir,
    encoding: 'utf8',
    shell: process.platform === 'win32', // yarn is a .cmd shim on Windows
  });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

// Keep feedback short: Claude needs the errors, not 500 lines of log.
export function tail(text, lines = 40) {
  return text.trim().split('\n').slice(-lines).join('\n');
}
