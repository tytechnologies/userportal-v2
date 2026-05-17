// Shared digest-build helpers for saved-search subscriptions.
//
// Used by:
//   - /api/admin/saved-searches/run-digest      (real send path)
//   - /api/admin/saved-searches/preview         (admin dry-run)
//
// Centralizing both the listing query AND the HTML render means the
// preview and the actual delivery cannot drift. A behavior change in
// the digest happens here; both surfaces pick it up.

import type { getServerSupabaseAdmin } from './supabase'

export const PER_DIGEST_LISTING_CAP = 12

export const ALLOWED_FILTER_KEYS = new Set([
  'category',
  'for',
  'minPrice',
  'maxPrice',
  'bedroomsMin',
  'bedroomsMax',
  'cityId',
  'barangayId',
  'propertyId',
])

export type ListingMatch = {
  listing_id: number
  title: string | null
  property_slug: string | null
  city_slug: string | null
  barangay_slug: string | null
  property_category: string | null
  for_sale: boolean | null
  for_rent: boolean | null
  sale_price: number | null
  rent_price: number | null
  bedrooms: number | null
  bathrooms: number | null
  city_name: string | null
  barangay_name: string | null
  updated_at: string | null
}

export async function loadMatchingListings(
  admin: ReturnType<typeof getServerSupabaseAdmin>,
  rawFilters: Record<string, unknown>,
  sinceIso: string,
): Promise<ListingMatch[]> {
  // Strip filters down to what we know how to apply. Anything else is
  // ignored — defends against schema drift in older subscriptions.
  const filters: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(rawFilters ?? {})) {
    if (ALLOWED_FILTER_KEYS.has(k)) filters[k] = v
  }

  let q: any = (admin as any)
    .from('public_listing_details')
    .select(
      'listing_id, title, property_slug, city_slug, barangay_slug, ' +
      'property_category, for_sale, for_rent, sale_price, rent_price, ' +
      'bedrooms, bathrooms, city_name, barangay_name, updated_at',
    )
    .eq('is_online', true)
    .gt('updated_at', sinceIso)
    .order('updated_at', { ascending: false })
    .limit(PER_DIGEST_LISTING_CAP)

  if (typeof filters.category === 'string') q = q.eq('property_category', filters.category)
  if (filters.for === 'buy') q = q.eq('for_sale', true)
  else if (filters.for === 'rent') q = q.eq('for_rent', true)
  if (filters.minPrice != null) q = q.gte('sale_price', String(filters.minPrice))
  if (filters.maxPrice != null) q = q.lte('sale_price', String(filters.maxPrice))
  if (filters.bedroomsMin != null) q = q.gte('bedrooms', Number(filters.bedroomsMin))
  if (filters.bedroomsMax != null) q = q.lte('bedrooms', Number(filters.bedroomsMax))
  if (filters.cityId != null) q = q.eq('city_id', Number(filters.cityId))
  if (filters.barangayId != null) q = q.eq('barangay_id', Number(filters.barangayId))
  if (filters.propertyId != null) q = q.eq('property_id', Number(filters.propertyId))

  const { data, error } = await q
  if (error) {
    throw new Error(`listing match query failed: ${error.message}`)
  }
  return (data ?? []) as ListingMatch[]
}

export function buildDigestEmail(opts: {
  recipientName: string | null
  matches: ListingMatch[]
  baseUrl: string
  unsubscribeToken: string
}): { subject: string; html: string } {
  const greet = opts.recipientName?.trim() ? `Hi ${escapeHtml(opts.recipientName)},` : 'Hi,'
  const count = opts.matches.length
  const subject = `${count} new ${count === 1 ? 'listing' : 'listings'} for your saved search`
  const unsubHref = `${opts.baseUrl}/api/public/saved-searches/unsubscribe/${encodeURIComponent(opts.unsubscribeToken)}`

  const cards = opts.matches.map((m) => listingCardHtml(m, opts.baseUrl)).join('\n')

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f6f7fa;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1f2937">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="padding:24px 12px">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px">
        <tr><td>
          <h1 style="margin:0 0 8px;font-size:18px;color:#111827">${count} new ${count === 1 ? 'match' : 'matches'} for your saved search</h1>
          <p style="margin:0 0 16px;color:#4b5563">${greet} here's what's come online since the last digest.</p>
          ${cards}
          <p style="margin:24px 0 0;font-size:11px;color:#9ca3af">You're receiving this because you subscribed to digest emails at <strong>Housing Interactive</strong>. <a href="${unsubHref}" style="color:#9ca3af">Unsubscribe</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`
  return { subject, html }
}

function listingCardHtml(m: ListingMatch, baseUrl: string): string {
  const url = listingUrl(m, baseUrl)
  const price = formatPrice(m)
  const specs = formatSpecs(m)
  const location = [m.barangay_name, m.city_name].filter(Boolean).join(', ')

  return `
    <a href="${url}" style="display:block;padding:12px;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:8px;text-decoration:none;color:#111827">
      <div style="font-size:14px;font-weight:600;color:#111827">${escapeHtml(m.title || 'Listing')}</div>
      ${location ? `<div style="font-size:12px;color:#6b7280;margin-top:2px">${escapeHtml(location)}</div>` : ''}
      <div style="display:flex;gap:12px;margin-top:8px;font-size:12px;color:#374151">
        <span style="font-weight:600">${escapeHtml(price)}</span>
        ${specs ? `<span style="color:#6b7280">${escapeHtml(specs)}</span>` : ''}
      </div>
    </a>`
}

function listingUrl(m: ListingMatch, baseUrl: string): string {
  // Inline replica of the website's buildPropertyPath so the digest
  // stays self-contained. Format: /property/<city>-<brgy>-<prefix>-<id>
  const transactionPrefix = m.for_sale ? 's' : 'r'
  const categoryPrefix = (m.property_category?.charAt(0) ?? '').toLowerCase()
  const codePrefix = `${transactionPrefix}${categoryPrefix}`
  const slugParts = [m.city_slug, m.barangay_slug].filter(
    (p) => typeof p === 'string' && p.length > 0,
  )
  return `${baseUrl}/property/${slugParts.join('-')}-${codePrefix}-${m.listing_id}`
}

function formatPrice(m: ListingMatch): string {
  if (m.for_sale && m.sale_price != null) {
    return `₱${Number(m.sale_price).toLocaleString()}`
  }
  if (m.for_rent && m.rent_price != null) {
    return `₱${Number(m.rent_price).toLocaleString()} / mo`
  }
  return 'Price on request'
}

function formatSpecs(m: ListingMatch): string {
  const parts: string[] = []
  if (m.bedrooms != null) parts.push(`${m.bedrooms} BR`)
  if (m.bathrooms != null) parts.push(`${m.bathrooms} BA`)
  return parts.join(' · ')
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function digestBaseUrl(): string {
  return (
    process.env.PUBLIC_SITE_URL ||
    process.env.PUBLIC_APP_URL ||
    'https://housinginteractive.com.ph'
  )
}
