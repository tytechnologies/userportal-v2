import { createClient } from '@supabase/supabase-js'

export function getServerSupabase() {
  const config = useRuntimeConfig()
  const url = config.public.supabaseUrl as string
  const key = config.public.supabaseKey as string
  if (!url || !key) throw new Error('Supabase URL or key not configured')
  return createClient(url, key)
}

/** Server-only Supabase client with service role (bypasses RLS). Use for server-side inserts. */
export function getServerSupabaseAdmin() {
  const config = useRuntimeConfig()
  const url = config.public.supabaseUrl as string
  const key = config.supabaseServiceRoleKey as string
  if (!url || !key) throw new Error('Supabase URL or SUPABASE_SERVICE_ROLE_KEY not configured')
  return createClient(url, key)
}
