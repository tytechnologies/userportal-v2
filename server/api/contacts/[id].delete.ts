// DELETE /api/contacts/[id]
//
// Removes a contact owned by the caller. RLS scopes the DELETE to
// rows where owner_user_id = auth.uid() (or manager/admin escalation
// per Phase 4 RBAC). The endpoint also logs an audit event.
//
// Returns 200 { success: true } when the row was deleted, 404
// "Contact not found" when no row matched (either it never existed
// or RLS blocked the visibility).

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const idParam = getRouterParam(event, 'id')
    const id = Number(idParam)
    if (!Number.isFinite(id) || id <= 0 || !Number.isInteger(id)) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Invalid contact id',
        data: { error: 'invalid_id' },
      })
    }

    const client = await serverSupabaseClient(event)
    const { data, error } = await client
      .from('contacts')
      .delete({ count: 'exact' })
      .eq('id', id)
      .select()
      .maybeSingle()
    if (error) {
      logger.error(
        { err: error.message, op: 'contacts.delete', id },
        'contact_delete_failed',
      )
      throw createError({
        statusCode: 500,
        statusMessage: error.message,
      })
    }
    if (!data) {
      // Either the row doesn't exist OR RLS hid it. Both warrant a
      // 404 — the caller can't act on it either way.
      throw createError({
        statusCode: 404,
        statusMessage: 'Contact not found',
        data: { error: 'not_found' },
      })
    }
    await logActivity({
      event,
      client,
      action: 'contact.deleted',
      entity: 'contact',
      metadata: { contact_id: id, full_name: data.full_name ?? null },
    })
    return { success: true, id }
  },
})
