// Internal — live external search aggregator.
//
// POST /api/internal/live-search
// Auth: x-internal-secret header matching INTERNAL_CRON_SECRET.
//
// Called by the website's hybrid orchestrator
// (`/api/public/search-hybrid`) on every user query. Returns
// normalized external candidates within a strict deadline.
//
// Flow:
//   1. Validate body (query text + filters).
//   2. Hash the normalized query → cache key.
//   3. Read live_search_cache. On hit (not expired) return immediately.
//   4. On miss, fan out to every enabled source_connector, respecting:
//        - per-provider domain_allowlist
//        - per-provider daily budget (consumeTavilyBudget)
//        - global deadline (passed in OR default 1500ms)
//   5. Run adapter on raw results → ExternalCandidate[].
//   6. UPSERT into external_listing_candidates (bump surface counters).
//   7. Write live_search_cache row with TTL from connector config.
//   8. Return { candidates, providers: {...} } with per-provider
//      status (ok|cache|timeout|error|budget_exhausted).
//
// Hot-path failure modes:
//   - All providers timed out → candidates=[], providers shows timeouts.
//   - DB write fails → candidates still returned (best-effort persist).
//   - Cache lookup fails → treated as miss; the live fetch proceeds.

import { z } from 'zod'
import { createHash, timingSafeEqual } from 'node:crypto'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { tavilySearch, consumeTavilyBudget, isTavilyEnabled } from '~~/server/utils/tavily'
import { adaptTavilyResult, type ExternalCandidate } from '~~/server/utils/externalProviderAdapter'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  q: z.string().trim().min(1).max(240),
  for_sale: z.boolean().optional(),
  for_rent: z.boolean().optional(),
  property_type: z.string().max(40).optional(),
  city_slug: z.string().max(80).optional(),
  bedrooms: z.coerce.number().int().min(0).max(20).optional(),
  // Hard per-request budget. Default 1500ms — the architecture spec.
  deadline_ms: z.coerce.number().int().min(200).max(5000).default(1500),
  // Force a re-fetch even if cache is fresh (admin debugging).
  bypass_cache: z.boolean().default(false),
  // Caller origin for telemetry. Not auth — already gated above.
  origin: z.enum(['website', 'portal', 'api']).default('website'),
})

type Connector = {
  slug: string
  provider_kind: 'tavily_search' | 'partner_feed' | 'static_url'
  enabled: boolean
  domain_allowlist: string[] | null
  trust_score: number
  daily_budget: number
  default_ttl_seconds: number
  config: { search_depth?: 'basic' | 'advanced'; max_results?: number }
}

type ProviderStatus = {
  status: 'ok' | 'cache' | 'timeout' | 'error' | 'budget_exhausted' | 'disabled'
  count: number
  ms: number
  message?: string
}

function authorized(provided: string | undefined, expected: string | null | undefined): boolean {
  if (!provided || !expected) return false
  const a = Buffer.from(provided.trim(), 'utf8')
  const b = Buffer.from(expected.trim(), 'utf8')
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function hashQuery(input: Record<string, unknown>, providerSlug: string): {
  cacheKey: string
  queryHash: string
} {
  // Key-sort + lowercase the query so logically-identical queries
  // collapse to one cache row.
  const normalized: Record<string, unknown> = {}
  for (const k of Object.keys(input).sort()) {
    const v = (input as any)[k]
    normalized[k] = typeof v === 'string' ? v.toLowerCase().trim() : v
  }
  const h = createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 32)
  return { cacheKey: `${providerSlug}:${h}`, queryHash: h }
}

