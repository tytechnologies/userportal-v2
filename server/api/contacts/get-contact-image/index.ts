// Legacy variant of /api/contacts/[id]/avatar — body-shape lookup.
// Kept as-is for the existing /services/contacts/getContactImage.js
// caller; new code should use the REST route instead.
//
// The body field is named `user_id` for historical reasons but is the
// CONTACT id, not a profile/auth id. Some legacy call sites in
// Navbar.vue / my-profile.vue pass a profile UUID here by mistake;
// rather than 400ing those (which surfaces as a console error in
// production), we return an empty result for non-numeric input. The
// numeric path still goes through assertCanReadContact (RLS-checked),
// so IDOR protection is intact.

import { getContactAvatarUrls } from '~~/server/utils/s3'
import { assertCanReadContact } from '~~/server/utils/images-auth'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const body = await readBody(event).catch(() => ({} as any))
    const raw = body?.user_id

    // Non-numeric inputs (typically a profile UUID from a legacy
    // call site) — graceful empty response. No S3 lookup.
    const asNumber = Number(raw)
    if (!Number.isFinite(asNumber) || asNumber <= 0 || !Number.isInteger(asNumber)) {
      return { success: true, data: [] }
    }

    const id = await assertCanReadContact(event, raw)
    const data = await getContactAvatarUrls(id)
    return { success: true, data }
  },
})
