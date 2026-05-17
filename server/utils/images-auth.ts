// Ownership / read-access guards for image endpoints.
//
// The image endpoints don't query rows through Supabase before going to
// S3 — they interpolate ids straight into a key prefix. RLS on
// public.listings + public.contacts is therefore not in the path. These
// helpers reinstate it: they do a single scoped SELECT on the parent
// row, and Postgres returns NULL for any row the caller can't see
// (RLS short-circuits). NULL → 404. The endpoint then knows the caller
// is authorised to fetch the matching S3 prefix.
//
// 404 on both "row missing" and "row hidden by RLS" is intentional —
// we don't want to leak existence to a probing client.

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

/**
 * Read gate for image / document endpoints.
 *
 * Gates on `listing_details` (the MV the userportal table reads from)
 * rather than the base `listings` table. Rationale:
 *
 *   - `listings` is RLS-scoped per Phase-4 (admin → all, manager → team,
 *     agent → own/unowned). MVs do NOT inherit base-table RLS, so
 *     `listing_details` shows authenticated users every listing.
 *   - The original repo's `/api/listings/get-thumbnail` had no gate at
 *     all — every authenticated UI surface could fetch a signed URL for
 *     any listing rendered in the table. This restores that parity.
 *   - Anon is still blocked: `20260507000010_revoke_anon_from_listing_details`
 *     REVOKEs anon SELECT on the MV, and `defineApiHandler({ auth: 'required' })`
 *     422s the unauthenticated path before we get here.
 *
 * Write gate stays strict — see `assertCanWriteListing` below.
 */
export async function assertCanReadListing(
  event: H3Event,
  rawId: unknown,
): Promise<number> {
  const id = Number(rawId)
  if (!Number.isFinite(id) || id <= 0 || !Number.isInteger(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid listing id' })
  }
  const supabase = await serverSupabaseClient(event)
  const { data, error } = await (supabase as any)
    .from('listing_details')
    .select('listing_id')
    .eq('listing_id', id)
    .maybeSingle()
  if (error) {
    throw createError({ statusCode: 500, statusMessage: error.message })
  }
  if (!data) {
    throw createError({ statusCode: 404, statusMessage: 'Listing not found' })
  }
  return id
}

/**
 * Same shape as assertCanReadListing but for contacts. Same 404 cover
 * for "missing or hidden by RLS".
 */
export async function assertCanReadContact(
  event: H3Event,
  rawId: unknown,
): Promise<number> {
  const id = Number(rawId)
  if (!Number.isFinite(id) || id <= 0 || !Number.isInteger(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid contact id' })
  }
  const supabase = await serverSupabaseClient(event)
  const { data, error } = await (supabase as any)
    .from('contacts')
    .select('id')
    .eq('id', id)
    .maybeSingle()
  if (error) {
    throw createError({ statusCode: 500, statusMessage: error.message })
  }
  if (!data) {
    throw createError({ statusCode: 404, statusMessage: 'Contact not found' })
  }
  return id
}

/**
 * Write gate for image / document endpoints — must stay strict.
 *
 * Mutations (upload, update-thumbnail, delete, clone) require the
 * caller to actually own / manage the row, so we gate on `listings`
 * with its Phase-4 RLS in the path. A user who can SEE a listing in
 * `listing_details` (via the MV's RLS bypass) but not pass the
 * `listings_select_role_scoped` policy will 404 here, which is what
 * we want for writes.
 */
export async function assertCanWriteListing(
  event: H3Event,
  rawId: unknown,
): Promise<number> {
  const id = Number(rawId)
  if (!Number.isFinite(id) || id <= 0 || !Number.isInteger(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid listing id' })
  }
  const supabase = await serverSupabaseClient(event)
  const { data, error } = await (supabase as any)
    .from('listings')
    .select('id')
    .eq('id', id)
    .maybeSingle()
  if (error) {
    throw createError({ statusCode: 500, statusMessage: error.message })
  }
  if (!data) {
    throw createError({ statusCode: 404, statusMessage: 'Listing not found' })
  }
  return id
}

/**
 * Building writes — image uploads / thumbnail replacements don't touch
 * the buildings table directly (they write to S3), so RLS isn't in the
 * path. Gate with the buildings.manage permission check that the table
 * itself uses for INSERT/UPDATE/DELETE policies.
 *
 * Returns the validated numeric id; throws 400 / 403.
 */
export async function assertCanWriteBuilding(
  event: H3Event,
  rawId: unknown,
): Promise<number> {
  const id = Number(rawId)
  if (!Number.isFinite(id) || id <= 0 || !Number.isInteger(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid building id' })
  }
  const supabase = await serverSupabaseClient(event)
  const { data: allowed, error } = await (supabase as any).rpc('has_permission', {
    permission_to_check: 'buildings.manage',
  })
  if (error) {
    throw createError({ statusCode: 500, statusMessage: error.message })
  }
  if (allowed !== true) {
    throw createError({
      statusCode: 403,
      statusMessage: 'You do not have permission to modify buildings.',
    })
  }
  return id
}
