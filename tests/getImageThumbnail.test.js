import { describe, it, expect } from 'vitest'

// e2e test — boots a real Nuxt server and hits the live endpoint.
// Skip unless SUPABASE_TEST_PROJECT=1 is set (same gate as RLS suite)
// because it requires a real DB to query against. Running by default
// also surfaces a Vue/Vite peer-dep MagicString error during setup
// that's only worth chasing when we actually want this test to run.
const SHOULD_RUN = process.env.SUPABASE_TEST_PROJECT === '1'

let nuxtFetch

if (SHOULD_RUN) {
  const testUtilsSpecifier = '@nuxt/test-utils/e2e'
  const { setup, $fetch } = await import(/* @vite-ignore */ testUtilsSpecifier)

  await setup()
  nuxtFetch = $fetch
}

describe.skipIf(!SHOULD_RUN)('POST /api/listings/get-image-thumbnail', () => {
  it('returns a valid response', async () => {
    const res = await nuxtFetch('/api/listings/get-image-thumbnail', {
      method: 'POST',
      body: { listing_id: 1 }
    })

    expect(res).toBeDefined()
    expect(typeof res).toBe('object')

    // Flexible validation (do not assume shape)
    expect(Object.keys(res).length).toBeGreaterThan(0)
  })
})
