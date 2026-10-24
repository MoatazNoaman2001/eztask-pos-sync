import { SlidingWindowLimiter } from './sliding-window.limiter';

describe('SlidingWindowLimiter', () => {
  let now: number;
  let limiter: SlidingWindowLimiter;

  beforeEach(() => {
    now = 0;
    limiter = new SlidingWindowLimiter(5, 10_000, () => now);
  });

  it('allows 5 requests in the window and refuses the 6th', () => {
    for (let i = 0; i < 5; i++) expect(limiter.tryAcquire('r1')).toBe(true);
    expect(limiter.tryAcquire('r1')).toBe(false);
  });

  it('counts each restaurant separately', () => {
    for (let i = 0; i < 5; i++) limiter.tryAcquire('busy');
    expect(limiter.tryAcquire('busy')).toBe(false);
    expect(limiter.tryAcquire('quiet')).toBe(true);
  });

  it('frees a slot once the oldest request leaves the window', () => {
    for (let i = 0; i < 5; i++) {
      limiter.tryAcquire('r1');
      now += 1_000; // requests at t = 0s, 1s, 2s, 3s, 4s
    }
    now = 9_999;
    expect(limiter.tryAcquire('r1')).toBe(false); // t=0 is still inside the window
    now = 10_001;
    expect(limiter.tryAcquire('r1')).toBe(true); // t=0 has left the window
  });

  it('does not count refused requests', () => {
    for (let i = 0; i < 5; i++) limiter.tryAcquire('r1');
    for (let i = 0; i < 10; i++) limiter.tryAcquire('r1'); // all refused
    now = 10_001;
    expect(limiter.tryAcquire('r1')).toBe(true);
  });
});
