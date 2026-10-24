export const POS_CONFIG = Symbol('POS_CONFIG');

export interface PosConfig {
  /** Chance (0–1) of answering 500 without doing anything. */
  failRate: number;
  /** Chance (0–1) of creating the order, then hanging before answering. */
  timeoutAfterCreateRate: number;
  /** Chance (0–1) of answering correctly but slowly. */
  slowRate: number;

  hangAfterCreateMs: number;
  slowMinMs: number;
  slowMaxMs: number;

  /** The POS rate limit from the spec: 5 requests per 10 s per restaurant. */
  rateLimitMaxRequests: number;
  rateLimitWindowMs: number;
}

// Only the failure rates come from the environment (the spec says so).
// Delays and the rate limit are fixed by the spec; tests override them through the provider.
export function loadPosConfig(env: NodeJS.ProcessEnv = process.env): PosConfig {
  return {
    failRate: readRate(env, 'FAIL_RATE'),
    timeoutAfterCreateRate: readRate(env, 'TIMEOUT_AFTER_CREATE_RATE'),
    slowRate: readRate(env, 'SLOW_RATE'),
    hangAfterCreateMs: 15_000,
    slowMinMs: 3_000,
    slowMaxMs: 8_000,
    rateLimitMaxRequests: 5,
    rateLimitWindowMs: 10_000,
  };
}

function readRate(env: NodeJS.ProcessEnv, key: string): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return 0;

  const value = Number(raw);
  // Fail at startup: a typo like FAIL_RATE=30 would otherwise silently fail every request.
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${key} must be a number between 0 and 1, got "${raw}"`);
  }
  return value;
}
