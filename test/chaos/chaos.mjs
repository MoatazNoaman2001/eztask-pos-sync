// Chaos test (spec deliverable 3). Run with: yarn test:chaos
//
// With every POS failure mode on and two API instances running:
//   creates 220 checks over 10 restaurants, pays all of them, cancels ~20%,
//   kills api-1 mid-run and restarts it, waits until every sync settles, then checks the POS:
//   1. every paid, non-cancelled check has exactly one open POS order
//   2. every cancelled check has no open POS order
//   3. no POS order exists that does not belong to one of our checks
//
// It only talks to the system from outside: HTTP through the load balancer, the POS's
// /debug endpoints, and `docker compose`. Exit code 0 = all three hold.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHECKS = 220;
const RESTAURANTS = 10;
const CANCEL_SHARE = 0.2;
const CONCURRENCY = 20;
const SETTLE_TIMEOUT_MS = 10 * 60_000;
const COMPOSE_FILES = ['-f', 'docker-compose.yml', '-f', 'docker-compose.chaos.yml'];

const root = path.resolve(import.meta.dirname, '../..');
process.loadEnvFile(path.join(root, '.env')); // ports and chaos rates, written by `yarn setup`
const API = `http://localhost:${process.env.LB_HOST_PORT}`;
const POS = `http://localhost:${process.env.FAKE_POS_PORT}`;

const started = Date.now();
const log = (message) => console.log(`[${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s] ${message}`);

try {
  await main();
} finally {
  // Leave the stack as we found it: failure modes off.
  log('restoring the normal stack (failure modes off)');
  compose(['up', '-d', '--wait'], { chaos: false });
}

async function main() {
  log(
    `starting the stack with failure modes on: FAIL_RATE=${process.env.CHAOS_FAIL_RATE} ` +
      `TIMEOUT_AFTER_CREATE_RATE=${process.env.CHAOS_TIMEOUT_AFTER_CREATE_RATE} SLOW_RATE=${process.env.CHAOS_SLOW_RATE}`,
  );
  compose(['up', '-d', '--build', '--wait']);

  log('starting from an empty POS and an empty database');
  await request('POST', `${POS}/debug/reset`);
  compose(['exec', '-T', 'postgres', 'sh', '-c',
    'psql -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "TRUNCATE checks, pos_sync, pos_rate_limit, pos_request_log CASCADE"']);

  // ---- traffic, with api-1 killed in the middle ----
  const checks = Array.from({ length: CHECKS }, (_, i) => ({
    index: i,
    restaurantId: `chaos-r${i % RESTAURANTS}`,
    cancel: Math.random() < CANCEL_SHARE,
    id: '',
  }));

  log(`creating and paying ${CHECKS} checks across ${RESTAURANTS} restaurants`);
  let killed = false;
  await pool(checks, CONCURRENCY, async (check) => {
    if (!killed && check.index >= CHECKS / 2) {
      killed = true;
      log('KILL api-1 (SIGKILL, mid-run)');
      compose(['kill', 'api-1']);
      // Restart a little later, while traffic and sync keep going through api-2.
      void sleep(8_000).then(() => {
        log('RESTART api-1');
        compose(['start', 'api-1']);
      });
    }

    const total = 50 + (check.index % 7) * 10;
    const created = await request('POST', `${API}/checks`, {
      restaurantId: check.restaurantId,
      items: [{ name: `item-${check.index}`, quantity: 1, unitPrice: total }],
      total,
    });
    check.id = created.id;
    await request('POST', `${API}/checks/${check.id}/pay`);

    // Half the cancels right away (usually before the create reached the POS),
    // half a few seconds later (usually after it did): both orders of events get exercised.
    if (check.cancel) {
      if (check.index % 2 === 0) await request('POST', `${API}/checks/${check.id}/cancel`);
      else void sleep(3_000 + Math.random() * 5_000).then(() => request('POST', `${API}/checks/${check.id}/cancel`));
    }
  });
  await sleep(9_000); // let the delayed cancels and the restart happen
  const cancelled = checks.filter((check) => check.cancel).length;
  log(`traffic done: ${CHECKS} paid, ${cancelled} cancelled`);

  // ---- wait until every check's sync is finished ----
  await waitUntilSettled(checks);

  // ---- verify the POS ----
  const orders = await request('GET', `${POS}/debug/orders`);
  const failures = verify(checks, orders);

  log(`POS holds ${orders.length} orders (${orders.filter((o) => o.status === 'open').length} open)`);
  if (failures.length > 0) {
    console.error(`\nFAILED: ${failures.length} problem(s)`);
    for (const failure of failures.slice(0, 20)) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  log('PASSED: every paid check has exactly one open POS order, cancelled checks have none, no stray orders');
}

async function waitUntilSettled(checks) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const views = await pool(checks, CONCURRENCY, (check) => request('GET', `${API}/checks/${check.id}/sync`));
    const counts = {};
    for (const view of views) counts[view.status] = (counts[view.status] ?? 0) + 1;
    log(`sync status: ${JSON.stringify(counts)}`);

    if (views.every((view) => view.status === 'synced')) return;
    const failed = views.filter((view) => view.status === 'failed');
    if (failed.length > 0) {
      throw new Error(`${failed.length} sync(s) failed permanently, e.g. ${failed[0].checkId}: ${failed[0].lastError}`);
    }
    if (Date.now() > deadline) throw new Error('timed out waiting for every sync to settle');
    await sleep(5_000);
  }
}

function verify(checks, orders) {
  const failures = [];
  const ours = new Set(checks.map((check) => check.id));

  for (const check of checks) {
    const open = orders.filter((order) => order.externalRef === check.id && order.status === 'open');
    if (!check.cancel && open.length !== 1) {
      failures.push(`paid check ${check.id} has ${open.length} open POS orders (expected exactly 1)`);
    }
    if (check.cancel && open.length !== 0) {
      failures.push(`cancelled check ${check.id} still has ${open.length} open POS order(s)`);
    }
  }
  for (const order of orders) {
    if (!ours.has(order.externalRef)) failures.push(`POS order ${order.posOrderId} belongs to no check of ours`);
  }
  return failures;
}

// ---- helpers ----

function compose(args, { chaos = true } = {}) {
  const files = chaos ? COMPOSE_FILES : ['-f', 'docker-compose.yml'];
  const result = spawnSync('docker', ['compose', ...files, ...args], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`docker compose ${args.join(' ')} failed:\n${result.stderr}`);
}

/**
 * JSON over HTTP. Retries when the request may not have been handled (connection refused,
 * 502/503/504 from nginx while an instance is down). Safe for everything we send:
 * /pay and /cancel are no-ops when repeated, and a duplicated POST /checks only leaves an
 * unpaid check that never reaches the POS.
 */
async function request(method, url, body) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
      if (![502, 503, 504].includes(response.status)) {
        if (!response.ok) throw new Error(`${method} ${url} → ${response.status}: ${await response.text()}`);
        return response.status === 204 ? undefined : response.json();
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes(' → ')) throw error; // a real HTTP error
      if (attempt >= 10) throw error;
    }
    await sleep(500 * attempt);
  }
}

async function pool(items, size, work) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: size }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}
