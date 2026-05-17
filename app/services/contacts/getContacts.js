// Cache for avatar URLs to avoid repeated server calls
const avatarCache = new Map()

export const getContactAvatar = async (contact_id) => {
  const cached = avatarCache.get(contact_id)
  if (cached) return cached.url

  try {
    const { url } = await $fetch(`/api/contacts/${contact_id}/avatar`)
    avatarCache.set(contact_id, { url: url ?? '', timestamp: Date.now() })
    return url ?? ''
  } catch (error) {
    console.error('Error getting contact avatar:', error)
    return ''
  }
}

// Returns the legacy authority strings the current user has, derived from
// the Phase-4 role via can(). Server RLS already scopes contacts to the
// owner unless the caller has contacts.read.team / contacts.read.all, so
// this is a UX hint — the array shape is preserved for the call sites
// below that .includes('view_all_contacts').
async function checkUserAuthority() {
  if (typeof window === 'undefined' || !import.meta.client) return []
  try {
    const { can } = await import('~/composables/useAuth')
    const auths = []
    if (can('view_all_contacts')) auths.push('view_all_contacts')
    return auths
  } catch (error) {
    console.error('Error checking user authority:', error)
    return []
  }
}

export const getTotalContactsFromDB = async (designation = null) => {
  const nuxtApp = useNuxtApp()
  const supabase = useSupabaseClient()
  
  try {
    const userAuthority = await checkUserAuthority()
    const user = useSupabaseUser()

    // Build base query - apply the same filters as getContacts
    let query = supabase.from('contacts').select('*', { count: 'exact', head: true })

    // Add designation filter if provided
    if (designation && designation !== 'all') {
      query = query.eq('designation', designation)
    }

    // Apply user authority filter if available, otherwise default to user-specific.
    // Skip the filter entirely when the user ref hasn't hydrated yet —
    // applying `.eq('owner_user_id', undefined)` produces a 400 from PostgREST.
    const userId = user.value?.id ?? null
    if (userAuthority.length > 0 && !userAuthority.includes('view_all_contacts')) {
      if (!userId) return 0
      query = query.eq('owner_user_id', userId)
    } else if (!userAuthority.length && userId) {
      // Fallback: if authority check fails, default to user-specific
      query = query.eq('owner_user_id', userId)
    } else if (!userAuthority.length && !userId) {
      // No authority info AND no user id — auth race. Skip rather than 400.
      return 0
    }

    const { count, error } = await query

    if (error) {
      console.error('Error fetching total contacts count:', error)
      return 0
    }

    return count || 0
  } catch (error) {
    console.error('Error in getTotalContactsFromDB:', error)
    return 0
  }
}

export const getContacts = async (
  user_id,
  email,
  page,
  contactsPerPage,
  designation
) => {
  console.log('user_id: ', user_id)
  console.log('email: ', email)
  console.log('page: ', page)
  console.log('contactsPerPage: ', contactsPerPage)

  const nuxtApp = useNuxtApp()
  const supabase = useSupabaseClient()

  try {
    const userAuthority = await checkUserAuthority()
    console.log('userAuthority: ', userAuthority)

    // Calculate the range for pagination
    const from = (page - 1) * contactsPerPage
    const to = from + contactsPerPage - 1

    console.log('Pagination range:', { from, to, page, contactsPerPage })

    // Build base query - apply filters BEFORE pagination
    // Only select necessary fields for better performance
    let query = supabase
      .from('contacts')
      .select('id, full_name, email, designation, mobile_phone, home_phone, notes, created_at, updated_at, owner_user_id')

    // Add designation filter if provided
    if (designation && designation !== 'all') {
      query = query.eq('designation', designation)
    }

    console.log('user_id: ', user_id)

    // Apply user authority filter if available, otherwise default to user-specific
    if (userAuthority.length > 0 && !userAuthority.includes('view_all_contacts')) {
      console.log('Trebuie sa iau doar cele cu user_id: ', user_id)
      query = query.eq('owner_user_id', user_id)
    } else if (!userAuthority.length && user_id) {
      // Fallback: if authority check fails, default to user-specific
      console.log('Authority check failed, defaulting to user-specific contacts: ', user_id)
      query = query.eq('owner_user_id', user_id)
    } else {
      console.log('User has view_all_contacts permission, showing all contacts')
    }

    // Apply ordering and pagination LAST - latest contacts first (using ID for newest)
    query = query
      .order('id', { ascending: false })
      .range(from, to)

    // Execute query
    const { data, error } = await query

    if (error) {
      console.error('Error fetching contacts:', error)
      throw new Error('Failed to get contacts: ' + error.message)
    }

    if (!data || data.length === 0) {
      return []
    }

    console.log(`Fetched ${data.length} contacts for page ${page}`)
    console.log('Contact IDs in order:', data.map(c => c.id))
    console.log('Contact data sample:', data.slice(0, 3).map(c => ({ id: c.id, name: c.full_name })))

    // Return contacts with backward compatibility structure
    // This ensures other components like TransferForm continue to work
    const contactsWithCompatibility = data.map((contact) => ({
      ...contact,
      // Maintain backward compatibility for existing components
      name: contact.full_name, // For SuggestionBox component
      avatar: null, // Will be loaded separately
      avatar_url: null, // Will be loaded separately
      // Keep original field names for compatibility
      contact_name: contact.full_name,
      landline: contact.home_phone,
      mobile: contact.mobile_phone,
    }))

    console.log('getContacts.js contactsWithCompatibility: ', contactsWithCompatibility)

    return contactsWithCompatibility
  } catch (error) {
    console.error('Error in getContacts:', error)
    throw error
  }
}
