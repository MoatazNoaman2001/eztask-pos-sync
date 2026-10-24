import { hostname } from 'node:os';

export const API_CONFIG = Symbol('API_CONFIG');

export interface ApiConfig {
  port: number;
  /** Written into pos_sync.lease_owner so we can tell which instance holds a row. */
  instanceId: string;
  databaseUrl: string;
  posBaseUrl: string;
  posHttpTimeoutMs: number;
  syncLeaseMs: number;
  syncPollIntervalMs: number;
  syncBatchSize: number;
  rateLimitMaxRequests: number;
  rateLimitWindowMs: number;
}

// Meanings and defaults: docs/configuration.md
export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const config: ApiConfig = {
    port: readInt(env, 'PORT', 3000),
    instanceId: env.INSTANCE_ID || `${hostname()}-${process.pid}`,
    databaseUrl: readRequired(env, 'DATABASE_URL'),
    posBaseUrl: readRequired(env, 'POS_BASE_URL'),
    posHttpTimeoutMs: readInt(env, 'POS_HTTP_TIMEOUT_MS', 10_000),
    syncLeaseMs: readInt(env, 'SYNC_LEASE_MS', 30_000),
    syncPollIntervalMs: readInt(env, 'SYNC_POLL_INTERVAL_MS', 1_000),
    syncBatchSize: readInt(env, 'SYNC_BATCH_SIZE', 10),
    rateLimitMaxRequests: readInt(env, 'RATE_LIMIT_MAX_REQUESTS', 4),
    rateLimitWindowMs: readInt(env, 'RATE_LIMIT_WINDOW_MS', 10_000),
  };

  // If a lease could expire while its POS call is still in flight, a second worker
  // could take the row and create a duplicate (docs/risk.md A3). Refuse to start.
  if (config.posHttpTimeoutMs >= config.syncLeaseMs) {
    throw new Error(
      `POS_HTTP_TIMEOUT_MS (${config.posHttpTimeoutMs}) must be below SYNC_LEASE_MS (${config.syncLeaseMs})`,
    );
  }
  return config;
}

function readRequired(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function readInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer, got "${raw}"`);
  }
  return value;
}
