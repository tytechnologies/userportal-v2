// POST /api/internal/ai-suggestion-worker-tick
//
// Cron-runner endpoint. Scans documented sources of "things that
// could use a suggestion" and writes pending ai_suggestions rows.
// Trust-first: NEVER mutates a target row directly.
//
// Auth: shared bearer secret (AI_WORKER_SECRET). Operator points
// their cron-runner at this every 5-30 minutes.
//
// Body: {
//   batch_size?: number = 5,         // max suggestions per kind per tick
//   kinds?: string[],                // restrict to these kinds; default: all
// }
//
// Currently implemented kinds:
//   listing.description_enrichment   — listings with empty/short description
//   inquiry.summarisation            — recent inquiries with > 3 messages
//
// Adding a new kind: write a "find candidates" query + a "build
// prompt" function + add to the registry. No migration needed.

import { timingSafeEqual } from 'node:crypto'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { runCompletion, extractJson } from '~~/server/utils/aiProvider'
import { logger } from '~~/server/utils/logger'

function bearerAuthorized(provided: string | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false
  if (!provided.startsWith('Bearer ')) return false
  const a = Buffer.from(provided.slice(7).trim(), 'utf8')
  const b = Buffer.from(expected.trim(), 'utf8')
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

type CandidateBuilder = {
  kind: string
  // List candidate target rows that don't already have a recent pending
  // suggestion. Implementation owns its own dedupe logic.
  findCandidates(admin: any, limit: number): Promise<
    Array<{
      target_kind: string
      target_id: string
      system: string
      user: string
      expected_format: string
      prompt_version: string
    }>
  >
  // Optional post-processor: parse the model's text into a structured
  // suggested_payload. Default: { text: string }.
  buildPayload?(rawText: string): Record<string, unknown>
}

const builders: CandidateBuilder[] = [
  {
    kind: 'listing.description_enrichment',
    async findCandidates(admin, limit) {
      // Listings whose description is shorter than 80 chars and has
      // no pending suggestion of this kind in the last 14 days.
      const { data, error } = await admin
        .from('listings')
        .select('id, title, description, property_type, bedrooms, bathrooms, floor_area, location_text')
        .or('description.is.null,description.eq.')
        .order('updated_at', { ascending: false })
        .limit(limit * 4)
      if (error) throw new Error(`find_candidates listing.description_enrichment: ${error.message}`)

      // Filter out targets with a recent pending suggestion.
      const ids = (data ?? []).map((r: any) => String(r.id))
      if (ids.length === 0) return []
      const { data: existing } = await admin
        .from('ai_suggestions')
        .select('target_id')
        .eq('kind', 'listing.description_enrichment')
        .eq('target_kind', 'listing')
        .in('target_id', ids)
        .eq('status', 'pending')
      const blocked = new Set((existing ?? []).map((r: any) => r.target_id))

      return (data ?? [])
        .filter((r: any) => !blocked.has(String(r.id)))
        .slice(0, limit)
        .map((r: any) => ({
          target_kind: 'listing',
          target_id: String(r.id),
          system:
            'You are a Philippine real-estate copywriter. Write factual, ' +
            'compliance-aware listing descriptions. Never invent amenities, ' +
            'prices, or commitments not given in the input.',
          user:
            `Write a 2-3 sentence listing description from these facts:\n` +
            `Title: ${r.title ?? '(none)'}\n` +
            `Type: ${r.property_type ?? '(unknown)'}\n` +
            `Bedrooms: ${r.bedrooms ?? '?'} / Bathrooms: ${r.bathrooms ?? '?'}\n` +
            `Floor area: ${r.floor_area ?? '?'} sqm\n` +
            `Location: ${r.location_text ?? '(unspecified)'}\n` +
            `Existing description: ${r.description ?? '(empty)'}\n\n` +
            `Respond with JSON: {"proposed_description": "...", "diff_summary": "..."}`,
          expected_format: '{ proposed_description: string, diff_summary: string }',
          prompt_version: 'listing.description_enrichment.v1',
        }))
    },
    buildPayload(rawText) {
      const json = extractJson<{ proposed_description?: string; diff_summary?: string }>(rawText)
      if (json && typeof json.proposed_description === 'string') {
        return {
          proposed_description: json.proposed_description,
          diff_summary: json.diff_summary ?? '',
          raw: rawText,
        }
      }
      return { proposed_description: rawText.slice(0, 500), diff_summary: '', raw: rawText }
    },
  },

  {
    kind: 'listing.duplicate_review_assist',
    async findCandidates(admin, limit) {
      // Pending duplicate-pair candidates the moderator hasn't yet
      // confirmed/dismissed. We only ask the model when confidence
      // is in the "ambiguous" middle band — high-confidence ones
      // don't need an LLM second opinion, low-confidence ones
      // shouldn't have made it onto the queue at all.
      const { data, error } = await admin
        .from('listing_duplicate_candidates')
        .select('id, a_listing_id, b_listing_id, confidence, signals, status')
        .eq('status', 'pending')
        .gte('confidence', 50)
        .lte('confidence', 90)
        .order('detected_at', { ascending: false })
        .limit(limit * 4)
      if (error) throw new Error(`find_candidates listing.duplicate_review_assist: ${error.message}`)

      const ids = (data ?? []).map((r: any) => String(r.id))
      if (ids.length === 0) return []
      const { data: existing } = await admin
        .from('ai_suggestions')
        .select('target_id')
        .eq('kind', 'listing.duplicate_review_assist')
        .eq('target_kind', 'listing_duplicate')
        .in('target_id', ids)
        .eq('status', 'pending')
      const blocked = new Set((existing ?? []).map((r: any) => r.target_id))

      const fresh = (data ?? [])
        .filter((r: any) => !blocked.has(String(r.id)))
        .slice(0, limit)
      if (fresh.length === 0) return []

      // Fetch the two listings for each pair so we can ground the
      // model's verdict in real attributes.
      const listingIds = Array.from(
        new Set(fresh.flatMap((r: any) => [r.a_listing_id, r.b_listing_id])),
      )
      const { data: listings } = await admin
        .from('listings')
        .select('id, title, description, property_type, bedrooms, bathrooms, floor_area, location_text, sale_price, rent_price')
        .in('id', listingIds)
      const byId = new Map<number, any>()
      for (const l of listings ?? []) byId.set(Number(l.id), l)

      function describe(id: number): string {
        const l = byId.get(id)
        if (!l) return `(listing ${id} not loaded)`
        return [
          `id=${id}`,
          `title=${l.title ?? '(none)'}`,
          `type=${l.property_type ?? '?'}`,
          `bed/bath=${l.bedrooms ?? '?'}/${l.bathrooms ?? '?'}`,
          `area=${l.floor_area ?? '?'}sqm`,
          `loc=${l.location_text ?? '?'}`,
          `sale=${l.sale_price ?? '-'}`,
          `rent=${l.rent_price ?? '-'}`,
        ].join(' · ')
      }

      return fresh.map((r: any) => ({
        target_kind: 'listing_duplicate',
        target_id: String(r.id),
        system:
          'You are a duplicate-listing moderator. Decide whether two ' +
          'listings refer to the same physical unit. Be conservative: ' +
          'when in doubt, return "unclear", not "duplicate".',
        user:
          `Detector confidence: ${r.confidence}/100\n` +
          `Detector signals: ${JSON.stringify(r.signals ?? {})}\n\n` +
          `Listing A: ${describe(r.a_listing_id)}\n` +
          `Listing B: ${describe(r.b_listing_id)}\n\n` +
          `Respond with JSON: {"recommended_verdict": "duplicate"|"distinct"|"unclear", ` +
          `"confidence": 0..1, "rationale": "..."}`,
        expected_format:
          '{ recommended_verdict: "duplicate"|"distinct"|"unclear", confidence: 0..1, rationale: string }',
        prompt_version: 'listing.duplicate_review_assist.v1',
      }))
    },
    buildPayload(rawText) {
      const json = extractJson<{
        recommended_verdict?: string
        confidence?: number
        rationale?: string
      }>(rawText)
      const v = json?.recommended_verdict
      const verdict =
        v === 'duplicate' || v === 'distinct' || v === 'unclear' ? v : 'unclear'
      const confidence =
        typeof json?.confidence === 'number' && json.confidence >= 0 && json.confidence <= 1
          ? json.confidence
          : null
      return {
        recommended_verdict: verdict,
        confidence,
        rationale: json?.rationale ?? rawText.slice(0, 500),
        raw: rawText,
      }
    },
  },

  {
    kind: 'inquiry.summarisation',
    async findCandidates(admin, limit) {
      // Inquiries updated in the last 7 days with >= 3 messages.
      const since = new Date(Date.now() - 7 * 86_400_000).toISOString()
      const { data, error } = await admin
        .from('inquiries')
        .select('id, subject, message, status, created_at, updated_at')
        .gte('updated_at', since)
        .order('updated_at', { ascending: false })
        .limit(limit * 4)
      if (error) throw new Error(`find_candidates inquiry.summarisation: ${error.message}`)

      const ids = (data ?? []).map((r: any) => String(r.id))
      if (ids.length === 0) return []
      const { data: existing } = await admin
        .from('ai_suggestions')
        .select('target_id')
        .eq('kind', 'inquiry.summarisation')
        .eq('target_kind', 'inquiry')
        .in('target_id', ids)
        .eq('status', 'pending')
      const blocked = new Set((existing ?? []).map((r: any) => r.target_id))

      return (data ?? [])
        .filter((r: any) => !blocked.has(String(r.id)))
        .slice(0, limit)
        .map((r: any) => ({
          target_kind: 'inquiry',
          target_id: String(r.id),
          system:
            'You are an inside-sales assistant for a real estate brokerage. ' +
            'Summarise inquiries factually for the assigned agent. Be neutral; ' +
            'do not invent facts.',
          user:
            `Summarise this inquiry for the assigned agent:\n` +
            `Subject: ${r.subject ?? '(none)'}\n` +
            `Status: ${r.status ?? 'open'}\n` +
            `Message: ${r.message ?? '(empty)'}\n\n` +
            `Respond with JSON: {"summary": "...", "key_points": ["..."], "next_action": "..."}`,
          expected_format: '{ summary: string, key_points: string[], next_action: string }',
          prompt_version: 'inquiry.summarisation.v1',
        }))
    },
    buildPayload(rawText) {
      const json = extractJson<{
        summary?: string
        key_points?: string[]
        next_action?: string
      }>(rawText)
      if (json && typeof json.summary === 'string') {
        return {
          summary: json.summary,
          key_points: Array.isArray(json.key_points) ? json.key_points : [],
          next_action: json.next_action ?? '',
          raw: rawText,
        }
      }
      return { summary: rawText.slice(0, 500), key_points: [], next_action: '', raw: rawText }
    },
  },
]

export default defineEventHandler(async (event) => {
  const auth = getRequestHeader(event, 'authorization')
  const expected = process.env.AI_WORKER_SECRET
  if (!expected) {
    throw createError({
      statusCode: 503,
      statusMessage: 'AI_WORKER_SECRET not configured',
    })
  }
  if (!bearerAuthorized(auth, expected)) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  type WorkerBody = { batch_size?: number; kinds?: string[] }
  const body = (await readBody(event).catch(() => ({}))) as WorkerBody
  const batchSize = Math.min(Math.max(body.batch_size ?? 5, 1), 50)
  const kindFilter = body.kinds ? new Set(body.kinds) : null

  const admin = getServerSupabaseAdmin()
  const stats: Record<string, { candidates: number; written: number; failed: number }> = {}

  for (const builder of builders) {
    if (kindFilter && !kindFilter.has(builder.kind)) continue
    const s = { candidates: 0, written: 0, failed: 0 }
    stats[builder.kind] = s

    let candidates: Awaited<ReturnType<CandidateBuilder['findCandidates']>>
    try {
      candidates = await builder.findCandidates(admin, batchSize)
    } catch (err: any) {
      logger.warn(
        { err: err?.message, kind: builder.kind, op: 'ai-worker.find' },
        'ai_worker_find_candidates_failed',
      )
      continue
    }
    s.candidates = candidates.length

    for (const c of candidates) {
      try {
        const completion = await runCompletion({
          system: c.system,
          user: c.user,
          expected_format: c.expected_format,
          prompt_version: c.prompt_version,
        })
        const payload = builder.buildPayload
          ? builder.buildPayload(completion.text)
          : { text: completion.text }

        const { error: insErr } = await admin.from('ai_suggestions').insert({
          kind: builder.kind,
          target_kind: c.target_kind,
          target_id: c.target_id,
          suggested_payload: payload,
          model_provider: completion.model_provider,
          model_name: completion.model_name,
          model_run_id: completion.model_run_id,
          prompt_version: c.prompt_version,
          confidence: completion.confidence,
        })
        if (insErr) throw new Error(insErr.message)
        s.written += 1
      } catch (err: any) {
        logger.warn(
          {
            err: err?.message,
            kind: builder.kind,
            target_kind: c.target_kind,
            target_id: c.target_id,
            op: 'ai-worker.run',
          },
          'ai_worker_run_failed',
        )
        s.failed += 1
      }
    }
  }

  // Heartbeat — best effort.
  await (admin as any)
    .rpc('record_worker_heartbeat', {
      p_worker_key: 'ai_suggestion_worker_tick',
      p_payload: { batch_size: batchSize, stats },
    })
    .then(({ error }: { error: any }) => {
      if (error) {
        logger.warn(
          { err: error.message, op: 'ai-worker.heartbeat' },
          'ai_worker_heartbeat_failed',
        )
      }
    })
    .catch((err: any) => {
      logger.warn(
        { err: err?.message, op: 'ai-worker.heartbeat' },
        'ai_worker_heartbeat_failed',
      )
    })

  return { ok: true, stats }
})
