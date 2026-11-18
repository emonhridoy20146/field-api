import { describe, expect, it } from 'vitest';
import { cronAuthorized } from '../serverless.js';

describe('cronAuthorized (ADR-034)', () => {
  const secret = 'test-secret-0123456789';

  it('accepts the exact bearer secret', () => {
    expect(cronAuthorized(`Bearer ${secret}`, secret)).toBe(true);
  });

  it('refuses a wrong, missing or non-bearer header', () => {
    expect(cronAuthorized('Bearer nope', secret)).toBe(false);
    expect(cronAuthorized(undefined, secret)).toBe(false);
    expect(cronAuthorized(secret, secret)).toBe(false);
  });

  it('refuses everything when the secret is unset or too short', () => {
    expect(cronAuthorized('Bearer ', undefined)).toBe(false);
    expect(cronAuthorized('Bearer short', 'short')).toBe(false);
  });
});
