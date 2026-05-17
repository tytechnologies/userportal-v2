export const searchViewingLists = async (searchString) => {
  if (!searchString || !searchString.trim()) return []
  return $fetch('/api/documents/viewing-lists/search', {
    query: { q: searchString },
  })
}
