// External-source listings ingestion.
//
// POST /api/admin/listings/ingest
//
// Auth (dual path):
//   1. Admin JWT (manual ops trigger).
//   2. `x-source-secret` header matching the target source's
//      `ingest_secret` (machine-driven sync). Constant-time compared.
//
// Body:
//   {
//     source_slug: string,              // listing_sources.slug
//     listings: [
//       {
//         foreign_id: string,           // partner's id
//         title: string,
//         description?: string,
//         building_id?: number,         // pre-resolved by importer
//         contact_id?: number,          // optional
//         city_id?: number,
//         barangay_id?: number,
//         property_category?: 'residential' | 'commercial',
//         property_type?: string,
//         status?: string,
//         condition?: string,
//         for_sale?: boolean,
//         for_rent?: boolean,
//         sale_price?: number,
//         rent_price?: number,
//         bedrooms?: number,
//         bathrooms?: number,
//         floor_area?: number,
//         lot_area?: number,
//         parking_spaces?: number,
//         is_online?: boolean,
//         availability_date?: string,   // ISO
//         ... (any other listings columns the partner is mapped to)
//       },
//       ...
//     ]
//   }
//
// Response:
//   200 â†’ {
//     processed: N,
//     inserted: I,
//     updated:  U,
//     errors:   [{ foreign_id, reason }, ...]
//     source: { slug, last_ingested_at }
//   }
//
// Failure policy:
//   - Per-row errors caught + recorded in `errors`. Don't abort the
//     whole batch on one bad row â€” partner retries it next sync.
//   - Source-level failures (no slug, secret mismatch, source disabled)
//     return 4xx upfront before any DB write.
//
// Idempotency: upsert keyed on (source_id, foreign_id). Re-sending the
// same payload is a no-op aside from updating source_observed_at +
// last_ingested_at.

import { z } from 'zod'
import { timingSafeEqual } from 'node:crypto'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../../utils/sbUser'
import { requireRole } from '~~/server/utils/rbac'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'
import { dispatchWebhook } from '~~/server/utils/webhooks'
import { refreshListingDetails } from '~~/server/utils/refresh-listing-details'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'

// Cap per-call to keep transaction time bounded. Partners that need
// to push more chunk into multiple calls.
const MAX_BATCH = 500

// Subset of listings columns we accept from importers. Excludes
// internal-only fields (created_by, deleted_at, deleted_by, etc.) and
// generated columns (search_tsv).
const listingItemSchema = z
  .object({
    foreign_id: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(500),
    description: z.string().max(50_000).nullable().optional(),
    building_id: z.number().int().positive().nullable().optional(),
    contact_id: z.number().int().positive().nullable().optional(),
    city_id: z.number().int().positive().nullable().optional(),
    barangay_id: z.number().int().positive().nullable().optional(),
    property_id: z.number().int().positive().nullable().optional(),
    property_category: z.enum(['residential', 'commercial']).optional(),
    property_type: z.string().max(40).nullable().optional(),
    property_name: z.string().max(255).nullable().optional(),
    property_slug: z.string().max(255).nullable().optional(),
    street_address: z.string().max(500).nullable().optional(),
    unit_number: z.string().max(40).nullable().optional(),
    status: z.string().max(40).nullable().optional(),
    condition: z.string().max(40).nullable().optional(),
    for_sale: z.boolean().optional(),
    for_rent: z.boolean().optional(),
    sale_price: z.number().nullable().optional(),
    rent_price: z.number().nullable().optional(),
    bedrooms: z.number().int().nullable().optional(),
    bathrooms: z.number().int().nullable().optional(),
    floor_area: z.number().nullable().optional(),
    lot_area: z.number().nullable().optional(),
    parking_spaces: z.number().int().nullable().optional(),
    is_online: z.boolean().optional(),
    availability_date: z.string().nullable().optional(),
    lease_term: z.number().int().nullable().optional(),
    rent_advance: z.number().int().nullable().optional(),
    security_deposit: z.number().int().nullable().optional(),
    association_dues: z.number().nullable().optional(),
  })
  .passthrough()

const bodySchema = z.object({
  source_slug: z.string().trim().min(1).max(80),
  listings: z.array(listingItemSchema).min(1).max(MAX_BATCH),
})

