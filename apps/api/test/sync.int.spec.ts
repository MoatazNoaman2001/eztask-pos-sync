import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { posRequestLog, posSync } from '../src/db/schema';
import { PosSyncRepository } from '../src/sync/repositories/pos-sync.repository';
import { RateLimitRepository } from '../src/sync/repositories/rate-limit.repository';
import { SyncWorker } from '../src/sync/sync.worker';
import { startTestPos, TestPos } from './support/fake-pos';
import { createTestApp, TestApp, truncateAll } from './support/test-app';

/**
 * The sync worker against real Postgres and the real fake POS over HTTP.
 * Failures are switched on by the test (StubChaos), never left to chance.
 * Each test ends by checking the POS itself, like the chaos test does.
 */
describe('Sync worker (integration)', () => {
  let pos: TestPos;
  let t: TestApp;
  let worker: SyncWorker;

  beforeAll(async () => {
    pos = await startTestPos();
    t = await createTestApp({
      POS_BASE_URL: pos.url,
      POS_HTTP_TIMEOUT_MS: '300', // short, so "hang after create" turns into a timeout quickly
      SYNC_LEASE_MS: '5000',
      RATE_LIMIT_MAX_REQUESTS: '4',
      RATE_LIMIT_WINDOW_MS: '10000',
    });
    worker = t.app.get(SyncWorker);
  });

  afterAll(async () => {
    await t.close();
    await pos.close();
  });

  beforeEach(async () => {
    await truncateAll(t.db);
    await pos.reset();
  });

  // ---- helpers ----

  async function paidCheck(restaurantId = 'r1', total = 90): Promise<string> {
    const body = { restaurantId, items: [{ name: 'Koshary', quantity: 1, unitPrice: total }], total };
    const res = await request(t.server).post('/checks').send(body).expect(201);
    const id = (res.body as { id: string }).id;
    await request(t.server).post(`/checks/${id}/pay`).expect(200);
    return id;
  }

  async function sync(checkId: string) {
    const [row] = await t.db.select().from(posSync).where(eq(posSync.checkId, checkId));
    if (!row) throw new Error(`no sync row for ${checkId}`);
    return row;
  }

  /** Skip the backoff wait: make every unfinished row due now. */
  async function makeAllDue(): Promise<void> {
    await t.db.update(posSync).set({ nextAttemptAt: sql`now()` });
  }

  async function ordersFor(checkId: string) {
    return (await pos.orders()).filter((order) => order.externalRef === checkId);
  }

  async function openOrdersFor(checkId: string) {
    return (await ordersFor(checkId)).filter((order) => order.status === 'open');
  }

  // ---- happy path ----

  it('delivers a paid check: exactly one open POS order, sync marked synced', async () => {
    const id = await paidCheck();
    await worker.processDue();

    const [order] = await openOrdersFor(id);
    expect(await ordersFor(id)).toHaveLength(1);
    expect(await sync(id)).toMatchObject({
      status: 'synced',
      posState: 'created',
      posOrderId: order?.posOrderId,
      leaseOwner: null,
    });
  });

  // ---- guarantee 2: none lost, none duplicated ----

  it('POS creates the order but the response times out: looks it up, never creates twice', async () => {
    const id = await paidCheck();
    pos.chaos.hangNextCreate = true;

    await worker.processDue(); // create times out after 300 ms, while the POS already holds the order
    expect(await sync(id)).toMatchObject({ status: 'retrying', posState: 'unknown', attempts: 1 });
    expect((await sync(id)).lastError).toContain('timeout');

    pos.chaos.hangNextCreate = false;
    pos.chaos.release();
    await makeAllDue();
    await worker.processDue(); // lookup finds the order and adopts it

    expect(await ordersFor(id)).toHaveLength(1);
    expect(await sync(id)).toMatchObject({ status: 'synced', posState: 'created' });
  });

  it('POS answers 500: retries with backoff, then delivers exactly one order', async () => {
    const id = await paidCheck();
    pos.chaos.failNext = true;

    await worker.processDue();
    const failed = await sync(id);
    expect(failed).toMatchObject({ status: 'retrying', attempts: 1, posState: 'unknown' });
    expect(failed.lastError).toContain('POS 500');
    expect(failed.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    pos.chaos.failNext = false;
    await makeAllDue();
    await worker.processDue();

    expect(await ordersFor(id)).toHaveLength(1);
    expect(await sync(id)).toMatchObject({ status: 'synced' });
  });

  it('instance killed mid-create (order exists, lease expired): next worker adopts it', async () => {
    const id = await paidCheck();
    // What a killed worker leaves behind: it committed 'unknown', sent the create, then died.
    await request(pos.url)
      .post('/orders')
      .send({ externalRef: id, restaurantId: 'r1', items: [], total: 90 })
      .expect(201);
    await t.db
      .update(posSync)
      .set({ posState: 'unknown', leaseOwner: 'dead-instance', leaseUntil: sql`now() - interval '1 second'` })
      .where(eq(posSync.checkId, id));

    await worker.processDue();

    expect(await ordersFor(id)).toHaveLength(1);
    expect(await sync(id)).toMatchObject({ status: 'synced', posState: 'created' });
  });

  it('two workers polling at the same time never deliver a check twice', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(await paidCheck(`r${i % 5}`));

    await Promise.all([worker.processDue('instance-a'), worker.processDue('instance-b')]);
    await Promise.all([worker.processDue('instance-a'), worker.processDue('instance-b')]);

    for (const id of ids) {
      expect(await ordersFor(id)).toHaveLength(1);
      expect((await sync(id)).status).toBe('synced');
    }
  });

  it('a worker that lost its lease cannot overwrite the new owner', async () => {
    const id = await paidCheck();
    const repo = t.app.get(PosSyncRepository);

    await repo.claimDue('slow-instance', 5000, 10);
    await t.db.update(posSync).set({ leaseUntil: sql`now() - interval '1 second'` }); // its lease expires
    await repo.claimDue('new-instance', 5000, 10);

    expect(await repo.recordPosState(id, 'slow-instance', 'created', 'stale')).toBe(false);
    expect(await repo.markSynced(id, 'slow-instance', 'present')).toBe(false);
    expect(await sync(id)).toMatchObject({ leaseOwner: 'new-instance', posOrderId: null, status: 'pending' });
  });

  it('a cancel landing mid-step is never overwritten by the worker (risk A5)', async () => {
    const id = await paidCheck();
    const repo = t.app.get(PosSyncRepository);
    await repo.claimDue('instance-a', 5000, 10);

    // The worker decided "done" while desired was 'present'; a cancel lands before it writes.
    await request(t.server).post(`/checks/${id}/cancel`).expect(200);

    expect(await repo.markSynced(id, 'instance-a', 'present')).toBe(false);
    expect(await sync(id)).toMatchObject({ desired: 'absent', status: 'pending' });
  });

  // ---- guarantee 3: order of events ----

  it('cancelled before the create was sent: nothing ever reaches the POS', async () => {
    const id = await paidCheck();
    await request(t.server).post(`/checks/${id}/cancel`).expect(200);

    await worker.processDue();

    expect(await ordersFor(id)).toHaveLength(0);
    expect(await t.db.select().from(posRequestLog)).toHaveLength(0); // not even a lookup
    expect(await sync(id)).toMatchObject({ status: 'synced', desired: 'absent', posState: 'none' });
  });

  it('cancelled after delivery: the POS order gets cancelled', async () => {
    const id = await paidCheck();
    await worker.processDue();
    await request(t.server).post(`/checks/${id}/cancel`).expect(200);
    await worker.processDue();

    expect(await openOrdersFor(id)).toHaveLength(0);
    expect(await ordersFor(id)).toHaveLength(1);
    expect(await sync(id)).toMatchObject({ status: 'synced', desired: 'absent', posState: 'cancelled' });
  });

  it('cancelled while the create outcome is unknown: looks up, then cancels what exists', async () => {
    const id = await paidCheck();
    pos.chaos.hangNextCreate = true;
    await worker.processDue(); // times out; the POS holds an open order
    pos.chaos.hangNextCreate = false;
    pos.chaos.release();

    await request(t.server).post(`/checks/${id}/cancel`).expect(200);
    await worker.processDue();

    expect(await openOrdersFor(id)).toHaveLength(0);
    expect(await sync(id)).toMatchObject({ status: 'synced', desired: 'absent', posState: 'cancelled' });
  });

  // ---- guarantee 4: rate limit ----

  it('sends at most 4 requests per restaurant per window; a busy restaurant does not delay others', async () => {
    const busy: string[] = [];
    for (let i = 0; i < 6; i++) busy.push(await paidCheck('busy'));
    const quiet = await paidCheck('quiet');

    await worker.processDue();

    const synced: boolean[] = [];
    for (const id of busy) synced.push((await sync(id)).status === 'synced');
    expect(synced.filter(Boolean)).toHaveLength(4);
    for (const id of busy.filter((_id, i) => !synced[i])) {
      const row = await sync(id);
      expect(row).toMatchObject({ status: 'pending', attempts: 0 }); // postponed, not a failure
      expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    }
    expect((await sync(quiet)).status).toBe('synced');
  });

  it('the limit holds when many workers ask at the same moment (shared through Postgres)', async () => {
    const limiter = t.app.get(RateLimitRepository);
    const results = await Promise.all(Array.from({ length: 10 }, () => limiter.tryAcquire('r1', 4, 10_000)));

    expect(results.filter((r) => r.acquired)).toHaveLength(4);
    // Refused callers must wait until the oldest request leaves the window: close to the full
    // 10 s here, never "retry now" (a precedence bug once made this 1 ms).
    for (const r of results) {
      if (!r.acquired) {
        expect(r.retryInMs).toBeGreaterThan(9_000);
        expect(r.retryInMs).toBeLessThanOrEqual(10_000);
      }
    }
  });

  // ---- guarantee 5: permanent failures stop and are visible ----

  it('422 stops retrying, shows the reason, and can be retried by hand', async () => {
    const id = await paidCheck('r1', 0);

    await worker.processDue();
    const failed = await sync(id);
    expect(failed).toMatchObject({ status: 'failed', posState: 'none' });
    expect(failed.lastError).toContain('422');

    await makeAllDue();
    await worker.processDue(); // a failed row is never picked up again on its own
    expect(await t.db.select().from(posRequestLog)).toHaveLength(1);

    await request(t.server).post(`/checks/${id}/sync/retry`).expect(202);
    await worker.processDue();
    expect(await t.db.select().from(posRequestLog)).toHaveLength(2); // tried again, rejected again
    expect((await sync(id)).status).toBe('failed');
    expect(await ordersFor(id)).toHaveLength(0);
  });
});
