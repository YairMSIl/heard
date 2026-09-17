import { defineConfig } from 'vitest/config'

// The unit suite covers the pure modules (validation, rate limiting, widget
// source). Route-level behaviour is exercised end-to-end against `wrangler dev`
// — see CLAUDE.md.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
