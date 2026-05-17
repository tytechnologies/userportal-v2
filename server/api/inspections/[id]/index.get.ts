// Read a single inspection + its findings.
//
// GET /api/inspections/[id]
//
// Returns { inspection, findings[] }. RLS enforces visibility.
// Photos that carry a `key` (S3-managed) are enriched with a
// `display_url` — a signed download URL with 1-hour TTL — so the UI
// can render them without exposing the bucket. Photos that only
// carry a `url` (legacy / hand-pasted) are passed through untouched.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { getSignedDownloadUrl } from '~~/server/utils/s3'
import { logger } from '~~/server/utils/logger'

type RawPhoto = { url?: string; key?: string; name?: string }
type EnrichedPhoto = RawPhoto & { display_url?: string }

async function enrichPhotos(photos: unknown): Promise<EnrichedPhoto[]> {
  if (!Array.isArray(photos)) return []
  const out: EnrichedPhoto[] = []
  for (const raw of photos as RawPhoto[]) {
    if (!raw || typeof raw !== 'object') continue
    if (raw.key) {
      try {
        const display_url = await getSignedDownloadUrl(raw.key)
        out.push({ ...raw, display_url })
      } catch (err: any) {
        logger.warn(
          { err: err?.message, key: raw.key, op: 'inspections.get.photo_sign' },
          'inspection_photo_sign_failed',
        )
        // Fall back to passing the key through unenriched — UI can
        // skip rendering rather than crash.
        out.push(raw)
      }
    } else {
      out.push(raw)
    }
  }
  return out
}

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const inspectionId = getRouterParam(event, 'id')
    if (!inspectionId || !/^[0-9a-f-]{36}$/i.test(inspectionId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid inspection id' })
    }

    const supabase = await serverSupabaseClient(event)

    const { data: inspection, error: inspErr } = await (supabase as any)
      .from('inspections')
      .select('*')
      .eq('id', inspectionId)
      .maybeSingle()
    if (inspErr) {
      throw createError({ statusCode: 500, statusMessage: inspErr.message })
    }
    if (!inspection) {
      throw createError({ statusCode: 404, statusMessage: 'Inspection not found' })
    }

    const { data: findings, error: findErr } = await (supabase as any)
      .from('inspection_findings')
      .select('*')
      .eq('inspection_id', inspectionId)
      .order('area', { ascending: true })
      .order('item', { ascending: true })
    if (findErr) {
      throw createError({ statusCode: 500, statusMessage: findErr.message })
    }

    // Enrich each finding's photos with signed display URLs in
    // parallel — pure local crypto, no S3 round-trips.
    const enriched = await Promise.all(
      (findings ?? []).map(async (f: any) => ({
        ...f,
        photos: await enrichPhotos(f.photos),
      })),
    )

    // For move-out inspections, resolve baseline_finding_id pointers
    // to their full move-in finding rows + photos so the UI can render
    // a side-by-side comparison without a follow-up call. Move-in
    // baseline findings live on a different inspection entirely; we
    // pull them in one batch query and attach inline.
    const baselineIds = (enriched as Array<{ baseline_finding_id?: string | null }>)
      .map((f) => f.baseline_finding_id)
      .filter((id): id is string => !!id)
    let baselineMap = new Map<string, any>()
    if (baselineIds.length > 0) {
      // RLS still applies — admin sees all, tenant sees only baselines
      // on inspections they have access to. Skipped baselines render
      // as null in the UI (graceful).
      const { data: baselines } = await (supabase as any)
        .from('inspection_findings')
        .select('*')
        .in('id', baselineIds)
      const baselineRows = (baselines ?? []) as any[]
      const enrichedBaselines = await Promise.all(
        baselineRows.map(async (b) => ({
          ...b,
          photos: await enrichPhotos(b.photos),
        })),
      )
      baselineMap = new Map(enrichedBaselines.map((b) => [b.id, b]))
    }

    const withBaselines = enriched.map((f: any) => ({
      ...f,
      baseline: f.baseline_finding_id ? baselineMap.get(f.baseline_finding_id) ?? null : null,
    }))

    return { inspection, findings: withBaselines }
  },
})
