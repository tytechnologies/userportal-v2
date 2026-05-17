import { defineConfig, devices } from '@playwright/test'

// Playwright smoke configuration. Pre-launch this is INTENTIONALLY thin:
// 3 critical paths against a running dev/preview server. It exists to
// catch the class of bug that ate two days of this branch (auth
// regressions, template parse errors, missing imports surfacing only
// in the browser).
//
// To run:
//   pnpm e2e                       # against http://localhost:3002 (default)
//   PLAYWRIGHT_BASE_URL=https://… pnpm e2e   # against staging/prod
//
// First time:
//   pnpm e2e:install               # downloads chromium browser binary
//
// CI integration is deferred until post-launch — running the full
// browser install in CI doubles cold build time, and we want the
// fastest possible deploy loop this week.

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,        // smoke suite — serial keeps order predictable
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3002',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Don't auto-spawn a server. Operator runs `pnpm dev` (or hits a
  // staging URL) and triggers `pnpm e2e` separately. Trying to manage
  // the Nuxt dev server lifecycle from Playwright has been finicky
  // across projects; manual is more reliable for a smoke suite.
})
