import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { checks, posSync } from '../src/db/schema';
import { SyncView } from '../src/sync/types/sync-view';
import { createTestApp, TestApp, truncateAll } from './support/test-app';

// Real HTTP against the real app and a real Postgres. No mocks.
describe('Checks API (integration)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await truncateAll(t.db);
  });

  const newCheck = { restaurantId: 'r1', items: [{ name: 'Koshary', quantity: 2, unitPrice: 45 }], total: 90 };

  async function createCheck(body: object = newCheck): Promise<string> {
    const res = await request(t.server).post('/checks').send(body).expect(201);
    return (res.body as { id: string }).id;
  }

  async function syncRow(checkId: string) {
    const [row] = await t.db.select().from(posSync).where(eq(posSync.checkId, checkId));
    return row;
  }

  async function checkStatus(checkId: string) {
    const [row] = await t.db.select().from(checks).where(eq(checks.id, checkId));
    return row?.status;
  }

  describe('POST /checks', () => {
    it('creates an open check', async () => {
      const res = await request(t.server).post('/checks').send(newCheck).expect(201);
      expect(res.body).toMatchObject({ restaurantId: 'r1', total: 90, status: 'open' });
    });

    it('accepts total <= 0, so the POS can reject it with 422 later', async () => {
      await request(t.server).post('/checks').send({ ...newCheck, total: 0 }).expect(201);
    });

    it.each([
      ['missing restaurantId', { items: newCheck.items, total: 90 }],
      ['no items', { ...newCheck, items: [] }],
      ['item with quantity 0', { ...newCheck, items: [{ name: 'x', quantity: 0, unitPrice: 1 }] }],
      ['total as a string', { ...newCheck, total: '90' }],
    ])('rejects %s with 400', async (_case, body) => {
      await request(t.server).post('/checks').send(body).expect(400);
    });
  });

  describe('POST /checks/:id/pay', () => {
    it('marks the check paid and writes its outbox row in the same transaction', async () => {
      const id = await createCheck();
      await request(t.server).post(`/checks/${id}/pay`).expect(200);

      expect(await checkStatus(id)).toBe('paid');
      expect(await syncRow(id)).toMatchObject({
        restaurantId: 'r1',
        desired: 'present',
        posState: 'none',
        status: 'pending',
        attempts: 0,
      });
    });

    it('answers well under 300 ms: it never waits for the POS (guarantee 1)', async () => {
      const id = await createCheck();
      const started = Date.now();
      await request(t.server).post(`/checks/${id}/pay`).expect(200);
      expect(Date.now() - started).toBeLessThan(300);
    });

    it('is a no-op when paid twice: still exactly one outbox row', async () => {
      const id = await createCheck();
      await request(t.server).post(`/checks/${id}/pay`).expect(200);
      await request(t.server).post(`/checks/${id}/pay`).expect(200);

      const rows = await t.db.select().from(posSync).where(eq(posSync.checkId, id));
      expect(rows).toHaveLength(1);
    });

    it('refuses to pay a cancelled check with 409', async () => {
      const id = await createCheck();
      await request(t.server).post(`/checks/${id}/cancel`).expect(200);
      await request(t.server).post(`/checks/${id}/pay`).expect(409);
      expect(await syncRow(id)).toBeUndefined();
    });

    it('answers 404 for an unknown check and 400 for a malformed id', async () => {
      await request(t.server).post('/checks/00000000-0000-4000-8000-000000000000/pay').expect(404);
      await request(t.server).post('/checks/not-a-uuid/pay').expect(400);
    });
  });

  describe('POST /checks/:id/cancel', () => {
    it('cancels an open check without creating any outbox row (the POS never hears of it)', async () => {
      const id = await createCheck();
      await request(t.server).post(`/checks/${id}/cancel`).expect(200);

      expect(await checkStatus(id)).toBe('cancelled');
      expect(await syncRow(id)).toBeUndefined();
    });

    it('cancels a paid check by flipping desired to absent and waking the row', async () => {
      const id = await createCheck();
      await request(t.server).post(`/checks/${id}/pay`).expect(200);
      await request(t.server).post(`/checks/${id}/cancel`).expect(200);

      expect(await syncRow(id)).toMatchObject({ desired: 'absent', status: 'pending' });
    });

    it('never touches worker-owned columns (column ownership, risk A5)', async () => {
      const id = await createCheck();
      await request(t.server).post(`/checks/${id}/pay`).expect(200);
      // Pretend a worker already delivered the order.
      await t.db
        .update(posSync)
        .set({ posState: 'created', posOrderId: 'pos-77', status: 'synced', attempts: 2 })
        .where(eq(posSync.checkId, id));

      await request(t.server).post(`/checks/${id}/cancel`).expect(200);

      expect(await syncRow(id)).toMatchObject({
        desired: 'absent',
        status: 'pending',
        posState: 'created',
        posOrderId: 'pos-77',
        attempts: 2,
      });
    });

    it('is a no-op when cancelled twice', async () => {
      const id = await createCheck();
      await request(t.server).post(`/checks/${id}/cancel`).expect(200);
      await request(t.server).post(`/checks/${id}/cancel`).expect(200);
    });
  });

  describe('concurrent /pay and /cancel on the same check', () => {
    it('always ends in a consistent state (row lock serialises them)', async () => {
      const ids = await Promise.all(Array.from({ length: 20 }, () => createCheck()));

      await Promise.all(
        ids.flatMap((id) => [
          request(t.server).post(`/checks/${id}/pay`),
          request(t.server).post(`/checks/${id}/cancel`),
        ]),
      );

      for (const id of ids) {
        const status = await checkStatus(id);
        const row = await syncRow(id);
        // Either cancel won (never paid, no outbox row), or pay won and cancel followed it.
        expect(status).toBe('cancelled');
        if (row) expect(row.desired).toBe('absent');
      }
    });
  });

  describe('GET /checks/:id/sync', () => {
    it('reports not_required for a check that was never paid', async () => {
      const id = await createCheck();
      const res = await request(t.server).get(`/checks/${id}/sync`).expect(200);
      expect((res.body as SyncView).status).toBe('not_required');
    });

    it('reports pending right after payment', async () => {
      const id = await createCheck();
      await request(t.server).post(`/checks/${id}/pay`).expect(200);

      const res = await request(t.server).get(`/checks/${id}/sync`).expect(200);
      expect(res.body).toMatchObject({ checkId: id, status: 'pending', desired: 'present', posState: 'none' });
    });

    it('derives in_progress from a live lease instead of storing it', async () => {
      const id = await createCheck();
      await request(t.server).post(`/checks/${id}/pay`).expect(200);
      await t.db
        .update(posSync)
        .set({ leaseOwner: 'worker-1', leaseUntil: sql`now() + interval '30 seconds'` })
        .where(eq(posSync.checkId, id));

      const res = await request(t.server).get(`/checks/${id}/sync`).expect(200);
      expect((res.body as SyncView).status).toBe('in_progress');
    });

    it('shows the reason of a permanent failure', async () => {
      const id = await createCheck();
      await request(t.server).post(`/checks/${id}/pay`).expect(200);
      await t.db
        .update(posSync)
        .set({ status: 'failed', lastError: 'POS 422: total must be greater than 0' })
        .where(eq(posSync.checkId, id));

      const res = await request(t.server).get(`/checks/${id}/sync`).expect(200);
      expect(res.body).toMatchObject({ status: 'failed', lastError: 'POS 422: total must be greater than 0' });
    });
  });

  describe('POST /checks/:id/sync/retry', () => {
    it('restarts a failed sync: pending, attempts reset', async () => {
      const id = await createCheck();
      await request(t.server).post(`/checks/${id}/pay`).expect(200);
      await t.db.update(posSync).set({ status: 'failed', attempts: 7 }).where(eq(posSync.checkId, id));

      const res = await request(t.server).post(`/checks/${id}/sync/retry`).expect(202);
      expect(res.body).toMatchObject({ status: 'pending', attempts: 0 });
    });

    it('refuses with 409 when the sync is not stopped', async () => {
      const id = await createCheck();
      await request(t.server).post(`/checks/${id}/sync/retry`).expect(409); // never paid
      await request(t.server).post(`/checks/${id}/pay`).expect(200);
      await request(t.server).post(`/checks/${id}/sync/retry`).expect(409); // pending
    });
  });
});
