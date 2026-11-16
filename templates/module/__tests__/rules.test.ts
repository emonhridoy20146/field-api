import { describe, expect, it } from 'vitest';
import { placeholderRule } from '../domain/rules.js';

describe('__name__ rules', () => {
  it('replace with real domain tests', () => {
    expect(placeholderRule(1)).toBe(true);
  });
});
