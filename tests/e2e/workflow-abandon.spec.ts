import { test, expect } from '@playwright/test'

const EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@admin.com'
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'administrator'
const DEAL_ID = process.env.DEAL_ID_FOR_WORKFLOW_ABANDON_E2E

test.skip(!DEAL_ID, 'Set DEAL_ID_FOR_WORKFLOW_ABANDON_E2E to enable')

test('admin can abandon a mid-flow workflow and broker can restart', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel(/email/i).fill(EMAIL)
  await page.getByLabel(/password/i).fill(PASSWORD)
  await page.getByRole('button', { name: /sign in|log in/i }).click()
  await page.waitForURL('**/dashboard', { timeout: 15_000 })

  await page.goto(`/deals/${DEAL_ID}`)

  // Start workflow first (pick condo for sale deals; the spec assumes a sale deal seed).
  await expect(page.getByText(/Contract signed/i)).toBeVisible({ timeout: 10_000 })
  await page.getByLabel(/Condo unit/i).check()
  await page.getByRole('button', { name: /Start transfer process/i }).click()
  await expect(page.getByText(/0 \/ 13 complete/i)).toBeVisible()

  // Abandon. The component uses window.prompt; we intercept.
  page.once('dialog', (d) => d.accept('wrong branch picked'))
  await page.getByRole('button', { name: /Abandon/i }).click()
  await expect(page.getByText(/Workflow abandoned/i)).toBeVisible({ timeout: 10_000 })

  // Kickoff card returns; restart on the correct branch.
  await expect(page.getByText(/Contract signed/i)).toBeVisible({ timeout: 10_000 })
  await page.getByLabel(/House \/ Land/i).check()
  await page.getByRole('button', { name: /Start transfer process/i }).click()
  await expect(page.getByText(/0 \/ 14 complete/i)).toBeVisible()
})
