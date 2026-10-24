import { ChaosService } from '../src/chaos/chaos.service';

type Chaos = Pick<ChaosService, 'shouldFail' | 'shouldHangAfterCreate' | 'maybeBeSlow' | 'hangAfterCreate'>;

/**
 * Replaces ChaosService in tests: no randomness, no real waiting.
 * Each test switches on exactly the failure it wants to see.
 * Typed against the real service, so the two can't drift apart.
 */
export class StubChaos implements Chaos {
  failNext = false;
  hangNextCreate = false;

  // Called by the test to let a "hanging" create finish answering.
  private releaseHang: () => void = () => undefined;

  shouldFail(): boolean {
    return this.failNext;
  }

  shouldHangAfterCreate(): boolean {
    return this.hangNextCreate;
  }

  maybeBeSlow(): Promise<void> {
    return Promise.resolve();
  }

  hangAfterCreate(): Promise<void> {
    return new Promise((resolve) => {
      this.releaseHang = resolve;
    });
  }

  release(): void {
    this.releaseHang();
  }
}
