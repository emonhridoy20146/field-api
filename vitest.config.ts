import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/helpers/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    pool: 'forks',
    include: ['src/**/__tests__/**/*.test.ts', 'test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/main.ts'],
      thresholds: { lines: 80, 'src/**/domain/**': { lines: 90 }, 'src/modules/erp-gateway/mappers/**': { lines: 90 } },
    },
  },
});
