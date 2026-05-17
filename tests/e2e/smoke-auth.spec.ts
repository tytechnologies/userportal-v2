import { test, expect } from '@playwright/test'

// Critical-path smoke #1: an authenticated session reaches the dashboard.
//
// Catches:
//   - login form regressions
//   - auth-cookie set/forward issues (the @nuxtjs/supabase v1→v2 bump
//     would have failed this on a fresh build)
//   - middleware redirect loops
//   - dashboard 401 cascade (every dashboard endpoint pings on render)
//
// Required env:
//   E2E_ADMIN_EMAIL     test user (defaults to 'admin@admin.com')
//   E2E_ADMIN_PASSWORD  test password (defaults to 'administrator')
//   PLAYWRIGHT_BASE_URL target server (defaults to localhost:3002)
//
// We use the dev admin account documented in docs/LAUNCH_CHECKLIST.md.
// Production smoke runs MUST point at a non-prod URL — never log a
// real broker into a smoke harness.

const EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@admin.com'
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'administrator'

test.describe('Auth + dashboard', () => {
  test('login lands on dashboard with admin sidebar visible', async ({ page }) => {
    await page.goto('/login')
    await expect(page).toHaveURL(/\/login/)

    await page.getByLabel(/email/i).fill(EMAIL)
    await page.getByLabel(/password/i).fill(PASSWORD)
    await page.getByRole('button', { name: /sign in|log in/i }).click()

    // Auth flow: cookie set → middleware lets /dashboard render.
    await page.waitForURL('**/dashboard', { timeout: 15_000 })

    // The dashboard hero/header should render — the simplest signal
    // that /api/me resolved and the page mounted past the loading
    // gate. If /api/me 401s, the page typically renders an error
    // banner instead.
    await expect(page.getByText(/dashboard|overview/i).first()).toBeVisible()

    // Admin role indicator: the sidebar's Administration section is
    // role-gated. If the recent role-shape regression (sub vs id)
    // recurs, this section vanishes and the assertion fails.
    await expect(page.getByText(/administration/i).first()).toBeVisible({ timeout: 10_000 })
  })
})
