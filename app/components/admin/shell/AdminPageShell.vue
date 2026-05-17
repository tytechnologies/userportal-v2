<script setup lang="ts">
/**
 * AdminPageShell — uniform outer container for every admin page.
 *
 * Encodes the standard pattern (mx-auto + responsive padding + space-y)
 * AND handles the access-check fallback so each page doesn't need to
 * spell out the "Checking access…" placeholder.
 *
 * Tokens-only: bg-background + text-foreground means every page
 * follows the active theme. No hard-coded gray-50 / gray-900.
 *
 * Props:
 *   permission   — single permission key OR array (any-of). Defaults
 *                  to 'admin.access'. Pass `false` to skip the check
 *                  (rare; only for pages that gate themselves).
 *   maxWidth     — Tailwind size token. Default: 7xl.
 *
 * Slots:
 *   default      — page content. Rendered only when access check passes.
 *   denied       — optional override for the access-denied state.
 *
 * Side-effect: on access denial it shows a toast and replaces history
 * to /dashboard, matching the pattern every page used inline.
 */
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { hasPermission } from '~/composables/useAuth'
import { showToast } from '~/helpers/helpers'

const props = withDefaults(
  defineProps<{
    permission?: string | string[] | false
    maxWidth?: 'xl' | '2xl' | '3xl' | '4xl' | '5xl' | '6xl' | '7xl' | 'wide' | 'full'
  }>(),
  {
    permission: 'admin.access',
    maxWidth: '7xl',
  },
)

const router = useRouter()
const isChecking = ref(true)
const allowed = ref(false)

const widthClass = {
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
  '3xl': 'max-w-3xl',
  '4xl': 'max-w-4xl',
  '5xl': 'max-w-5xl',
  '6xl': 'max-w-6xl',
  '7xl': 'max-w-7xl',
  wide: 'max-w-[1400px]', // admin power-user surfaces (design-system.md Â§1.3)
  full: 'max-w-full',
}[props.maxWidth]

onMounted(async () => {
  if (props.permission === false) {
    isChecking.value = false
    allowed.value = true
    return
  }
  const perms = Array.isArray(props.permission) ? props.permission : [props.permission]
  const results = await Promise.all(perms.map((p) => hasPermission(p)))
  isChecking.value = false
  if (results.some(Boolean)) {
    allowed.value = true
    return
  }
  showToast({ title: 'Access denied', icon: 'warning' })
  router.replace('/dashboard')
})
</script>

<template>
  <div
    :class="[
      'mx-auto space-y-6 px-4 py-6 sm:px-6 lg:px-8 text-foreground',
      widthClass,
    ]"
  >
    <div
      v-if="isChecking"
      class="rounded-lg border border-border bg-card p-5 text-center text-sm text-muted-foreground"
    >
      Checking access…
    </div>
    <slot v-else-if="allowed" />
    <slot v-else name="denied" />
  </div>
</template>
