import { defineVitestConfig } from '@nuxt/test-utils/config'

process.env.NUXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
process.env.NUXT_PUBLIC_SUPABASE_KEY ||= 'test-public-key'

export default defineVitestConfig({
  test: {
    environment: 'nuxt',
    globals: true,
  },
})
