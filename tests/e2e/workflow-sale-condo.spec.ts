import { test, expect } from '@playwright/test'

// Workflow E2E #1: full sale-condo happy path through the wizard.
//
// Preconditions (set up before running locally):
//   - admin user can log in with E2E_ADMIN_EMAIL/PASSWORD
//   - a deal seeded via /api/admin/seed/* OR manually:
//     env DEAL_ID_FOR_WORKFLOW_E2E points at a condo-type deal
//     whose linked envelope is in status=completed.

const EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@admin.com'
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'administrator'
const DEAL_ID = process.env.DEAL_ID_FOR_WORKFLOW_E2E

test.skip(!DEAL_ID, 'Set DEAL_ID_FOR_WORKFLOW_E2E to enable')

test('sale-condo workflow: kickoff to 13 steps to completion', async ({ page }) => {
  // Login
  await page.goto('/login')
  await page.getByLabel(/email/i).fill(EMAIL)
  await page.getByLabel(/password/i).fill(PASSWORD)
  await page.getByRole('button', { name: /sign in|log in/i }).click()
  await page.waitForURL('**/dashboard', { timeout: 15_000 })

  await page.goto(`/deals/${DEAL_ID}`)

  // Kickoff card visible
  await expect(page.getByText(/Contract signed/i)).toBeVisible({ timeout: 10_000 })
  await page.getByLabel(/Condo unit/i).check()
  await page.getByRole('button', { name: /Start transfer process/i }).click()

  // Panel appears, 13 visible steps
  await expect(page.getByText(/Transfer document progress/i)).toBeVisible()
  await expect(page.getByText(/0 \/ 13 complete/i)).toBeVisible()

  // Walk through every active step. Each iteration:
  //   - upload a 1-byte test pdf
  //   - tick the attestation
  //   - click Save & continue
  for (let i = 0; i < 13; i++) {
    const fileInput = page.locator('input[type="file"]').first()
    await fileInput.setInputFiles({
      name: `step-${i + 1}.pdf`,
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 test'),
    })
    // Wait for upload-complete toast/text
    await expect(page.getByText(/File uploaded/i).first()).toBeVisible({ timeout: 15_000 })

    const attestCheckbox = page.locator('input[type="checkbox"]').first()
    await attestCheckbox.check()

    await page.getByRole('button', { name: /Save & continue/i }).first().click()

    // Progress counter ticks up
    await expect(page.getByText(new RegExp(`${i + 1} / 13 complete`, 'i'))).toBeVisible({ timeout: 15_000 })
  }

  // Completion state
  await expect(page.getByText(/All steps complete/i)).toBeVisible({ timeout: 15_000 })
})
