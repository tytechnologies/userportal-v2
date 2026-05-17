// Listing-syndication feed generator.
//
// Single source of truth for "given a syndication target, walk listings
// and serialize the feed". Used by:
//   - POST /api/admin/listing-syndication/targets/[id]/run-now (manual)
//   - GET  /syndication/[slug].json                              (pull)
//   - Future cron-driven push runs                               (push)
//
// Phase A serializes JSON only. The feed_format column already permits
// 'xml' | 'csv' | 'rss' so phase B drops in additional serializers
// without a schema change.

import type { SupabaseClient } from '@supabase/supabase-js'

export type SyndicationTarget = {
  id: string
  slug: string
  display_name: string
  feed_format: 'json' | 'xml' | 'csv' | 'rss'
  delivery_mode: 'pull' | 'push'
  include_filters: Record<string, unknown>
  max_listings_per_run: number
  status: 'active' | 'paused' | 'archived'
}

export type FeedListing = {
  id: number
  title: string | null
  description: string | null
  property_type: string | null
  bedrooms: number | null
  bathrooms: number | null
  floor_area: number | null
  sale_price: number | null
  rent_price: number | null
  city_id: number | null
  status: string | null
  created_at: string
  updated_at: string
}

export type FeedResult = {
  listings: FeedListing[]
  /** Forced-in count (operator override beat target filters) */
  forced_in: number
  /** Forced-out count (operator override removed an otherwise-eligible listing) */
  forced_out: number
}

/**
 * Resolve the eligible listing set for a target. Combines:
 *   1. include_filters (status, property_type, city, price ranges)
 *   2. force_exclude overrides (subtracted)
 *   3. force_include overrides (added even if filters wouldn't catch them)
 *
 * Caps at target.max_listings_per_run.
 */
export async function selectListingsForTarget(
  client: SupabaseClient,
  target: SyndicationTarget,
): Promise<FeedResult> {
  const filters = target.include_filters ?? {}
  // Default to active listings only — keeps a misconfigured target
  // from leaking drafts / archived rows to a partner.
  const status = (filters.status as string | string[] | undefined) ?? 'active'

  // Pull force_exclude overrides up-front so we can subtract them from
  // the listing query in one go.
  const { data: overrides, error: overridesErr } = await (client as any)
    .from('listing_syndication_overrides')
    .select('listing_id, override_kind')
    .eq('target_id', target.id)
  if (overridesErr) {
    throw new Error(`syndication overrides: ${overridesErr.message}`)
  }
  const forceExclude = new Set<number>()
  const forceInclude = new Set<number>()
  for (const o of (overrides ?? []) as Array<{ listing_id: number; override_kind: string }>) {
    if (o.override_kind === 'force_exclude') forceExclude.add(Number(o.listing_id))
    else if (o.override_kind === 'force_include') forceInclude.add(Number(o.listing_id))
  }

  // Build the filter-driven query. Use the standard listing column set;
  // syndication targets generally want titles + prices + property facts.
  let q: any = (client as any)
    .from('listings')
    .select(
      'id, title, description, property_type, bedrooms, bathrooms, floor_area, sale_price, rent_price, city_id, status, created_at, updated_at',
    )
    .order('updated_at', { ascending: false })
    .limit(target.max_listings_per_run)

  if (Array.isArray(status)) q = q.in('status', status)
  else q = q.eq('status', status)

  if (filters.property_type !== undefined) {
    if (Array.isArray(filters.property_type)) q = q.in('property_type', filters.property_type)
    else q = q.eq('property_type', filters.property_type)
  }
  if (filters.city_id !== undefined) {
    if (Array.isArray(filters.city_id)) q = q.in('city_id', filters.city_id)
    else q = q.eq('city_id', filters.city_id)
  }
  if (typeof filters.min_sale_price === 'number') q = q.gte('sale_price', filters.min_sale_price)
  if (typeof filters.max_sale_price === 'number') q = q.lte('sale_price', filters.max_sale_price)
  if (typeof filters.min_rent_price === 'number') q = q.gte('rent_price', filters.min_rent_price)
  if (typeof filters.max_rent_price === 'number') q = q.lte('rent_price', filters.max_rent_price)

  const { data: filtered, error: filteredErr } = await q
  if (filteredErr) {
    throw new Error(`syndication listings: ${filteredErr.message}`)
  }
  const filteredRows = (filtered ?? []) as FeedListing[]

  // Subtract force_exclude.
  let forced_out = 0
  const kept = filteredRows.filter((l) => {
    if (forceExclude.has(Number(l.id))) {
      forced_out += 1
      return false
    }
    return true
  })

  // Add force_include rows that the filters didn't already catch.
  const seen = new Set(kept.map((l) => Number(l.id)))
  let forced_in = 0
  if (forceInclude.size > 0) {
    const missing = Array.from(forceInclude).filter((id) => !seen.has(id))
    if (missing.length > 0) {
      const { data: extras, error: extrasErr } = await (client as any)
        .from('listings')
        .select(
          'id, title, description, property_type, bedrooms, bathrooms, floor_area, sale_price, rent_price, city_id, status, created_at, updated_at',
        )
        .in('id', missing)
      if (extrasErr) {
        throw new Error(`syndication force_include extras: ${extrasErr.message}`)
      }
      const extraRows = (extras ?? []) as FeedListing[]
      forced_in = extraRows.length
      // Cap the union to max_listings_per_run.
      const room = Math.max(0, target.max_listings_per_run - kept.length)
      kept.push(...extraRows.slice(0, room))
    }
  }

  return { listings: kept, forced_in, forced_out }
}