function isSecretAuthorized(provided: string | undefined, expected: string | null | undefined): boolean {
  if (!provided || !expected) return false
  const a = Buffer.from(provided.trim(), 'utf8')
  const b = Buffer.from(expected.trim(), 'utf8')
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export default defineEventHandler(async (event) => {
  // Capture wall-clock at start so the run record gets accurate
  // duration. Cheap; no allocation.
  const startedAtMs = Date.now()

  // Parse + validate body up front.
  let body: z.infer<typeof bodySchema>
  try {
    const raw = await readBody(event)
    body = bodySchema.parse(raw ?? {})
  } catch (err: any) {
    if (err?.issues) {
      throw createError({
        statusCode: 422,
        statusMessage: 'Validation failed',
        data: { issues: err.issues, step: 'validate' },
      })
    }
    throw createError({ statusCode: 400, statusMessage: 'Invalid request body' })
  }

  if (body.listings.length > MAX_BATCH) {
    throw createError({
      statusCode: 413,
      statusMessage: `Batch too large (max ${MAX_BATCH}); chunk and retry`,
    })
  }

  const supabase = await serverSupabaseClient(event)

  // Source lookup uses the SERVICE-ROLE client so it works for
  // anonymous partner callers (no JWT) and bypasses the RLS-on-
  // listing_sources gate. The plaintext ingest_secret column is no
  // longer read here — secrets live in vault as of mig 513000006
  // and are resolved via get_listing_source_secret() below.
  const admin = getServerSupabaseAdmin()
  const { data: source, error: sourceErr } = await (admin as any)
    .from('listing_sources')
    .select('id, slug, enabled, last_ingested_at')
    .eq('slug', body.source_slug)
    .maybeSingle()

  if (sourceErr) {
    logger.error(
      { err: sourceErr.message, op: 'listings.ingest.source_lookup' },
      'ingest_source_lookup_failed',
    )
    throw createError({ statusCode: 500, statusMessage: sourceErr.message })
  }

  if (!source || !source.enabled) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Source not found or disabled',
    })
  }

  // Auth: admin JWT OR matching x-source-secret. Either path is enough.
  //
  // The secret is fetched via get_listing_source_secret() (mig 513000006)
  // which reads from vault when the source is migrated, falling back to
  // the plaintext column for not-yet-migrated sources. The RPC is
  // service-role only — that's why we call it through `admin`, not the
  // request-scoped client.
  const providedSecret = getRequestHeader(event, 'x-source-secret')
  let triggeredBy: 'admin' | 'source' = 'source'
  let secretOk = false

  if (providedSecret) {
    const { data: secretValue, error: secretErr } = await (admin as any)
      .rpc('get_listing_source_secret', { p_slug: source.slug })
    if (secretErr) {
      logger.error(
        { err: secretErr.message, op: 'listings.ingest.secret_resolve' },
        'ingest_secret_resolve_failed',
      )
      // Don't reveal the lookup failure to the caller — fall through
      // to the admin auth path so a misconfigured vault doesn't expose
      // implementation detail.
    } else if (secretValue) {
      secretOk = isSecretAuthorized(providedSecret, secretValue as string)
    }
  }

  if (!secretOk) {
    // No valid secret â†’ fall back to the admin path. This will throw
    // 401/403 if the caller has neither.
    const user = await serverSupabaseUser(event)
    if (!user) {
      throw createError({
        statusCode: 401,
        statusMessage: 'Authentication required',
      })
    }
    await requireRole(event, 'admin')
    triggeredBy = 'admin'
  }

  // Per-row upsert. We use the partial unique index
  // (source_id, foreign_id) as the conflict target. supabase-js
  // doesn't expose the partial-index conflict syntax cleanly, so we
  // emulate via a SELECT-then-INSERT-or-UPDATE pattern. At this batch
  // size (â‰¤ 500) the round-trip cost is acceptable.

  const errors: Array<{ foreign_id: string; reason: string }> = []
  let inserted = 0
  let updated = 0
  let raw_captured = 0
  const now = new Date().toISOString()

  for (const item of body.listings) {
    const payload: Record<string, unknown> = {
      ...item,
      source_id: source.id,
      foreign_id: item.foreign_id,
      source_observed_at: now,
    }

    // B-3 dual-write: capture the verbatim payload in listings_raw
    // ahead of the listings upsert. The (source_id, foreign_id,
    // raw_hash) UNIQUE makes re-pushes of identical payloads no-op.
    // raw_hash is computed by the BEFORE INSERT trigger.
    // Failure here MUST NOT fail the ingest — partner traffic
    // continues to land in listings as before. Capture errors are
    // surfaced in logs and the response summary only.
    try {
      const { error: rawErr } = await (supabase as any)
        .from('listings_raw')
        .insert({
          source_id:  source.id,
          foreign_id: item.foreign_id,
          raw_json:   item,
        })
      if (rawErr) {
        // Unique violation on identical re-push is expected and benign.
        const isDupOk = (rawErr as any).code === '23505'
        if (!isDupOk) {
          logger.warn(
            { err: rawErr.message, op: 'listings.ingest.raw_capture', foreign_id: item.foreign_id },
            'raw_capture_failed',
          )
        }
      } else {
        raw_captured += 1
      }
    } catch (err: any) {
      logger.warn(
        { err: err?.message, op: 'listings.ingest.raw_capture', foreign_id: item.foreign_id },
        'raw_capture_threw',
      )
    }

    try {
      // Look up existing.
      const { data: existing, error: lookupErr } = await (supabase as any)
        .from('listings')
        .select('id')
        .eq('source_id', source.id)
        .eq('foreign_id', item.foreign_id)
        .maybeSingle()

      if (lookupErr) throw new Error(lookupErr.message)

      if (existing?.id) {
        const { error: updateErr } = await (supabase as any)
          .from('listings')
          .update(payload)
          .eq('id', existing.id)
        if (updateErr) throw new Error(updateErr.message)
        updated += 1
      } else {
        const { error: insertErr } = await (supabase as any)
          .from('listings')
          .insert(payload)
        if (insertErr) throw new Error(insertErr.message)
        inserted += 1
      }
    } catch (err: any) {
      errors.push({
        foreign_id: item.foreign_id,
        reason: err?.message || String(err),
      })
    }
  }

  // Stamp last_ingested_at regardless of partial failures â€” the run
  // happened. Errors carry per-row detail.
  await (supabase as any)
    .from('listing_sources')
    .update({ last_ingested_at: now })
    .eq('id', source.id)

  // Persist a run record so admins can see ingestion trend + error
  // rate without grep-ing logs. Insert is best-effort â€” a failed
  // run-record write must NOT fail the response (we already committed
  // the listing rows). Captures duration via a startedAt closure.
  const durationMs = Date.now() - startedAtMs
  try {
    const { error: runErr } = await (supabase as any)
      .from('listing_source_ingest_runs')
      .insert({
        source_id: source.id,
        processed: body.listings.length,
        inserted,
        updated,
        errors_count: errors.length,
        // Cap stored errors at 50 to bound row size â€” partners doing
        // 500-row batches with everything failing would otherwise
        // bloat the table. Full list still in logs.
        errors: errors.slice(0, 50),
        triggered_by: triggeredBy,
        duration_ms: durationMs,
      })
    if (runErr) {
      logger.warn(
        { err: runErr.message, op: 'listings.ingest.run_record' },
        'ingest_run_record_failed',
      )
    }
  } catch (err: any) {
    logger.warn(
      { err: err?.message, op: 'listings.ingest.run_record' },
      'ingest_run_record_threw',
    )
  }

  // Roll the per-run outcome into source_health (mig 510000006 + 513000003).
  // Best-effort — health observability must never gate the response.
  // Success criterion mirrors record_source_health's rolling % rule:
  // a run is "successful" when no per-row errors AND at least one row
  // was inserted or updated. Pure-error runs and zero-change runs
  // count as failures so the SLO surfaces actual data-movement health.
  const ingestSucceeded =
    errors.length === 0 && (inserted + updated) > 0
  try {
    const { error: healthErr } = await (supabase as any).rpc(
      'record_source_health',
      {
        p_source_id:   source.id,
        p_success:     ingestSucceeded,
        p_duration_ms: durationMs,
      },
    )
    if (healthErr) {
      logger.warn(
        { err: healthErr.message, op: 'listings.ingest.source_health' },
        'source_health_record_failed',
      )
    }
  } catch (err: any) {
    logger.warn(
      { err: err?.message, op: 'listings.ingest.source_health' },
      'source_health_record_threw',
    )
  }

  // Refresh the public MV so the imported rows surface on the
  // marketplace within seconds, not minutes.
  await refreshListingDetails(supabase as any, 'listings.ingest')

  // Single summary audit event with counts (vs. N noisy listing.created).
  await logActivity({
    event,
    client: supabase,
    action: 'listing.ingested',
    entity: 'listing',
    metadata: {
      source_id: source.id,
      source_slug: source.slug,
      processed: body.listings.length,
      inserted,
      updated,
      errors: errors.length,
      triggered_by: triggeredBy,
    },
  })

  // Outbound webhook fan-out â€” single batch event, NOT one per listing
  // (matches the audit pattern). Partner integrations subscribe to
  // 'listing.ingested' to know a fresh ingest cycle just completed.
  // Only fires when the run actually moved data; pure-error runs
  // shouldn't notify partners.
  if (inserted > 0 || updated > 0) {
    dispatchWebhook('listing.ingested', {
      source_id: source.id,
      source_slug: source.slug,
      processed: body.listings.length,
      inserted,
      updated,
      errors: errors.length,
      triggered_by: triggeredBy,
      ingested_at: new Date().toISOString(),
    }).catch((err: unknown) => {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          op: 'listings.ingest.webhook_dispatch',
          source_id: source.id,
        },
        'listing_ingested_webhook_dispatch_threw',
      )
    })
  }

  return {
    processed: body.listings.length,
    inserted,
    updated,
    raw_captured,
    errors,
    source: {
      slug: source.slug,
      last_ingested_at: now,
    },
    triggered_by: triggeredBy,
  }
})
