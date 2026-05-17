// POST /api/envelopes/:id/send
//
// Calls the envelope_send RPC which validates, generates per-recipient
// tokens, transitions the envelope to status='sent', and invites the
// first signer (sequential) or all signers (parallel).
//
// Email fan-out is NOT performed here — the email worker reads
// envelope_recipient_tokens + recipient identity and sends invitations.
// Wire it up in a follow-up turn.

import { envelopesRepo } from '~~/server/repositories/envelopes.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid envelope id' })
    }
    return await envelopesRepo.send({ event, id })
  },
})
