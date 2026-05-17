import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'
import type { ContactCreate, ContactUpdate } from '~~/schemas/contact'

type Ctx = { event: H3Event }
type IdCtx = Ctx & { id: number }

// Client → DB column mapping. NEVER includes owner_user_id —
// the DB DEFAULT (auth.uid() per mig 20260430000002) stamps it from
// the JWT, and RLS keys SELECT/UPDATE/DELETE on that same column.
// Letting the client set owner_user_id was a silent-data-loss source
// (P0 fix): wrong-owner inserts succeed at the SQL layer but become
// invisible to the creating broker via RLS, producing the
// "200 with id but PATCH says 404" pattern.
const mapContactInput = (input: ContactCreate | ContactUpdate) => {
  const out: Record<string, unknown> = {}
  if (input.name !== undefined) out.full_name = input.name
  if (input.email !== undefined) out.email = input.email
  if (input.designation !== undefined) out.designation = input.designation
  if (input.mobilePhone !== undefined) out.mobile_phone = input.mobilePhone
  if (input.homePhone !== undefined) out.home_phone = input.homePhone
  if (input.fbLink !== undefined) out.link = input.fbLink
  if (input.notes !== undefined) out.notes = input.notes
  return out
}

export const contactsRepo = {
  async create({ event, input }: Ctx & { input: ContactCreate }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await client
      .from('contacts')
      .insert(mapContactInput(input))
      .select()
      .single()
    if (error) {
      logger.error({ err: error.message, op: 'contacts.create' }, 'contact_create_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    // contacts has a bigint PK — entityId stays null and the id rides in
    // metadata, matching the listings convention.
    await logActivity({
      event,
      client,
      action: 'contact.created',
      entity: 'contact',
      metadata: {
        contact_id: data?.id,
        full_name: data?.full_name ?? null,
      },
    })
    return data
  },

  async update({ event, id, input }: IdCtx & { input: ContactUpdate }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await client
      .from('contacts')
      .update(mapContactInput(input))
      .eq('id', id)
      .select()
      .maybeSingle()
    if (error) {
      logger.error({ err: error.message, op: 'contacts.update', id }, 'contact_update_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) throw createError({ statusCode: 404, statusMessage: 'Contact not found' })
    await logActivity({
      event,
      client,
      action: 'contact.updated',
      entity: 'contact',
      metadata: {
        contact_id: id,
        // `fields` is the Zod-mapped DB columns actually written.
        fields: Object.keys(mapContactInput(input)),
      },
    })
    return data
  },

  async updateAvatarUrl({ event, id, avatarUrl }: IdCtx & { avatarUrl: string }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await client
      .from('contacts')
      .update({ avatar: avatarUrl })
      .eq('id', id)
      .select()
      .maybeSingle()
    if (error) {
      logger.error({ err: error.message, op: 'contacts.updateAvatarUrl', id }, 'contact_avatar_url_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) throw createError({ statusCode: 404, statusMessage: 'Contact not found' })
    return data
  },
}
