// Contacts data layer. Goes through useSupabaseClient() (the request-bound
// client that carries the user's JWT), so two server-side guarantees do
// the heavy lifting:
//
//   1. RLS on public.contacts (migration 20260430000002) — every SELECT,
//      INSERT, UPDATE, DELETE is scoped to owner_user_id = auth.uid()
//      (with manager/admin escalation per Phase 4 RBAC).
//   2. owner_user_id DEFAULT auth.uid() — the column auto-stamps from the
//      JWT, so the frontend NEVER passes ownership. If we tried, RLS
//      would still gate it; relying on the default keeps the surface
//      smaller.
//
// Errors from Supabase are re-thrown so the caller can surface them in a
// toast / inline banner. The composable is intentionally stateless — pages
// own their loading + list state — to keep it easy to unit-test.

export type Contact = {
  id: number
  owner_user_id: string | null
  full_name: string
  email: string | null
  mobile_phone: string | null
  notes: string | null
  // Optional columns that exist on the table; surfaced for callers that
  // want them (the detail page does), unused by the list view.
  designation?: string | null
  home_phone?: string | null
  link?: string | null
  avatar?: string | null
  created_at?: string | null
  updated_at?: string | null
}

// What the form/components send us. Same shape for create + update; the
// composable maps to the DB column names. We deliberately do NOT accept
// owner_user_id here — it's stamped server-side.
export type ContactInput = {
  full_name: string
  email?: string | null
  mobile_phone?: string | null
  notes?: string | null
}

const SELECT_COLUMNS =
  'id, owner_user_id, full_name, email, mobile_phone, home_phone, designation, link, notes, avatar, created_at, updated_at'

function asSupabaseError(err: unknown, fallback: string): Error {
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = (err as { message?: unknown }).message
    if (typeof msg === 'string' && msg.length > 0) return new Error(msg)
  }
  return new Error(fallback)
}

// Module-level inflight dedup. Two callers with identical opts mounting
// in the same tick (e.g. the /contacts page and a sibling panel) share
// a single network round-trip. 2026-05-14 smoke report counted "3
// identical fetches per page load" — this collapses them to one.
//
// Keyed by stringified opts so search/sort/order/limit variants each
// get their own promise. Entry is removed when the promise settles
// (success or failure), so the next call after settle starts fresh.
const inflightFetch = new Map<string, Promise<Contact[]>>()

