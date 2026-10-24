import { backoffMs } from './backoff';

const noJitter = () => 0.5; // random() = 0.5 → jitter factor exactly 1

describe('backoffMs', () => {
  it('doubles from 1 s', () => {
    expect([1, 2, 3, 4].map((n) => backoffMs(n, noJitter))).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it('is capped at 60 s, however many attempts', () => {
    expect(backoffMs(7, noJitter)).toBe(60_000);
    expect(backoffMs(500, noJitter)).toBe(60_000);
  });

  it('adds at most ±20% jitter', () => {
    expect(backoffMs(4, () => 0)).toBe(6_400);
    expect(backoffMs(4, () => 1)).toBe(9_600);
  });
});
