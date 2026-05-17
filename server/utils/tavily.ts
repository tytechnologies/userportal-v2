// Tavily API wrapper — enrichment + discovery only.
//
// Per the architecture constraint from the audit:
//   Tavily is NEVER on the public read path. It is ONLY used in
//   userportal-side enrichment + source discovery + (optional)
//   semantic dedup hint for borderline duplicate pairs.
//
// All calls are budgeted via the rate_limit_buckets table (mig
// 506000016) so quota burn is observable + cappable. When
// TAVILY_API_KEY is unset, the helper returns { enabled: false } and
// every operation no-ops gracefully — admin endpoints surface this
// state to the operator.

import { logger } from './logger'

export function isTavilyEnabled(): boolean {
  return !!process.env.TAVILY_API_KEY
}

type TavilySearchResult = {
  title: string
  url: string
  content: string
  score?: number
  published_date?: string
}

type TavilySearchResponse = {
  query: string
  results: TavilySearchResult[]
  answer?: string
  // Present only when the caller passes `include_images: true`. Tavily
  // returns a top-level array of image URLs ordered by relevance to
  // the QUERY (not per-result). Callers assign by index as a
  // best-effort thumbnail association.
  images?: string[]
}

const BASE_URL = 'https://api.tavily.com'
const SEARCH_PATH = '/search'
const EXTRACT_PATH = '/extract'

// Generic search. Returns up to `max_results` matches.
// `search_depth` 'advanced' is more thorough (and more expensive).
// Use 'basic' by default; admins can request 'advanced' explicitly.
//
// `include_images` requests Tavily's top-relevance image set for the
// query (top-level `images: string[]` on the response). No extra
// budget cost beyond the search call itself per Tavily's docs.
export async function tavilySearch(opts: {
  query: string
  max_results?: number
  search_depth?: 'basic' | 'advanced'
  include_domains?: string[]
  exclude_domains?: string[]
  include_images?: boolean
}): Promise<TavilySearchResponse> {
  if (!isTavilyEnabled()) throw new Error('tavily not configured')

  const res = await fetch(`${BASE_URL}${SEARCH_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key:         process.env.TAVILY_API_KEY,
      query:           opts.query,
      max_results:     opts.max_results ?? 5,
      search_depth:    opts.search_depth ?? 'basic',
      include_domains: opts.include_domains,
      exclude_domains: opts.exclude_domains,
      include_images:  opts.include_images ?? false,
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`tavily search ${res.status}: ${text}`)
  }
  return (await res.json()) as TavilySearchResponse
}

// Extract — fetch and convert a single URL into clean text. Useful
// for ingesting structured info from a known partner page.
export async function tavilyExtract(opts: {
  urls: string[]
}): Promise<{ results: Array<{ url: string; raw_content: string }> }> {
  if (!isTavilyEnabled()) throw new Error('tavily not configured')

  const res = await fetch(`${BASE_URL}${EXTRACT_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      urls:    opts.urls,
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`tavily extract ${res.status}: ${text}`)
  }
  return await res.json()
}

// Soft rate-limit guard — uses rate_limit_buckets (mig 506000016).
// Schema:
//   bucket_key   text   PK
//   period_start timestamptz
//   count        int
// We coalesce per-day per-bucket; budget is enforced in JS, the DB
// just gives us a durable counter that survives restarts. Returns
// `true` when the call is within budget; `false` when over.
export async function consumeTavilyBudget(
  supabase: any,
  bucket: 'discovery' | 'enrichment' | 'dedup_hint',
  dailyMax: number,
): Promise<boolean> {
  try {
    const key = `tavily.${bucket}.${new Date().toISOString().slice(0, 10)}`
    const { data, error } = await supabase
      .from('rate_limit_buckets')
      .select('count')
      .eq('bucket_key', key)
      .maybeSingle()
    if (error) {
      logger.warn(
        { err: error.message, op: 'tavily.consumeBudget', bucket },
        'tavily_budget_lookup_failed',
      )
      return true // fail-open; we've logged the visibility loss
    }
    const current = Number(data?.count ?? 0)
    if (current >= dailyMax) return false

    await supabase
      .from('rate_limit_buckets')
      .upsert(
        {
          bucket_key:   key,
          period_start: new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').toISOString(),
          count:        current + 1,
        },
        { onConflict: 'bucket_key' },
      )
    return true
  } catch (err: any) {
    logger.warn(
      { err: err?.message, op: 'tavily.consumeBudget', bucket },
      'tavily_budget_threw',
    )
    return true
  }
}
