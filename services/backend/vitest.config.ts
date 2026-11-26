import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Vitest configuration for backend tests
 *
 * Test organization (Dec 2025):
 * - tests/unit/           Pure unit tests (mocked dependencies)
 * - tests/integration/    Tests requiring DB/S3/containers
 * - tests/e2e/            Full stack tests (live server required)
 * - tests/contract/       API schema/type validation
 *
 * Run commands:
 * - npm test              All tests
 * - npm run test:unit     Unit tests only
 * - npm run test:integration  Integration tests
 * - npm run test:e2e      E2E tests (requires RUN_E2E_TESTS=1)
 * - npm run test:contract Contract tests
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // Run tests sequentially to prevent global state pollution
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    sequence: {
      concurrent: false,
    },
    // Clear mocks between tests for isolation
    clearMocks: true,
    // Restore mocks to original implementation after each test
    restoreMocks: true,
    // All tests now live under tests/ directory
    include: ['tests/**/*.test.ts'],
    exclude: [
      'node_modules',
      'dist',
      'tests/helpers/**',
      'tests/fixtures/**',
    ],
    // Increase timeout for integration tests (DB operations can be slow)
    testTimeout: 60000,
    hookTimeout: 120000,
    setupFiles: ['./tests/helpers/loadEnvTest.ts'],

    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      // Coverage thresholds for CI gate.
      // The backend surface expanded substantially across security-ops/admin
      // areas, while this job still measures unit-test coverage against the
      // whole codebase. Keep the baseline realistic until coverage is raised
      // on the newer modules.
      thresholds: {
        statements: 55,
        branches: 50,
        functions: 55,
        lines: 55,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@null-ai/contracts': path.resolve(__dirname, '../../packages/contracts/src/index.ts'),
    },
  },
});
