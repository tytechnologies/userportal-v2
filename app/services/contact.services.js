import { getContacts as fetchContacts } from './contacts/getContacts'
import { getContactAvatar as fetchContactAvatar } from './contacts/getContactImage'
import { addContact as addContactService } from './contacts/addContact'

export const deleteContact = async (contact_id) => {
  const nuxtApp = useNuxtApp()
  const supabase = useSupabaseClient()

  const { data, error } = await supabase
    .from('contacts')
    .delete()
    .eq('id', contact_id)

  if (error) throw error

  return data
}

export const editContact = async (
  contact_id,
  name,
  email,
  phone,
  designation
) => {
  const nuxtApp = useNuxtApp()
  const supabase = useSupabaseClient()

  const { data, error } = await supabase.from('contacts').update({
    name,
    email,
    phone,
    designation,
  })
}

export const getContactAvatar = async (contact_id) => {
  const data = await fetchContactAvatar(contact_id)
  return data
}

export const getContacts = async (userId, email) => {
  const data = await fetchContacts(userId, email)
  return data
}

export const addContact = async (userId, name, email, phone, designation) => {
  console.log('name: ', name)
  console.log('email: ', email)
  console.log('phone: ', phone)
  console.log('designation: ', designation)

  const data = await addContactService(userId, name, email, phone, designation)
  return data
}

export const createContact = async ({
  ownerUserId,
  name,
  email,
  designation,
  mobilePhone,
  homePhone,
  fbLink,
  notes,
  avatarImage,
}) => {
  console.log('name: ', name)
  console.log('email: ', email)
  console.log('mobilePhone: ', mobilePhone)
  console.log('homePhone: ', homePhone)
  console.log('fbLink: ', fbLink)
  console.log('notes: ', notes)
  console.log('avatarImage: ', avatarImage)

  const nuxtApp = useNuxtApp()
  const supabase = useSupabaseClient()

  const { data, error } = await supabase.from('contacts').insert({
    owner_user_id: ownerUserId,
    full_name: name,
    email: email,
    mobile_phone: mobilePhone,
    home_phone: homePhone,
    link: fbLink,
    notes: notes,
  })

  console.log('create contact error: ', error)

  if (error) throw error

  const { data: contactData, error: contactError } = await supabase
    .from('contacts')
    .insert({
      owner_user_id: ownerUserId,
      full_name: name,
      email: email,
      mobile_phone: mobilePhone,
      home_phone: homePhone,
      link: fbLink,
      notes: notes,
    })

  return {
    response: 200,
    data: contactData,
  }
}
