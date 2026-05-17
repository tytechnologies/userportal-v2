// Dashboard "Needs Attention" aggregator.
//
// GET /api/dashboard/attention
// Auth: required (any authenticated user).
//
// Returns a single jsonb of operational signals that need human review,
// each with a count + a small `items` preview (top 5).
//
// Role-aware scoping (2026-05-14 fix):
//   - Admins (has_permission('admin.access')=true) see EVERY section:
//     all stale listings, all duplicate candidates, failed imports,
//     failing webhooks, pending verifications, etc.
//   - Brokers/agents see ONLY their own listings — `created_by = user.id`
//     is enforced explicitly per section. Platform-ops sections
//     (duplicate_candidates, failed_imports, failing_webhooks,
//     pending_verifications) are hidden — they would have leaked
//     inventory the broker has no operational stake in.
//   - pending_shares stays scoped to `shared_with_user_id = user.id`
//     for everyone — that's the natural per-user filter.
//
// Why explicit filter (not RLS):
//   `listings` RLS is permissive for the MLS cross-broker visibility
//   feature. RLS alone doesn't restrict a broker to their own listings.
//
// Single round trip, parallel queries, per-section error isolation.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

type Item = Record<string, unknown>
type Section = { count: number; items: Item[]; note?: string }

async function tryAttention<T>(
  op: string,
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await fn()
  } catch (err: any) {
    logger.warn({ err: err?.message, op: `dashboard.attention.${op}` }, 'attention_section_failed')
    return fallback
  }
}

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event, user }) => {
    const supabase = await serverSupabaseClient(event)
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()

    const empty: Section = { count: 0, items: [] }

    // Resolve admin status once — drives the "see-everything" vs.
    // "only your own listings" split. has_permission is SECURITY
    // DEFINER + role-table-backed, so this is the authoritative
    // RBAC signal.
    const isAdmin = await (async () => {
      try {
        const { data, error } = await (supabase as any).rpc(
          'has_permission',
          { permission_to_check: 'admin.access' },
        )
        if (error) return false
        return data === true
      } catch {
        return false
      }
    })()

    const [
      staleListings,
      duplicateCandidates,
      failedImports,
      listingsNoImages,
      failingWebhooks,
      pendingVerifications,
      pendingShares,
    ] = await Promise.all([
      // 1. Stale listings — online, not soft-deleted, untouched > 60d.
      //    Brokers/agents: scoped to their own listings only.
      tryAttention(
        'stale_listings',
        async () => {
          let q: any = (supabase as any)
            .from('listings')
            // 'planned' uses Postgres's plan-time row estimate. Cheaper
            // than 'exact' which scans the table; precise enough for a
            // dashboard "stale" count.
            .select('id, title, updated_at', { count: 'planned' })
            .eq('is_online', true)
            .is('deleted_at', null)
            .lt('updated_at', sixtyDaysAgo)
          if (!isAdmin) q = q.eq('created_by', user!.id)
          const { data, count, error } = await q
            .order('updated_at', { ascending: true })
            .limit(5)
          if (error) throw new Error(error.message)
          return { count: count ?? 0, items: data ?? [] } as Section
        },
        empty,
      ),

      // 2. Duplicate candidates — admin-only platform-ops surface.
      //    Brokers/agents see 0; this isn't their concern.
      tryAttention(
        'duplicate_candidates',
        async () => {
          if (!isAdmin) return empty
          const { data, count, error } = await (supabase as any)
            .from('listing_duplicate_candidates')
            .select('id, a_listing_id, b_listing_id, confidence, status', { count: 'exact' })
            .eq('status', 'pending')
            .order('confidence', { ascending: false })
            .limit(5)
          if (error) throw new Error(error.message)
          return { count: count ?? 0, items: data ?? [] } as Section
        },
        empty,
      ),

      // 3. Failed listing imports — admin-only.
      //    Brokers/agents see 0 (imports are a platform-ops flow).
      tryAttention(
        'failed_imports',
        async () => {
          if (!isAdmin) return empty
          const { data, count, error } = await (supabase as any)
            .from('listing_import_rows')
            .select('id, batch_id, outcome, outcome_detail, processed_at', { count: 'exact' })
            .not('outcome', 'in', '(pending,created_pending_review)')
            .order('processed_at', { ascending: false, nullsFirst: false })
            .limit(5)
          if (error) throw new Error(error.message)
          return { count: count ?? 0, items: data ?? [] } as Section
        },
        empty,
      ),

      // 4. Listings without any attached image. Brokers/agents:
      //    scoped to their own listings.
      tryAttention(
        'listings_no_images',
        async () => {
          let q: any = (supabase as any)
            .from('listings')
            // 'planned' instead of 'exact' — full count scan on listings
            // is the dashboard's slowest query. See stats.get.ts header.
            .select('id, title, updated_at', { count: 'planned' })
            .eq('is_online', true)
            .is('deleted_at', null)
            .or('image_count.is.null,image_count.eq.0')
          if (!isAdmin) q = q.eq('created_by', user!.id)
          const { data, count, error } = await q
            .order('updated_at', { ascending: false })
            .limit(5)
          if (error) {
            // image_count column may not exist on some envs (schema
            // drift). Don't break the panel — return an info note.
            return { count: 0, items: [], note: 'image_count column unavailable' } as Section
          }
          return { count: count ?? 0, items: data ?? [] } as Section
        },
        empty,
      ),

      // 5. Failing webhooks — admin-only platform-ops surface.
      tryAttention(
        'failing_webhooks',
        async () => {
          if (!isAdmin) return empty
          const { data, count, error } = await (supabase as any)
            .from('webhook_subscriptions')
            .select('id, display_name, url, consecutive_failures', { count: 'exact' })
            .eq('enabled', true)
            .gte('consecutive_failures', 5)
            .order('consecutive_failures', { ascending: false })
            .limit(5)
          if (error) {
            return { count: 0, items: [] } as Section
          }
          return { count: count ?? 0, items: data ?? [] } as Section
        },
        empty,
      ),

      // 6. Pending listing verifications. Admin sees all pending across
      //    the platform; brokers/agents see pending only for their own
      //    listings.
      tryAttention(
        'pending_verifications',
        async () => {
          let q: any = (supabase as any)
            .from('listing_verifications')
            .select('id, listing_id, submitted_at, status, listings!inner(created_by)', { count: 'exact' })
            .eq('status', 'pending')
          if (!isAdmin) q = q.eq('listings.created_by', user!.id)
          const { data, count, error } = await q
            .order('submitted_at', { ascending: true })
            .limit(5)
          if (error) {
            // If the embed isn't supported on this env (older PostgREST
            // or RLS blocks the join), fall back to admin-only mode for
            // this section.
            return { count: 0, items: [], note: 'verifications join unavailable' } as Section
          }
          return { count: count ?? 0, items: data ?? [] } as Section
        },
        empty,
      ),

      // 7. Pending shares for the caller — already self-filtered.
      //    Works for both admins and non-admins (it's a per-user surface).
      tryAttention(
        'pending_shares',
        async () => {
          const { data, count, error } = await (supabase as any)
            .from('listing_shares')
            .select('id, listing_id, shared_by_user_id, created_at', { count: 'exact' })
            .eq('shared_with_user_id', user!.id)
            .eq('status', 'pending')
            .order('created_at', { ascending: false })
            .limit(5)
          if (error) throw new Error(error.message)
          return { count: count ?? 0, items: data ?? [] } as Section
        },
        empty,
      ),
    ])

    const totalCount =
      staleListings.count +
      duplicateCandidates.count +
      failedImports.count +
      listingsNoImages.count +
      failingWebhooks.count +
      pendingVerifications.count +
      pendingShares.count

    return {
      total_count: totalCount,
      scope: isAdmin ? 'admin' : 'agent',
      sections: {
        stale_listings: staleListings,
        duplicate_candidates: duplicateCandidates,
        failed_imports: failedImports,
        listings_no_images: listingsNoImages,
        failing_webhooks: failingWebhooks,
        pending_verifications: pendingVerifications,
        pending_shares: pendingShares,
      },
    }
  },
})
