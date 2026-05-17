// `ownerUserId` is accepted but IGNORED — see addContact.js for the
// rationale. owner_user_id is server-stamped via auth.uid() and
// can't be changed from the client (the .strict() update schema
// would 422 it).
export const updateContact = async ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  ownerUserId,
  name,
  email,
  designation,
  mobilePhone,
  homePhone,
  fbLink,
  notes,
  avatarImage,
  contactId,
}) => {
  const data = await $fetch(`/api/contacts/${contactId}`, {
    method: 'PATCH',
    body: {
      name,
      email,
      designation,
      mobilePhone,
      homePhone,
      fbLink,
      notes,
      avatarImage,
    },
  })

  return { data, success: true }
}
