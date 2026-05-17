import { createClient } from '@supabase/supabase-js'
import { describe, it, expect } from 'vitest'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY

// DANGER: this test mutates a real listing (id=1) in whatever DB the
// env vars point at. Skip unless SUPABASE_TEST_PROJECT=1 is set, same
// gate the RLS suite uses. NEVER run against production.
const SHOULD_RUN =
  process.env.SUPABASE_TEST_PROJECT === '1' && SUPABASE_URL && SUPABASE_KEY

describe.skipIf(!SHOULD_RUN)('testCreateListing', () => {
  // describe.skipIf still evaluates the body for test registration —
  // any sync code here runs even when skipped. Defer client creation
  // into the it() so collection doesn't crash on missing env vars.
  const formData = {
    id: 1,
    title: 'Test Listing Test ID 1',
  }

  it('should create a listing', async () => {
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
    const { data, error } = await supabase
      .from('listings')
      .update({
        ...formData,
        updated_at: new Date(),
      })
      .eq('id', 1)
      .select()
      .single()

    if (error) {
      console.error('Error creating listing:', error)
      throw new Error('Failed to create listing')
    }

    expect(data).toBeDefined()
  })
})
