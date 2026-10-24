import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import request from 'supertest';
import { AppModule as FakePosModule } from '../../../fake-pos/src/app.module';
import { ChaosService } from '../../../fake-pos/src/chaos/chaos.service';
import { configureApp } from '../../../fake-pos/src/configure-app';
import { PosOrder } from '../../../fake-pos/src/orders/types/pos-order';
import { StubChaos } from '../../../fake-pos/test/stub-chaos';

export interface TestPos {
  url: string;
  /** Switch failure modes on and off per test; nothing is random. */
  chaos: StubChaos;
  orders(): Promise<PosOrder[]>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** The real fake-POS app on a random port, with its randomness replaced by StubChaos. */
export async function startTestPos(): Promise<TestPos> {
  const chaos = new StubChaos();
  const moduleRef = await Test.createTestingModule({ imports: [FakePosModule] })
    .overrideProvider(ChaosService)
    .useValue(chaos)
    .compile();
  const app: INestApplication = configureApp(moduleRef.createNestApplication());
  await app.listen(0);

  const server = app.getHttpServer() as Server;
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    chaos,
    orders: async () => (await request(url).get('/debug/orders').expect(200)).body as PosOrder[],
    reset: async () => {
      chaos.failNext = false;
      chaos.hangNextCreate = false;
      chaos.release();
      await request(url).post('/debug/reset').expect(204);
    },
    close: async () => {
      chaos.release(); // let any hanging create finish so the server can close
      await app.close();
    },
  };
}
