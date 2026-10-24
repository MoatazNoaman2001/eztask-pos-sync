// Creates .env for local development from the keys in local.env.
// - Never overwrites an existing .env (it may hold your own values).
// - Generates a random database password, so no credentials live in the repo.
// - Picks a free host port for Postgres (a local Postgres often already uses 5432).
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

if (existsSync(outPath)) {
  console.log(`${path.relative(root, outPath) || outPath} already exists, leaving it unchanged.`);
  process.exit(0);
}

const postgres = {
  user: 'eztask',
  password: randomBytes(16).toString('hex'),
  db: 'eztask',
  hostPort: await findFreePort(5432),
};
const fakePosPort = 4000;

// Local development values. Meanings: docs/configuration.md
const values = {
  POSTGRES_USER: postgres.user,
  POSTGRES_PASSWORD: postgres.password,
  POSTGRES_DB: postgres.db,
  POSTGRES_HOST_PORT: postgres.hostPort,
  PORT: 3000,
  INSTANCE_ID: '', // empty = hostname + pid
  DATABASE_URL: `postgres://${postgres.user}:${postgres.password}@localhost:${postgres.hostPort}/${postgres.db}`,
  POS_BASE_URL: `http://localhost:${fakePosPort}`,
  POS_HTTP_TIMEOUT_MS: 10000,
  SYNC_LEASE_MS: 30000,
  SYNC_WORKER_ENABLED: 'true',
  SYNC_POLL_INTERVAL_MS: 1000,
  SYNC_BATCH_SIZE: 10,
  RATE_LIMIT_MAX_REQUESTS: 4,
  RATE_LIMIT_WINDOW_MS: 10000,
  FAKE_POS_PORT: fakePosPort,
  FAIL_RATE: 0,
  TIMEOUT_AFTER_CREATE_RATE: 0,
  SLOW_RATE: 0,
};

const template = readFileSync(path.join(root, 'local.env'), 'utf8');
const unknown = [];

// Keep local.env's comments and order; only fill in `KEY=` lines.
const filled = template.replace(/^([A-Z0-9_]+)=$/gm, (line, key) => {
  if (!(key in values)) {
    unknown.push(key);
    return line;
  }
  return `${key}=${values[key]}`;
});

if (unknown.length > 0) {
  console.error(`local.env has keys with no local value in scripts/setup-env.mjs: ${unknown.join(', ')}`);
  process.exit(1);
}

writeFileSync(outPath, filled);
console.log(`Wrote ${path.relative(root, outPath) || outPath} (Postgres on host port ${postgres.hostPort}).`);

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
