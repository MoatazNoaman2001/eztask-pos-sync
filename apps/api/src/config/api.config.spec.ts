import { loadApiConfig } from './api.config';

const required = { DATABASE_URL: 'postgres://x', POS_BASE_URL: 'http://pos' };

describe('loadApiConfig', () => {
  it('uses the documented defaults', () => {
    const config = loadApiConfig(required);
    expect(config).toMatchObject({
      port: 3000,
      posHttpTimeoutMs: 10_000,
      syncLeaseMs: 30_000,
      rateLimitMaxRequests: 4,
      rateLimitWindowMs: 10_000,
    });
  });

  it.each(['DATABASE_URL', 'POS_BASE_URL'])('refuses to start without %s', (key) => {
    const env: NodeJS.ProcessEnv = { ...required };
    delete env[key];
    expect(() => loadApiConfig(env)).toThrow(`${key} is required`);
  });

  it('refuses a POS timeout that is not below the lease (a lease must outlive its request)', () => {
    expect(() => loadApiConfig({ ...required, POS_HTTP_TIMEOUT_MS: '30000', SYNC_LEASE_MS: '30000' })).toThrow(
      'must be below SYNC_LEASE_MS',
    );
  });

  it.each(['0', '-5', '1.5', 'ten'])('refuses SYNC_BATCH_SIZE=%s', (value) => {
    expect(() => loadApiConfig({ ...required, SYNC_BATCH_SIZE: value })).toThrow('positive integer');
  });
});
