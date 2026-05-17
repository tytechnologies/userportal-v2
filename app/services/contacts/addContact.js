// The `ownerUserId` arg is accepted but IGNORED — kept for caller
// backcompat. The server stamps owner_user_id from auth.uid() via the
// DB DEFAULT; sending it from the client used to land rows under the
// wrong owner (which RLS then hid from the creator → silent data
// loss). The contact-create schema is now .strict(), so passing
// unknown keys would 422 the request; this wrapper just drops the
// arg before it reaches the body.
export const addContact = async ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  ownerUserId, // intentionally unused — see comment above
  name,
  email,
  designation,
  mobilePhone,
  homePhone,
  fbLink,
  notes,
  avatarImage,
}) => {
  const data = await $fetch('/api/contacts', {
    method: 'POST',
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
