// Dashboard role-aware query scoping.
//
// Brokers/agents must see only their own listings, inquiries, and
// deals on the dashboard surfaces. Admins keep the platform-wide
// view. RLS alone doesn't enforce this — the listings table has
// permissive RLS for the MLS cross-broker visibility feature.
//
// Pattern (use it like this):
//
//   const scope = await resolveDashboardScope(event, supabase)
//   const { count } = await scope.scopeListings(
//     supabase.from('listings').select('id', { count: 'estimated', head: true })
//       .eq('is_online', true)
//   )
//
// scope.isAdmin lets callers conditionally hide entire admin-only
// sections (failed_imports, failing_webhooks, duplicate_candidates).

import type { H3Event } from 'h3'
import type { SupabaseClient } from '@supabase/supabase-js'
import { serverSupabaseUser } from './sbUser'

export type DashboardScope = {
  isAdmin: boolean
  myId: string | null
  scopeListings: <T>(q: T) => T
  scopeInquiries: <T>(q: T) => T
  scopeDeals: <T>(q: T) => T
}

export async function resolveDashboardScope(
  event: H3Event,
  supabase: SupabaseClient,
): Promise<DashboardScope> {
  // Resolve admin status. Default to false on any error — safer to
  // show the smaller scope than over-share.
  let isAdmin = false
  try {
    const { data, error } = await (supabase as any).rpc('has_permission', {
      permission_to_check: 'admin.access',
    })
    if (!error) isAdmin = data === true
  } catch {
    isAdmin = false
  }

  let myId: string | null = null
  try {
    const user = await serverSupabaseUser(event)
    myId = user?.id ?? null
  } catch {
    myId = null
  }

  // Helpers — accept any PostgREST filter builder and return it
  // either as-is (admin) or with the ownership predicate appended.
  // The `as any` casts let us call `.eq()` on the generic T without
  // forcing every caller to import the full PostgREST builder type.
  function scopeListings<T>(q: T): T {
    if (isAdmin || !myId) return q
    return (q as any).eq('created_by', myId) as T
  }
  function scopeInquiries<T>(q: T): T {
    if (isAdmin || !myId) return q
    return (q as any).eq('assigned_user_id', myId) as T
  }
  function scopeDeals<T>(q: T): T {
    if (isAdmin || !myId) return q
    // deals.created_by matches the RLS policy
    // `USING (deals.write.team OR created_by = auth.uid())` from mig 507000021.
    return (q as any).eq('created_by', myId) as T
  }

  return { isAdmin, myId, scopeListings, scopeInquiries, scopeDeals }
}
