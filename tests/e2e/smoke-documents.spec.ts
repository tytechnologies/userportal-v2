import { test, expect } from '@playwright/test'

// Critical-path smoke #3: the New Document wizard opens and the three
// surviving modes render without crash.
//
// The Library mode was removed in A5 — confirming that's GONE from the
// Step 1 grid is itself part of the smoke. If a future revert
// re-introduces a button without restoring the endpoints, this fails.

const EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@admin.com'
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'administrator'

test('document wizard opens with three modes (Generate/Template/Upload), no Library button', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel(/email/i).fill(EMAIL)
  await page.getByLabel(/password/i).fill(PASSWORD)
  await page.getByRole('button', { name: /sign in|log in/i }).click()
  await page.waitForURL('**/dashboard', { timeout: 15_000 })

  // Open the document-drafts surface. The wizard is mounted as a modal
  // from multiple places (deal-detail, listing-detail, drafts index).
  await page.goto('/document-drafts')

  // The "New document" button label is broker-facing copy. Match the
  // most common variants.
  const newBtn = page.getByRole('button', { name: /new document|create document|new draft/i }).first()
  await expect(newBtn).toBeVisible({ timeout: 10_000 })
  await newBtn.click()

  // Three modes should be visible.
  await expect(page.getByText(/generate from prompt|generate/i).first()).toBeVisible()
  await expect(page.getByText(/org template|use template/i).first()).toBeVisible()
  await expect(page.getByText(/upload existing|attach pdf/i).first()).toBeVisible()

  // The Library mode should NOT be present (A5 hide).
  await expect(page.getByText(/legal library|ph · 60\+ templates/i)).toHaveCount(0)
})
