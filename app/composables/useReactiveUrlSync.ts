import { watch, type Reactive } from 'vue'
import { useRoute, useRouter } from 'vue-router'

type FieldType = 'string' | 'number'

type Schema<T> = Partial<Record<keyof T, FieldType>>

/**
 * Two-way sync between a reactive object and URL query params.
 *
 * - On mount, fields with a matching URL param are populated (numeric fields
 *   are coerced via Number()). Empty / NaN values are ignored.
 * - On any field change, the URL is updated via `router.replace`. Empty,
 *   null, undefined, or NaN values are removed from the URL so a "cleared"
 *   filter doesn't clutter the link.
 * - External URL changes (back/forward, link click) write back into the
 *   reactive object.
 *
 * Usage:
 *   useReactiveUrlSync(appliedFilters, {
 *     minBedroom: 'number',
 *     maxBedroom: 'number',
 *     minPrice: 'number',
 *     availabilityFrom: 'string',
 *   })
 *
 * Pass `prefix` to namespace the URL params (e.g. `?f.minBedroom=2`) so the
 * filter cluster doesn't collide with other URL state.
 */
export const useReactiveUrlSync = <T extends Record<string, any>>(
  state: Reactive<T>,
  schema: Schema<T>,
  options: { prefix?: string } = {},
) => {
  const route = useRoute()
  const router = useRouter()
  const prefix = options.prefix ? `${options.prefix}.` : ''

  const paramName = (field: string) => `${prefix}${field}`

  const coerce = (raw: unknown, type: FieldType): unknown => {
    if (raw == null || raw === '') return undefined
    if (type === 'number') {
      const n = Number(raw)
      return Number.isFinite(n) ? n : undefined
    }
    return String(raw)
  }

  // 1) Hydrate state from URL on mount
  for (const field of Object.keys(schema) as Array<keyof T>) {
    const raw = route.query[paramName(String(field))]
    const value = Array.isArray(raw) ? raw[0] : raw
    const coerced = coerce(value, schema[field]!)
    if (coerced !== undefined) {
      ;(state as any)[field] = coerced
    }
  }

  // 2) Push state changes into URL (debounced via Vue's microtask batching)
  watch(
    () => Object.fromEntries(Object.keys(schema).map((k) => [k, (state as any)[k]])),
    (next) => {
      const query = { ...route.query }
      for (const field of Object.keys(schema)) {
        const v = next[field]
        const empty = v === undefined || v === null || v === '' || (typeof v === 'number' && !Number.isFinite(v))
        if (empty) {
          delete query[paramName(field)]
        } else {
          query[paramName(field)] = String(v)
        }
      }
      router.replace({ query })
    },
    { deep: true },
  )

  // 3) Pull URL changes back into state (for back/forward, external links)
  watch(
    () => Object.fromEntries(Object.keys(schema).map((k) => [k, route.query[paramName(k)]])),
    (next) => {
      for (const field of Object.keys(schema) as Array<keyof T>) {
        const raw = next[field as string]
        const value = Array.isArray(raw) ? raw[0] : raw
        const coerced = coerce(value, schema[field]!)
        if ((state as any)[field] !== coerced) {
          if (coerced === undefined) {
            delete (state as any)[field]
          } else {
            ;(state as any)[field] = coerced
          }
        }
      }
    },
  )
}
