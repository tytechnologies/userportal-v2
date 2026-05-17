import { ref, watch, type Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

/**
 * Two-way binding between a reactive ref and a URL query param. Initial
 * value comes from the URL if present, falling back to `defaultValue`.
 * Subsequent ref changes are pushed to the URL via `router.replace` (no
 * history pollution).
 *
 * Usage:
 *   const availability = useUrlState('availability', 'active')
 *   // mutate availability.value to update the URL; navigate to a URL
 *   // with ?availability=archived and the ref will pick it up.
 *
 * Notes:
 *   - Only string-valued query params are supported. For richer shapes
 *     pass a stringified payload and parse it yourself.
 *   - Setting the ref to the default value removes the param from the URL
 *     so shared links stay clean.
 */
export const useUrlState = <T extends string>(
  name: string,
  defaultValue: T,
): Ref<T> => {
  const route = useRoute()
  const router = useRouter()

  const fromUrl = route.query[name]
  const initial = typeof fromUrl === 'string' && fromUrl.length > 0 ? (fromUrl as T) : defaultValue
  const state = ref(initial) as Ref<T>

  watch(state, (next) => {
    const query = { ...route.query }
    if (next === defaultValue || next === '' || next == null) {
      delete query[name]
    } else {
      query[name] = String(next)
    }
    router.replace({ query })
  })

  // If the user navigates externally (back/forward, link click), pick up
  // the new value without writing back.
  watch(
    () => route.query[name],
    (q) => {
      const next = typeof q === 'string' && q.length > 0 ? (q as T) : defaultValue
      if (next !== state.value) state.value = next
    },
  )

  return state
}