// Escape text for use in XML element content. CDATA wrapping handles
// the `description` field separately (descriptions often contain
// punctuation that's a pain to escape inline); other fields use this.
function escapeXmlText(s: string | null | undefined): string {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// Wrap a string in CDATA, escaping the only sequence that closes
// CDATA early (`]]>`).
function cdata(s: string | null | undefined): string {
  if (s == null) return ''
  const safe = String(s).replace(/]]>/g, ']]]]><![CDATA[>')
  return `<![CDATA[${safe}]]>`
}

/**
 * JSON serializer. Schema:
 *   {
 *     "feed": { "slug": ..., "display_name": ..., "generated_at": ... },
 *     "count": <int>,
 *     "listings": [
 *       { "id", "title", "description", "property_type",
 *         "bedrooms", "bathrooms", "floor_area_sqm",
 *         "sale_price", "rent_price", "city_id", "status",
 *         "created_at", "updated_at" }, …
 *     ]
 *   }
 */
export function serializeJson(target: SyndicationTarget, listings: FeedListing[]): string {
  const body = {
    feed: {
      slug: target.slug,
      display_name: target.display_name,
      generated_at: new Date().toISOString(),
    },
    count: listings.length,
    listings: listings.map((l) => ({
      id: l.id,
      title: l.title,
      description: l.description,
      property_type: l.property_type,
      bedrooms: l.bedrooms,
      bathrooms: l.bathrooms,
      floor_area_sqm: l.floor_area,
      sale_price: l.sale_price,
      rent_price: l.rent_price,
      city_id: l.city_id,
      status: l.status,
      created_at: l.created_at,
      updated_at: l.updated_at,
    })),
  }
  return JSON.stringify(body, null, 0)
}

/**
 * XML serializer. Shape designed for partner portals that consume
 * RETS/RES-style listing feeds. One <listing> per item, scalar fields
 * as child elements, description in CDATA so HTML / punctuation
 * survives. Top-level <metadata> mirrors the JSON `feed` block so
 * partners can detect the feed shape from the wrapper.
 *
 * Single namespace declaration on the root keeps the wire format
 * compact; partners parsing without namespace awareness still match
 * by local name.
 */
