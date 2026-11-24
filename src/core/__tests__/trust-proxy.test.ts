import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/index.js';

// ADR-064: behind Vercel the login throttle must see the client IP (X-Forwarded-For), not Vercel's proxy.
describe('TRUST_PROXY default', () => {
  it('is on when running on Vercel and the variable is unset', () => {
    expect(loadConfig({ VERCEL: '1' }).TRUST_PROXY).toBe(true);
    expect(loadConfig({ VERCEL: '1', TRUST_PROXY: '' }).TRUST_PROXY).toBe(true);
  });
  it('is off elsewhere unless set', () => {
    expect(loadConfig({}).TRUST_PROXY).toBe(false);
    expect(loadConfig({ TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
  });
  it('an explicit false wins on Vercel', () => {
    expect(loadConfig({ VERCEL: '1', TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false);
  });
});
