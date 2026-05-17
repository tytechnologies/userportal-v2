// Typesense client wrapper.
//
// Thin fetch-based client — no SDK dependency, no extra package bump.
// Lives behind the runtime config so the same code path works both
// for the userportal indexer (writes) and the website (reads, once
// it migrates off Postgres FTS in the search-cutover step).
//
// Env vars (server-side only):
//   TYPESENSE_HOST       — e.g. 'https://search.example.com'
//   TYPESENSE_API_KEY    — admin key (write-capable). Reads use a
//                          search-only key handled separately on the
//                          website side.
//
// When env vars are unset, the helper returns { enabled: false } and
// every operation no-ops gracefully — the system stays Postgres-FTS
// only until the operator provisions Typesense.

import { logger } from './logger'

type TypesenseConfig = {
  host: string
  apiKey: string
}

export type SearchDocument = {
  id: string                 // property_id stringified
  property_id: number
  primary_listing_id: number | null
  internal_authoritative: boolean
  title: string
  description?: string
  city_id?: number
  city_name?: string
  city_slug?: string
  barangay_id?: number
  barangay_name?: string
  barangay_slug?: string
  property_category?: string
  property_type?: string
  bedrooms?: number
  bathrooms?: number
  floor_area?: number
  for_sale?: boolean
  for_rent?: boolean
  sale_price?: number
  rent_price?: number
  has_photos?: boolean
  source_ids?: number[]
  variant_count?: number
  geom?: [number, number]   // [lng, lat] for Typesense geo
  updated_at?: number       // unix seconds
}

const COLLECTION_NAME = 'properties'

function getConfig(): TypesenseConfig | null {
  const host = process.env.TYPESENSE_HOST
  const apiKey = process.env.TYPESENSE_API_KEY
  if (!host || !apiKey) return null
  return { host: host.replace(/\/+$/, ''), apiKey }
}

export function isTypesenseEnabled(): boolean {
  return getConfig() !== null
}

async function typesenseFetch(
  cfg: TypesenseConfig,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${cfg.host}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-TYPESENSE-API-KEY': cfg.apiKey,
      ...(init.headers || {}),
    },
  })
}

// Document upsert. The collection schema is created lazily on first
// write (createCollectionIfMissing) so the operator doesn't need to
// bootstrap separately.
export async function upsertDocument(doc: SearchDocument): Promise<{ ok: boolean; error?: string }> {
  const cfg = getConfig()
  if (!cfg) return { ok: false, error: 'typesense not configured' }

  try {
    await createCollectionIfMissing(cfg)
    const res = await typesenseFetch(cfg, `/collections/${COLLECTION_NAME}/documents?action=upsert`, {
      method: 'POST',
      body: JSON.stringify(doc),
    })
    if (!res.ok) {
      const text = await res.text()
      return { ok: false, error: `typesense upsert ${res.status}: ${text}` }
    }
    return { ok: true }
  } catch (err: any) {
    logger.warn(
      { err: err?.message, op: 'typesense.upsertDocument', id: doc.id },
      'typesense_upsert_threw',
    )
    return { ok: false, error: err?.message || String(err) }
  }
}

export async function deleteDocument(id: string): Promise<{ ok: boolean; error?: string }> {
  const cfg = getConfig()
  if (!cfg) return { ok: false, error: 'typesense not configured' }

  try {
    const res = await typesenseFetch(cfg, `/collections/${COLLECTION_NAME}/documents/${id}`, {
      method: 'DELETE',
    })
    if (!res.ok && res.status !== 404) {
      const text = await res.text()
      return { ok: false, error: `typesense delete ${res.status}: ${text}` }
    }
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) }
  }
}

// Idempotent. If the collection exists Typesense returns 409; we
// swallow that. Schema reflects the SearchDocument shape above.
async function createCollectionIfMissing(cfg: TypesenseConfig): Promise<void> {
  const res = await typesenseFetch(cfg, `/collections/${COLLECTION_NAME}`)
  if (res.ok) return

  const schema = {
    name: COLLECTION_NAME,
    fields: [
      { name: 'property_id',            type: 'int64' },
      { name: 'primary_listing_id',     type: 'int64', optional: true },
      { name: 'internal_authoritative', type: 'bool',  facet: true },
      { name: 'title',                  type: 'string' },
      { name: 'description',            type: 'string', optional: true },
      { name: 'city_id',                type: 'int32',  optional: true, facet: true },
      { name: 'city_name',              type: 'string', optional: true, facet: true },
      { name: 'city_slug',              type: 'string', optional: true },
      { name: 'barangay_id',            type: 'int32',  optional: true, facet: true },
      { name: 'barangay_name',          type: 'string', optional: true, facet: true },
      { name: 'barangay_slug',          type: 'string', optional: true },
      { name: 'property_category',      type: 'string', optional: true, facet: true },
      { name: 'property_type',          type: 'string', optional: true, facet: true },
      { name: 'bedrooms',               type: 'int32',  optional: true, facet: true },
      { name: 'bathrooms',              type: 'int32',  optional: true },
      { name: 'floor_area',             type: 'int32',  optional: true },
      { name: 'for_sale',               type: 'bool',   optional: true, facet: true },
      { name: 'for_rent',               type: 'bool',   optional: true, facet: true },
      { name: 'sale_price',             type: 'int64',  optional: true },
      { name: 'rent_price',             type: 'int64',  optional: true },
      { name: 'has_photos',             type: 'bool',   optional: true, facet: true },
      { name: 'source_ids',             type: 'int32[]', optional: true, facet: true },
      { name: 'variant_count',          type: 'int32',  optional: true },
      { name: 'geom',                   type: 'geopoint', optional: true },
      { name: 'updated_at',             type: 'int64',  optional: true, sort: true },
    ],
    default_sorting_field: 'updated_at',
  }

  const createRes = await typesenseFetch(cfg, '/collections', {
    method: 'POST',
    body: JSON.stringify(schema),
  })
  if (!createRes.ok && createRes.status !== 409) {
    const text = await createRes.text()
    throw new Error(`typesense create collection ${createRes.status}: ${text}`)
  }
}

// Search — used by the future engine-flag path on the website.
export type SearchQuery = {
  q?: string
  filter_by?: string
  sort_by?: string
  page?: number
  per_page?: number
}

export async function searchProperties(query: SearchQuery): Promise<unknown> {
  const cfg = getConfig()
  if (!cfg) throw new Error('typesense not configured')

  const params = new URLSearchParams()
  params.set('q', query.q ?? '*')
  params.set('query_by', 'title,description,city_name,barangay_name')
  if (query.filter_by) params.set('filter_by', query.filter_by)
  if (query.sort_by)   params.set('sort_by',   query.sort_by)
  params.set('page',     String(query.page     ?? 1))
  params.set('per_page', String(query.per_page ?? 20))

  const res = await typesenseFetch(cfg, `/collections/${COLLECTION_NAME}/documents/search?${params.toString()}`)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`typesense search ${res.status}: ${text}`)
  }
  return res.json()
}