async function withDeadline<T>(p: Promise<T>, ms: number, tag: string): Promise<T> {
  let to: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, rej) => {
        to = setTimeout(() => rej(new Error(`deadline:${tag}:${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (to) clearTimeout(to)
  }
}

async function runConnector(
  connector: Connector,
  q: z.infer<typeof bodySchema>,
  deadlineMs: number,
  supabase: any,
): Promise<{ candidates: ExternalCandidate[]; status: ProviderStatus }> {
  const start = Date.now()
  try {
    // Cache read.
    const { cacheKey } = hashQuery(
      { q: q.q, for_sale: q.for_sale, for_rent: q.for_rent,
        property_type: q.property_type, city_slug: q.city_slug,
        bedrooms: q.bedrooms },
      connector.slug,
    )

    if (!q.bypass_cache) {
      const { data: cached } = await supabase
        .from('live_search_cache')
        .select('payload, expires_at')
        .eq('cache_key', cacheKey)
        .maybeSingle()
      if (cached && new Date(cached.expires_at).getTime() > Date.now()) {
        // Cache hit. Bump counters in background — don't block the
        // response on this write. .catch() per the no-void-promises
        // memory.
        supabase
          .from('live_search_cache')
          .update({
            hit_count: ((supabase as any).rpc ? undefined : 0) ?? 0,
            last_hit_at: new Date().toISOString(),
          })
          .eq('cache_key', cacheKey)
          .then(() => undefined)
          .catch((err: any) =>
            logger.warn({ err: err?.message, op: 'cache.hit-update' }, 'cache_hit_bump_failed'),
          )
        const payload = (cached.payload || []) as ExternalCandidate[]
        return {
          candidates: payload,
          status: {
            status: 'cache',
            count: payload.length,
            ms: Date.now() - start,
          },
        }
      }
    }

    if (connector.provider_kind !== 'tavily_search') {
      // Partner-feed / static-url are out-of-band ingest, not
      // live-search providers (yet). Mark disabled so the orchestrator
      // sees them in the breakdown without burning budget.
      return {
        candidates: [],
        status: { status: 'disabled', count: 0, ms: Date.now() - start, message: 'non-live provider kind' },
      }
    }

    if (!isTavilyEnabled()) {
      return {
        candidates: [],
        status: { status: 'disabled', count: 0, ms: Date.now() - start, message: 'TAVILY_API_KEY unset' },
      }
    }

    const budgetOk = await consumeTavilyBudget(supabase, 'discovery', connector.daily_budget)
    if (!budgetOk) {
      return {
        candidates: [],
        status: { status: 'budget_exhausted', count: 0, ms: Date.now() - start },
      }
    }

    // Build the discovery query — append PH context so Tavily focuses.
    const txnHint =
      q.for_sale === true ? ' for sale' :
      q.for_rent === true ? ' for rent' : ''
    const tavilyQuery =
      `${q.q}${txnHint} Philippines real estate listing`.slice(0, 240)

    const tavilyPromise = tavilySearch({
      query: tavilyQuery,
      max_results: connector.config.max_results ?? 10,
      search_depth: connector.config.search_depth ?? 'basic',
      include_domains: connector.domain_allowlist ?? undefined,
      include_images: true,
    })

    const raw = await withDeadline(tavilyPromise, deadlineMs, connector.slug)

    // Tavily returns `images` as a query-level array (not per-result).
    // Assign by index as a best-effort association — the i-th result
    // gets the i-th image. Hits past the image array fall back to null
    // and the card renders the placeholder. Acceptable since Tavily
    // ranks images by relevance to the query, which aligns reasonably
    // with the result ordering.
    const images = Array.isArray(raw.images) ? raw.images : []
    const candidates: ExternalCandidate[] = []
    const results = raw.results ?? []
    for (let i = 0; i < results.length; i++) {
      const c = adaptTavilyResult(results[i], connector.slug, images[i] ?? null)
      if (c) candidates.push(c)
    }

    // Persist cache + candidate rows. Best-effort.
    const expiresAt = new Date(Date.now() + connector.default_ttl_seconds * 1000).toISOString()
    const cachePromise = supabase
      .from('live_search_cache')
      .upsert(
        {
          cache_key: cacheKey,
          provider_slug: connector.slug,
          query_hash: hashQuery({ q: q.q }, connector.slug).queryHash,
          query_input: {
            q: q.q,
            for_sale: q.for_sale ?? null,
            for_rent: q.for_rent ?? null,
            property_type: q.property_type ?? null,
            city_slug: q.city_slug ?? null,
            bedrooms: q.bedrooms ?? null,
          },
          payload: candidates,
          result_count: candidates.length,
          fetched_at: new Date().toISOString(),
          expires_at: expiresAt,
        },
        { onConflict: 'cache_key' },
      )
      .then(() => undefined)
      .catch((err: any) =>
        logger.warn({ err: err?.message, op: 'cache.write' }, 'cache_write_failed'),
      )

    const candidateRows = candidates.map((c) => ({
      provider_slug:   c.provider_slug,
      source_url:      c.source_url,
      source_domain:   c.source_domain,
      title:           c.title,
      price:           c.price,
      currency:        c.currency,
      for_sale:        c.for_sale,
      for_rent:        c.for_rent,
      property_type:   c.property_type,
      bedrooms:        c.bedrooms,
      bathrooms:       c.bathrooms,
      floor_area:      c.floor_area,
      lot_area:        c.lot_area,
      address:         c.address,
      city_slug:       c.city_slug,
      barangay_slug:   c.barangay_slug,
      latitude:        c.latitude,
      longitude:       c.longitude,
      thumbnail_url:   c.thumbnail_url,
      description:     c.description,
      parse_confidence: c.parse_confidence,
      raw_payload:     c.raw_payload,
      last_surfaced_at: new Date().toISOString(),
    }))
    const candidatePromise = candidateRows.length === 0
      ? Promise.resolve()
      : supabase
          .from('external_listing_candidates')
          .upsert(candidateRows, {
            onConflict: 'provider_slug,source_url',
            ignoreDuplicates: false,
          })
          .then(() => undefined)
          .catch((err: any) =>
            logger.warn({ err: err?.message, op: 'candidates.upsert' }, 'candidate_upsert_failed'),
          )

    // Fire-and-monitor: don't block the response on durable writes.
    Promise.all([cachePromise, candidatePromise]).catch(() => undefined)

    return {
      candidates,
      status: { status: 'ok', count: candidates.length, ms: Date.now() - start },
    }
  } catch (err: any) {
    const msg = String(err?.message ?? err)
    const isTimeout = msg.startsWith('deadline:')
    return {
      candidates: [],
      status: {
        status: isTimeout ? 'timeout' : 'error',
        count: 0,
        ms: Date.now() - start,
        message: msg.slice(0, 200),
      },
    }
  }
}

export default defineEventHandler(async (event) => {
  const expected = process.env.INTERNAL_CRON_SECRET
  const provided = getRequestHeader(event, 'x-internal-secret')
  if (!authorized(provided, expected)) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  const parsed = bodySchema.safeParse((await readBody(event)) ?? {})
  if (!parsed.success) {
    throw createError({
      statusCode: 422,
      statusMessage: 'Invalid body',
      data: { issues: parsed.error.issues },
    })
  }
  const body = parsed.data

  const supabase = getServerSupabaseAdmin()

  // Load enabled connectors.
  const { data: connectorsRaw, error: connErr } = await supabase
    .from('source_connectors')
    .select('slug, provider_kind, enabled, domain_allowlist, trust_score, daily_budget, default_ttl_seconds, config')
    .eq('enabled', true)
    .order('trust_score', { ascending: false })
  if (connErr) {
    logger.error({ err: connErr.message, op: 'live-search.connectors' }, 'connector_lookup_failed')
    return { candidates: [], providers: {}, degraded: true as const }
  }
  const connectors = (connectorsRaw || []) as Connector[]

  if (connectors.length === 0) {
    return { candidates: [], providers: {}, degraded: false as const }
  }

  // Per-provider deadline — share the overall budget evenly. Provides
  // a hard ceiling so a slow provider never starves a fast one.
  const perProvDeadline = Math.max(300, Math.floor(body.deadline_ms / connectors.length))

  const settled = await Promise.allSettled(
    connectors.map((c) => runConnector(c, body, perProvDeadline, supabase)),
  )

  const providers: Record<string, ProviderStatus & { trust: number }> = {}
  const candidates: (ExternalCandidate & { provider_trust: number })[] = []
  for (let i = 0; i < settled.length; i++) {
    const c = connectors[i]
    const r = settled[i]
    if (r.status === 'fulfilled') {
      providers[c.slug] = { ...r.value.status, trust: c.trust_score }
      for (const cand of r.value.candidates) {
        candidates.push({ ...cand, provider_trust: c.trust_score })
      }
    } else {
      providers[c.slug] = {
        status: 'error',
        count: 0,
        ms: 0,
        message: String(r.reason).slice(0, 200),
        trust: c.trust_score,
      }
    }
  }

  const degraded = Object.values(providers).some(
    (p) => p.status === 'timeout' || p.status === 'error',
  )

  return { candidates, providers, degraded }
})
