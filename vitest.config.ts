import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    // `.claude/` holds agent-owned workspace artifacts (nested worktrees,
    // scratch dirs). Vitest's default include (`**/*.test.ts`) would otherwise
    // pick up tests from an older worktree snapshot and run them against
    // the live `src/` — guaranteeing drift-induced failures.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
