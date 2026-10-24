// Creates or completes .env for local development from the keys in local.env.
// - No .env yet: writes one with every key filled in.
// - .env exists: adds the keys it is missing and fills keys left empty. Values already set are
//   never changed.
// - Generates a random database password, so no credentials live in the repo.
// - Picks free host ports (a local Postgres often already uses 5432, a dev server 3000…).
// - Fails if local.env has a key this script doesn't know, so the two can't drift apart.
//
// Usage: yarn setup            (writes .env)
//        yarn setup --out FILE (writes elsewhere; used to test this script)
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outIndex = process.argv.indexOf('--out');
const outPath = outIndex === -1 ? path.join(root, '.env') : path.resolve(process.argv[outIndex + 1] ?? '');
const shownPath = path.relative(root, outPath) || outPath;

const template = readFileSync(path.join(root, 'local.env'), 'utf8');
const templateKeys = [...template.matchAll(/^([A-Z0-9_]+)=$/gm)].map((match) => match[1]);
const existing = existsSync(outPath) ? parseEnv(readFileSync(outPath, 'utf8')) : null;
// Keys that may legitimately be empty (empty = use the built-in fallback).
const MAY_BE_EMPTY = new Set(['INSTANCE_ID']);
const isSet = (key) => existing !== null && key in existing && (existing[key] !== '' || MAY_BE_EMPTY.has(key));
const missing = templateKeys.filter((key) => !isSet(key));

if (missing.length === 0) {
  console.log(`${shownPath} already has every key from local.env, leaving it unchanged.`);
  process.exit(0);
}

// Local development values. Meanings: docs/configuration.md
// Lazy, so we only probe ports and generate secrets for keys we actually need to add.
const known = {
  POSTGRES_USER: () => 'eztask',
  POSTGRES_PASSWORD: () => randomBytes(16).toString('hex'),
  POSTGRES_DB: () => 'eztask',
  POSTGRES_HOST_PORT: () => findFreePort(5432),
  LB_HOST_PORT: () => findFreePort(3000),
  PORT: () => 3000,
  INSTANCE_ID: () => '', // empty = hostname + pid
  DATABASE_URL: async () =>
    `postgres://${await get('POSTGRES_USER')}:${await get('POSTGRES_PASSWORD')}@localhost:${await get('POSTGRES_HOST_PORT')}/${await get('POSTGRES_DB')}`,
  POS_BASE_URL: async () => `http://localhost:${await get('FAKE_POS_PORT')}`,
  POS_HTTP_TIMEOUT_MS: () => 10000,
  SYNC_LEASE_MS: () => 30000,
  SYNC_WORKER_ENABLED: () => 'true',
  SYNC_POLL_INTERVAL_MS: () => 1000,
  SYNC_BATCH_SIZE: () => 10,
  RATE_LIMIT_MAX_REQUESTS: () => 4,
  RATE_LIMIT_WINDOW_MS: () => 10000,
  FAKE_POS_PORT: () => findFreePort(4000),
  FAIL_RATE: () => 0,
  TIMEOUT_AFTER_CREATE_RATE: () => 0,
  SLOW_RATE: () => 0,
  CHAOS_FAIL_RATE: () => 0.2,
  CHAOS_TIMEOUT_AFTER_CREATE_RATE: () => 0.1,
  CHAOS_SLOW_RATE: () => 0.1,
};

const unknown = templateKeys.filter((key) => !(key in known));
if (unknown.length > 0) {
  console.error(`local.env has keys with no local value in scripts/setup-env.mjs: ${unknown.join(', ')}`);
  process.exit(1);
}

// Values already in .env win, so derived values (DATABASE_URL…) stay consistent with them.
const resolved = new Map();
function get(key) {
  if (isSet(key)) return existing[key];
  if (!resolved.has(key)) resolved.set(key, Promise.resolve(known[key]()));
  return resolved.get(key);
}

if (!existing) {
  // Keep local.env's comments and order; only fill in `KEY=` lines.
  let filled = template;
  for (const key of templateKeys) {
    filled = filled.replace(new RegExp(`^${key}=$`, 'm'), `${key}=${await get(key)}`);
  }
  writeFileSync(outPath, filled);
  console.log(`Wrote ${shownPath}.`);
} else {
  let text = readFileSync(outPath, 'utf8');
  const appended = [];
  for (const key of missing) {
    const line = `${key}=${await get(key)}`;
    // Empty in .env: fill that line in place. Absent: append it.
    if (key in existing) text = text.replace(new RegExp(`^${key}=$`, 'm'), line);
    else appended.push(line);
  }
  if (appended.length > 0) {
    text = text.replace(/\n*$/, '\n') + `\n# Added by yarn setup\n${appended.join('\n')}\n`;
  }
  writeFileSync(outPath, text);
  // Names only: values may be secrets.
  console.log(`Completed ${shownPath}: ${missing.join(', ')}`);
}

function parseEnv(text) {
  return Object.fromEntries(
    [...text.matchAll(/^([A-Z0-9_]+)=(.*)$/gm)].map((match) => [match[1], match[2]]),
  );
}

// "Free" = nothing answers on localhost at that port, over IPv4 or IPv6.
// We probe by connecting rather than binding: Windows lets a wildcard bind succeed even when
// another process (e.g. Docker or a local Postgres) already serves that port.
async function findFreePort(start) {
  for (let port = start; port < start + 100; port++) {
    if (!(await isAnswering(port, '127.0.0.1')) && !(await isAnswering(port, '::1'))) return port;
  }
  throw new Error(`No free port found between ${start} and ${start + 99}`);
}

function isAnswering(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (answering) => {
      socket.destroy();
      resolve(answering);
    };
    socket.setTimeout(500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
