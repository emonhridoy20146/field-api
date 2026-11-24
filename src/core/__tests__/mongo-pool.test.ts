import { describe, expect, it } from 'vitest';
import { mongoOptions, poolFrom } from '../db/index.js';
import { loadConfig } from '../config/index.js';

// ADR-063: on Vercel every function instance has its own pool; unbounded pools hit the Atlas connection limit.
describe('Mongo connection pool (ADR-063)', () => {
  it('is bounded and closes idle connections by default', () => {
    const o = mongoOptions('field_ops');
    expect(o.maxPoolSize).toBe(10);
    expect(o.minPoolSize).toBe(0);
    expect(o.maxIdleTimeMS).toBe(60000);
    expect(o.waitQueueTimeoutMS).toBeGreaterThan(0);
    expect(o.dbName).toBe('field_ops');
    expect(o.retryWrites).toBe(true);
  });

  it('takes the limits from config, with the same defaults', () => {
    const base = { ...process.env };
    delete base.MONGODB_MAX_POOL_SIZE;
    delete base.MONGODB_MAX_IDLE_MS;
    expect(poolFrom(loadConfig(base))).toEqual({ maxPoolSize: 10, maxIdleTimeMS: 60000 });
    const set = poolFrom(loadConfig({ ...base, MONGODB_MAX_POOL_SIZE: '5', MONGODB_MAX_IDLE_MS: '30000' }));
    expect(mongoOptions('x', set)).toMatchObject({ maxPoolSize: 5, maxIdleTimeMS: 30000 });
  });

  it('refuses a pool size outside 1..100', () => {
    expect(() => loadConfig({ ...process.env, MONGODB_MAX_POOL_SIZE: '0' })).toThrow();
    expect(() => loadConfig({ ...process.env, MONGODB_MAX_POOL_SIZE: '500' })).toThrow();
  });
});