export function useContacts() {
  // Pull the supabase client lazily inside each method so the composable
  // can be imported from anywhere (including SSR contexts) without
  // forcing a client resolution at call time.

  async function fetchContacts(opts: {
    /** Substring match on full_name OR email OR mobile_phone. */
    search?: string
    /** Default sort: most recently created first. */
    sort?: 'created_at' | 'full_name'
    order?: 'asc' | 'desc'
    limit?: number
  } = {}): Promise<Contact[]> {
    // Routed through /api/contacts (server-side counterpart). 2026-05-14
    // smoke report flagged the read/write inconsistency: reads used to
    // go browser→Supabase-REST while writes went browser→Nuxt API. The
    // two paths could disagree about row visibility (a wrong-owner
    // insert succeeds via API but RLS hides it from the REST read).
    // Now both share the same surface.
    const params: Record<string, string | number> = {}
    if (opts.search && opts.search.trim() !== '') params.q = opts.search.trim()
    if (opts.sort) params.sort = opts.sort
    if (opts.order) params.order = opts.order
    if (opts.limit) params.limit = opts.limit

    const key = JSON.stringify(params)
    const existing = inflightFetch.get(key)
    if (existing) return existing

    const promise = (async () => {
      try {
        const res = await $fetch<{ items: Contact[] }>('/api/contacts', {
          params,
        })
        return Array.isArray(res?.items) ? res.items : []
      } catch (err: any) {
        throw asSupabaseError(err, 'Failed to load contacts')
      } finally {
        inflightFetch.delete(key)
      }
    })()
    inflightFetch.set(key, promise)
    return promise
  }

  async function getContactById(id: number): Promise<Contact | null> {
    if (!Number.isFinite(id)) throw new Error('Invalid contact id')
    const supabase = useSupabaseClient()
    const { data, error } = await (supabase as any)
      .from('contacts')
      .select(SELECT_COLUMNS)
      .eq('id', id)
      .maybeSingle()
    if (error) throw asSupabaseError(error, 'Failed to load contact')
    return (data ?? null) as Contact | null
  }

  async function createContact(payload: ContactInput): Promise<Contact> {
    const supabase = useSupabaseClient()
    // No owner_user_id here — DB DEFAULT stamps it from auth.uid().
    const insert = {
      full_name: payload.full_name.trim(),
      email: normalizeOptional(payload.email),
      mobile_phone: normalizeOptional(payload.mobile_phone),
      notes: normalizeOptional(payload.notes),
    }
    if (!insert.full_name) throw new Error('Full name is required')

    const { data, error } = await (supabase as any)
      .from('contacts')
      .insert(insert)
      .select(SELECT_COLUMNS)
      .single()
    if (error) throw asSupabaseError(error, 'Failed to create contact')
    if (data?.id) await logContactActivity('contact.created', data.id, { full_name: data.full_name })
    return data as Contact
  }

  async function updateContact(id: number, payload: ContactInput): Promise<Contact> {
    if (!Number.isFinite(id)) throw new Error('Invalid contact id')
    const supabase = useSupabaseClient()
    const update = {
      full_name: payload.full_name.trim(),
      email: normalizeOptional(payload.email),
      mobile_phone: normalizeOptional(payload.mobile_phone),
      notes: normalizeOptional(payload.notes),
    }
    if (!update.full_name) throw new Error('Full name is required')

    const { data, error } = await (supabase as any)
      .from('contacts')
      .update(update)
      .eq('id', id)
      .select(SELECT_COLUMNS)
      .maybeSingle()
    if (error) throw asSupabaseError(error, 'Failed to update contact')
    if (!data) throw new Error('Contact not found or not editable')
    await logContactActivity('contact.updated', id)
    return data as Contact
  }

  async function deleteContact(id: number): Promise<void> {
    if (!Number.isFinite(id)) throw new Error('Invalid contact id')
    const supabase = useSupabaseClient()
    const { error } = await (supabase as any)
      .from('contacts')
      .delete()
      .eq('id', id)
    if (error) throw asSupabaseError(error, 'Failed to delete contact')
    await logContactActivity('contact.deleted', id)
  }

  // ---- Linked entities -------------------------------------------------

  async function fetchLinkedListings(contactId: number): Promise<Array<{
    listing_id: number
    title: string | null
    is_online: boolean | null
    for_sale: boolean | null
    for_rent: boolean | null
    sale_price: number | null
    rent_price: number | null
    property_category: string | null
    city_name: string | null
    updated_at: string | null
  }>> {
    if (!Number.isFinite(contactId)) return []
    const supabase = useSupabaseClient()
    // Reads from `listing_details` — the canonical wide read source.
    // The view denormalizes city_name natively via its join to cities,
    // so callers get the flat shape without a second hydration step.
    const { data, error } = await (supabase as any)
      .from('listing_details')
      .select(
        'listing_id, title, is_online, for_sale, for_rent, sale_price, rent_price, property_category, city_name, updated_at',
      )
      .eq('contact_id', contactId)
      .order('updated_at', { ascending: false })
      .limit(200)
    if (error) {
      console.error('[useContacts] fetchLinkedListings failed:', error.message ?? error)
      return []
    }
    return (data ?? []) as any[]
  }

  async function fetchContactActivities(contactId: number): Promise<Array<{
    id: string
    action: string
    created_at: string
    actor: { full_name: string | null; email: string | null } | null
    metadata: Record<string, unknown>
  }>> {
    if (!Number.isFinite(contactId)) return []
    const supabase = useSupabaseClient()
    const { data, error } = await (supabase as any)
      .from('activities')
      .select(
        'id, action, created_at, metadata, actor:profiles!user_id (full_name, email)',
      )
      .eq('entity', 'contact')
      .eq('metadata->>contact_id', String(contactId))
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) {
      console.error('[useContacts] fetchContactActivities failed:', error.message ?? error)
      return []
    }
    return (data ?? []) as any[]
  }

  return {
    fetchContacts,
    getContactById,
    createContact,
    updateContact,
    deleteContact,
    fetchLinkedListings,
    fetchContactActivities,
  }
}

// Trim and convert empty strings to null so the DB stores NULL instead
// of empty-string for optional fields. Keeps queries like
// `where email is not null` honest.
function normalizeOptional(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null
  const trimmed = String(v).trim()
  return trimmed === '' ? null : trimmed
}

// Best-effort audit log for contact mutations. Calls the SECURITY DEFINER
// public.log_activity() RPC, which stamps user_id from auth.uid() so a
// caller cannot forge actor identity. Failures are swallowed — losing
// one audit row is preferable to failing the user's actual write.
async function logContactActivity(
  action: string,
  contactId: number,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    const supabase = useSupabaseClient()
    const { error } = await (supabase as any).rpc('log_activity', {
      p_action: action,
      p_entity: 'contact',
      p_entity_id: null,
      p_metadata: { contact_id: contactId, ...extra },
    })
    if (error) {
      console.warn('[useContacts] log_activity failed:', error.message ?? error)
    }
  } catch (err) {
    console.warn('[useContacts] log_activity threw:', err)
  }
}
