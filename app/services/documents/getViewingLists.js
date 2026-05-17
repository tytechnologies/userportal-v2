/** Fetch viewing lists from S3 via server API (credentials are server-only). */
export const getViewingLists = async () => {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const res = await fetch(`${origin}/api/documents/viewing-lists`)
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    const message =
      err?.statusMessage || err?.message || res.statusText || 'Failed to load viewing lists'
    throw new Error(message)
  }
  const documents = await res.json()
  return Array.isArray(documents) ? documents : []
}
