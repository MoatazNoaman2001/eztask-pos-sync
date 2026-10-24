import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ChaosService } from '../src/chaos/chaos.service';
import { configureApp } from '../src/configure-app';
import { PosOrder } from '../src/orders/order.types';
import { StubChaos } from './stub-chaos';

// Runs the real app over HTTP; only randomness is replaced (StubChaos).
describe('Fake POS (e2e)', () => {
  let app: INestApplication;
  let server: Server;
  let chaos: StubChaos;

  beforeEach(async () => {
    chaos = new StubChaos();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ChaosService)
      .useValue(chaos)
      .compile();

    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterEach(async () => {
    await app.close();
  });

  const order = (overrides: Partial<{ externalRef: string; restaurantId: string; total: number }> = {}) => ({
    externalRef: 'check-1',
    restaurantId: 'r1',
    items: [{ name: 'Koshary', quantity: 1, unitPrice: 50 }],
    total: 50,
    ...overrides,
  });

  async function allOrders(): Promise<PosOrder[]> {
    const res = await request(server).get('/debug/orders').expect(200);
    return res.body as PosOrder[];
  }

  describe('POST /orders', () => {
    it('creates an open order and returns its posOrderId', async () => {
      const res = await request(server).post('/orders').send(order()).expect(201);
      const { posOrderId } = res.body as { posOrderId: string };

      expect(await allOrders()).toEqual([
        expect.objectContaining({ posOrderId, externalRef: 'check-1', restaurantId: 'r1', status: 'open' }),
      ]);
    });

    it('is not idempotent: the same externalRef twice creates two orders', async () => {
      await request(server).post('/orders').send(order()).expect(201);
      await request(server).post('/orders').send(order()).expect(201);

      expect(await allOrders()).toHaveLength(2);
    });

    it.each([0, -10])('rejects total=%d permanently with 422 and creates nothing', async (total) => {
      await request(server).post('/orders').send(order({ total })).expect(422);
      expect(await allOrders()).toHaveLength(0);
    });

    it('FAIL_RATE: answers 500 and creates nothing', async () => {
      chaos.failNext = true;
      await request(server).post('/orders').send(order()).expect(500);
      expect(await allOrders()).toHaveLength(0);
    });

    it('TIMEOUT_AFTER_CREATE_RATE: the order exists before the response arrives', async () => {
      chaos.hangNextCreate = true;
      const response = request(server).post('/orders').send(order()).then((res) => res);

      // While the caller is still waiting, the POS already holds the order.
      await waitFor(async () => (await allOrders()).length === 1);

      chaos.release();
      expect((await response).status).toBe(201);
    });

    it('rejects a body without restaurantId with 400', async () => {
      const body: Record<string, unknown> = order();
      delete body.restaurantId;
      await request(server).post('/orders').send(body).expect(400);
    });
  });

  describe('GET /orders?externalRef=', () => {
    it('lists every order with that externalRef', async () => {
      await request(server).post('/orders').send(order()).expect(201);
      await request(server).post('/orders').send(order()).expect(201);
      await request(server).post('/orders').send(order({ externalRef: 'other' })).expect(201);

      const res = await request(server).get('/orders').query({ externalRef: 'check-1', restaurantId: 'r1' }).expect(200);
      expect(res.body as PosOrder[]).toHaveLength(2);
    });

    it('requires restaurantId, so lookups can be rate-limited per restaurant', async () => {
      await request(server).get('/orders').query({ externalRef: 'check-1' }).expect(400);
    });
  });

  describe('POST /orders/:posOrderId/cancel', () => {
    it('cancels the order, and cancelling again is harmless', async () => {
      const created = await request(server).post('/orders').send(order()).expect(201);
      const { posOrderId } = created.body as { posOrderId: string };

      await request(server).post(`/orders/${posOrderId}/cancel`).expect(200);
      await request(server).post(`/orders/${posOrderId}/cancel`).expect(200);

      expect((await allOrders())[0]?.status).toBe('cancelled');
    });

    it('answers 404 for an unknown order', async () => {
      await request(server).post('/orders/does-not-exist/cancel').expect(404);
    });
  });

  describe('rate limit (5 requests / 10 s per restaurant)', () => {
    it('answers 429 on the 6th request for a restaurant, while others are unaffected', async () => {
      for (let i = 0; i < 5; i++) {
        await request(server).post('/orders').send(order({ externalRef: `c${i}` })).expect(201);
      }
      await request(server).post('/orders').send(order({ externalRef: 'c6' })).expect(429);
      await request(server).post('/orders').send(order({ restaurantId: 'r2' })).expect(201);
    });

    it('counts lookups and cancels too, not only creates', async () => {
      const created = await request(server).post('/orders').send(order()).expect(201); // 1
      const { posOrderId } = created.body as { posOrderId: string };
      await request(server).post('/orders').send(order({ externalRef: 'c2' })).expect(201); // 2
      await request(server).post('/orders').send(order({ externalRef: 'c3' })).expect(201); // 3
      await request(server).get('/orders').query({ externalRef: 'c2', restaurantId: 'r1' }).expect(200); // 4
      await request(server).post(`/orders/${posOrderId}/cancel`).expect(200); // 5

      await request(server).get('/orders').query({ externalRef: 'c2', restaurantId: 'r1' }).expect(429);
    });
  });

  describe('POST /debug/reset', () => {
    it('empties the POS and the rate limiter', async () => {
      for (let i = 0; i < 5; i++) {
        await request(server).post('/orders').send(order({ externalRef: `c${i}` })).expect(201);
      }
      await request(server).post('/debug/reset').expect(204);

      expect(await allOrders()).toHaveLength(0);
      await request(server).post('/orders').send(order()).expect(201);
    });
  });
});

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