export function serializeXml(target: SyndicationTarget, listings: FeedListing[]): string {
  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push(
    '<feed xmlns="https://www.housinginteractive.com.ph/syndication/v1">',
  )
  lines.push('  <metadata>')
  lines.push(`    <slug>${escapeXmlText(target.slug)}</slug>`)
  lines.push(`    <displayName>${escapeXmlText(target.display_name)}</displayName>`)
  lines.push(`    <generatedAt>${escapeXmlText(new Date().toISOString())}</generatedAt>`)
  lines.push(`    <count>${listings.length}</count>`)
  lines.push('  </metadata>')
  lines.push('  <listings>')
  for (const l of listings) {
    lines.push(`    <listing id="${escapeXmlText(String(l.id))}">`)
    if (l.title != null) lines.push(`      <title>${escapeXmlText(l.title)}</title>`)
    if (l.description != null) lines.push(`      <description>${cdata(l.description)}</description>`)
    if (l.property_type != null)
      lines.push(`      <propertyType>${escapeXmlText(l.property_type)}</propertyType>`)
    if (l.bedrooms != null) lines.push(`      <bedrooms>${l.bedrooms}</bedrooms>`)
    if (l.bathrooms != null) lines.push(`      <bathrooms>${l.bathrooms}</bathrooms>`)
    if (l.floor_area != null)
      lines.push(`      <floorAreaSqm>${l.floor_area}</floorAreaSqm>`)
    if (l.sale_price != null) lines.push(`      <salePrice>${l.sale_price}</salePrice>`)
    if (l.rent_price != null) lines.push(`      <rentPrice>${l.rent_price}</rentPrice>`)
    if (l.city_id != null) lines.push(`      <cityId>${l.city_id}</cityId>`)
    if (l.status != null) lines.push(`      <status>${escapeXmlText(l.status)}</status>`)
    lines.push(`      <createdAt>${escapeXmlText(l.created_at)}</createdAt>`)
    lines.push(`      <updatedAt>${escapeXmlText(l.updated_at)}</updatedAt>`)
    lines.push('    </listing>')
  }
  lines.push('  </listings>')
  lines.push('</feed>')
  return lines.join('\n')
}

// CSV escaping per RFC 4180: wrap in double quotes if the value
// contains a comma, double quote, CR, or LF; double any internal quote.
function csvField(v: unknown): string {
  if (v == null) return ''
  const s = String(v)
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

/**
 * CSV serializer. RFC 4180-compliant; CRLF line endings; header row
 * matches JSON field names so partner ETL pipelines can map cleanly.
 *
 * Newlines inside `description` survive — they're inside a quoted
 * field. Most CSV parsers handle this; some legacy ones don't, so
 * for partners that need strict single-line records we'd flip a
 * future per-target `csv_strip_newlines` flag.
 */
export function serializeCsv(_target: SyndicationTarget, listings: FeedListing[]): string {
  const cols = [
    'id',
    'title',
    'description',
    'property_type',
    'bedrooms',
    'bathrooms',
    'floor_area_sqm',
    'sale_price',
    'rent_price',
    'city_id',
    'status',
    'created_at',
    'updated_at',
  ] as const
  const lines: string[] = []
  lines.push(cols.join(','))
  for (const l of listings) {
    lines.push(
      [
        csvField(l.id),
        csvField(l.title),
        csvField(l.description),
        csvField(l.property_type),
        csvField(l.bedrooms),
        csvField(l.bathrooms),
        csvField(l.floor_area), // floor_area_sqm column header
        csvField(l.sale_price),
        csvField(l.rent_price),
        csvField(l.city_id),
        csvField(l.status),
        csvField(l.created_at),
        csvField(l.updated_at),
      ].join(','),
    )
  }
  // CRLF per RFC 4180.
  return lines.join('\r\n') + '\r\n'
}

/**
 * Single dispatcher: routes a target's `feed_format` to the matching
 * serializer. RSS still throws — Phase C+ work because it requires a
 * canonical website URL per listing.
 */
export function serializeFeed(target: SyndicationTarget, listings: FeedListing[]): string {
  switch (target.feed_format) {
    case 'json':
      return serializeJson(target, listings)
    case 'xml':
      return serializeXml(target, listings)
    case 'csv':
      return serializeCsv(target, listings)
    case 'rss':
      throw new Error(
        `feed_format=rss is not yet implemented (needs per-listing canonical URLs from the website).`,
      )
  }
}

/**
 * Default content type per feed_format.
 */
export function contentTypeFor(format: SyndicationTarget['feed_format']): string {
  switch (format) {
    case 'json':
      return 'application/json; charset=utf-8'
    case 'xml':
      return 'application/xml; charset=utf-8'
    case 'csv':
      return 'text/csv; charset=utf-8'
    case 'rss':
      throw new Error(
        `feed_format=rss is not yet implemented (needs per-listing canonical URLs from the website).`,
      )
  }
}
