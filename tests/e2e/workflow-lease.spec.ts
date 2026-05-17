import { test, expect } from '@playwright/test'

const EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@admin.com'
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'administrator'
const DEAL_ID = process.env.DEAL_ID_FOR_WORKFLOW_LEASE_E2E

test.skip(!DEAL_ID, 'Set DEAL_ID_FOR_WORKFLOW_LEASE_E2E to enable')

test('lease workflow: kickoff (no branch picker) to 3 steps to completion', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel(/email/i).fill(EMAIL)
  await page.getByLabel(/password/i).fill(PASSWORD)
  await page.getByRole('button', { name: /sign in|log in/i }).click()
  await page.waitForURL('**/dashboard', { timeout: 15_000 })

  await page.goto(`/deals/${DEAL_ID}`)

  await expect(page.getByText(/lease document checklist/i)).toBeVisible({ timeout: 10_000 })
  // No condo/land radio on lease
  await expect(page.getByLabel(/Condo unit/i)).toHaveCount(0)

  await page.getByRole('button', { name: /Start transfer process/i }).click()
  await expect(page.getByText(/0 \/ 3 complete/i)).toBeVisible()

  for (let i = 0; i < 3; i++) {
    const fileInput = page.locator('input[type="file"]').first()
    await fileInput.setInputFiles({
      name: `lease-step-${i + 1}.pdf`,
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 test'),
    })
    await expect(page.getByText(/File uploaded/i).first()).toBeVisible({ timeout: 15_000 })
    await page.locator('input[type="checkbox"]').first().check()
    await page.getByRole('button', { name: /Save & continue/i }).first().click()
    await expect(page.getByText(new RegExp(`${i + 1} / 3 complete`, 'i'))).toBeVisible({ timeout: 15_000 })
  }
  await expect(page.getByText(/All steps complete/i)).toBeVisible({ timeout: 15_000 })
})
