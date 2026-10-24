import { loadPosConfig } from './pos.config';

describe('loadPosConfig', () => {
  it('defaults every failure rate to 0 (a well-behaved POS)', () => {
    const config = loadPosConfig({});
    expect(config.failRate).toBe(0);
    expect(config.timeoutAfterCreateRate).toBe(0);
    expect(config.slowRate).toBe(0);
  });

  it('reads rates from the environment', () => {
    const config = loadPosConfig({ FAIL_RATE: '0.2', TIMEOUT_AFTER_CREATE_RATE: '0.1', SLOW_RATE: '1' });
    expect(config.failRate).toBe(0.2);
    expect(config.timeoutAfterCreateRate).toBe(0.1);
    expect(config.slowRate).toBe(1);
  });

  it.each(['30', '-0.1', 'abc'])('refuses to start with FAIL_RATE=%s', (value) => {
    expect(() => loadPosConfig({ FAIL_RATE: value })).toThrow('FAIL_RATE must be a number between 0 and 1');
  });

  it('uses the limits from the spec: 5 requests per 10 s', () => {
    const config = loadPosConfig({});
    expect(config.rateLimitMaxRequests).toBe(5);
    expect(config.rateLimitWindowMs).toBe(10_000);
  });
});
