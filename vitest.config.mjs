import { defineConfig } from 'vitest/config';

// Renderer-side hook tests (React 19 + jsdom).
// Run with: npm run test:renderer  (or: npx vitest run)
export default defineConfig({
  // React 19 automatic JSX runtime for .jsx test files.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{js,jsx}'],
    // globals stays false — tests import { describe, it, expect, vi, ... } from 'vitest' explicitly.
    globals: false,
  },
});
