import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Testpilot's own tests only. The fixture repo has its
    // own suite, which is deliberately run separately — it is test *data*,
    // not tests of this codebase.
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', '.mastra/**', 'fixtures/sample-repo/**'],
  },
});
