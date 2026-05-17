// Admin — raw + normalized ingest queue overview.
//
// GET /api/admin/raw-ingest
//
// Returns rollups + recent rows from listings_raw + listings_normalized.
// Drives /admin/raw-ingest.vue. Now also surfaces the apply-side state
// (matched_at NULL vs NOT NULL, breakdown of apply outcomes) for the
// B-3.1 parity-verification window.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')

    const supabase = await serverSupabaseClient(event)

    const [rawCounts, normCounts, applyCounts, recentRawRes, recentNormRes] = await Promise.all([
      // raw_status_counts — per-status normalize state from listings_raw.
      (async () => {
        const { data } = await (supabase as any)
          .from('listings_raw')
          .select('normalize_status')
          .limit(50_000)
        const acc: Record<string, number> = { pending: 0, normalized: 0, rejected: 0 }
        for (const r of data ?? []) {
          acc[r.normalize_status] = (acc[r.normalize_status] ?? 0) + 1
        }
        return acc
      })(),

      // normalized_status_counts — overall match_status distribution.
      (async () => {
        const { data } = await (supabase as any)
          .from('listings_normalized')
          .select('match_status')
          .limit(50_000)
        const acc: Record<string, number> = {}
        for (const r of data ?? []) {
          acc[r.match_status] = (acc[r.match_status] ?? 0) + 1
        }
        return acc
      })(),

      // apply_counts — B-3.1 worker breakdown. Splits matched_at NULL
      // (awaiting apply) from matched_at NOT NULL, and within applied,
      // breaks out skipped_stale / skipped_collision / errors via
      // match_notes pattern matching. Same predicate set as the
      // smoke probe in mig 20260513000005.
      (async () => {
        const { data } = await (supabase as any)
          .from('listings_normalized')
          .select('match_status, matched_at, match_notes')
          .limit(50_000)
        const acc = {
          pending_apply:     0, // matched_existing_listing | matched_existing_property AND matched_at IS NULL
          applied:           0,
          skipped_stale:     0,
          skipped_collision: 0,
          apply_errors:      0,
          terminal_other:    0, // queued_for_review / rejected — won't be applied
        }
        for (const r of data ?? []) {
          const eligible =
            r.match_status === 'matched_existing_listing' ||
            r.match_status === 'matched_existing_property'

          if (!eligible) {
            acc.terminal_other += 1
            continue
          }
          if (r.matched_at == null) {
            acc.pending_apply += 1
            continue
          }
          const notes = String(r.match_notes ?? '')
          if (notes.includes('apply error')) acc.apply_errors += 1
          else if (notes.includes('skipped (listings.source_observed_at fresher)')) acc.skipped_stale += 1
          else if (notes.includes('skipped (collision')) acc.skipped_collision += 1
          else if (notes.includes('listings row gone')) acc.skipped_collision += 1
          else acc.applied += 1
        }
        return acc
      })(),

      (supabase as any)
        .from('listings_raw')
        .select('id, source_id, foreign_id, normalize_status, rejection_reason, ingested_at, normalized_at')
        .order('ingested_at', { ascending: false })
        .limit(30),

      (supabase as any)
        .from('listings_normalized')
        .select(
          'id, raw_id, source_id, foreign_id, title, match_status, ' +
            'resolved_property_id, resolved_listing_id, ingested_at, matched_at, match_notes',
        )
        .order('ingested_at', { ascending: false })
        .limit(30),
    ])

    return {
      raw_status_counts:        rawCounts,
      normalized_status_counts: normCounts,
      apply_counts:             applyCounts,
      recent_raw:               recentRawRes?.data ?? [],
      recent_normalized:        recentNormRes?.data ?? [],
    }
  },
})
