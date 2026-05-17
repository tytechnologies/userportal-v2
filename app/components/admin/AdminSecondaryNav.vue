<script setup lang="ts">
/**
 * Secondary admin nav — replaces the 17-pill horizontal tab row.
 *
 * Four groups (Identity & Access / Data Operations / Moderation &
 * Review / Infrastructure) with 4-5 items each. Active row gets a
 * blue accent left bar — same pattern as the global sidebar so the
 * whole shell feels cohesive.
 *
 * Mobile: collapses to a styled `<select>` to avoid horizontal
 * scrolling at small viewports (the brief explicitly called this
 * out as an existing problem).
 *
 * Two-way bound via `v-model` on the active tab key. A separate
 * "external" entry routes to `/admin/operations` (the dedicated
 * page, not a tab); rendered like a nav item but uses NuxtLink.
 */
import { computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'

type Item = {
  /** Tab key (matches the `Tab` union in /admin/index.vue). */
  key: string
  label: string
  /** Set if the link should navigate elsewhere instead of switching
   *  the tab. e.g. Operations is a dedicated page. */
  externalTo?: string
  /** Optional badge — small dot when set; the parent passes the
   *  current value via the `badges` prop. */
  badge?: string
}

type Group = {
  label: string
  items: Item[]
}

const GROUPS: Group[] = [
  {
    label: 'Identity & Access',
    items: [
      { key: 'users',              label: 'Users' },
      { key: 'permissions',        label: 'Roles & permissions' },
      { key: 'organizations',      label: 'Organizations' },
      { key: 'verifications',      label: 'Verifications', badge: 'pending_verifications' },
      { key: 'broker-invitations', label: 'Invitations' },
    ],
  },
  {
    label: 'Data Operations',
    items: [
      { key: 'broker-import',    label: 'Broker imports' },
      { key: 'listing-import',   label: 'Listing imports', badge: 'failed_imports' },
      { key: 'pending-listings', label: 'Pending listings' },
      { key: 'reconcile',        label: 'Reconcile' },
      { key: 'duplicates',       label: 'Duplicates', badge: 'duplicate_candidates' },
    ],
  },
  {
    label: 'Moderation & Review',
    items: [
      { key: 'triage',     label: 'Triage' },
      { key: 'moderation', label: 'Moderation' },
      { key: 'activity',   label: 'Activity' },
    ],
  },
  {
    label: 'Property Management',
    items: [
      { key: 'leases-page',          label: 'Leases',
        externalTo: '/admin/leases' },
      { key: 'units-page',           label: 'Units',
        externalTo: '/admin/units' },
      { key: 'owners-page',          label: 'Property owners',
        externalTo: '/admin/owners' },
      { key: 'vendors-page',         label: 'Vendors',
        externalTo: '/admin/vendors' },
      { key: 'maintenance-page',     label: 'Maintenance',
        externalTo: '/admin/maintenance' },
      { key: 'work-orders-page',     label: 'Work orders',
        externalTo: '/admin/work-orders' },
    ],
  },
  {
    label: 'Billing & Revenue',
    items: [
      { key: 'property-charges-page', label: 'Property charges',
        externalTo: '/admin/property-charges' },
      { key: 'statements-page',      label: 'Statements',
        externalTo: '/admin/statements' },
      { key: 'platform-fees-page',   label: 'Platform fees',
        externalTo: '/admin/platform-fees' },
      { key: 'commission-rule-page', label: 'Commission rule',
        externalTo: '/admin/platform-commission-rule' },
      { key: 'accounting-page',      label: 'Accounting',
        externalTo: '/admin/accounting' },
      { key: 'bank-recon-page',      label: 'Bank reconciliation',
        externalTo: '/admin/bank-reconciliation' },
      { key: 'eis-submissions-page', label: 'EIS submissions',
        externalTo: '/admin/eis-submissions' },
      { key: 'bir-2307-page',        label: 'BIR Form 2307',
        externalTo: '/admin/bir-2307' },
      { key: 'bir-2306-page',        label: 'BIR Form 2306',
        externalTo: '/admin/bir-2306' },
    ],
  },
  {
    label: 'Infrastructure',
    items: [
      { key: 'webhooks',              label: 'Webhooks' },
      { key: 'sources',               label: 'Sources' },
      { key: 'broadcast',             label: 'Broadcast' },
      { key: 'saved-search-preview',  label: 'Digest preview' },
      { key: 'ai-suggestions-page',   label: 'AI suggestions',
        externalTo: '/admin/ai-suggestions' },
      { key: 'audit-export-page',     label: 'Audit log export',
        externalTo: '/admin/audit-export' },
      { key: 'platform-settings-page', label: 'Platform settings',
        externalTo: '/admin/platform-settings' },
      { key: 'operations',            label: 'Operations',
        externalTo: '/admin/operations' },
      { key: 'live-search-page',      label: 'Live search',
        externalTo: '/admin/live-search' },
      { key: 'external-candidates-page', label: 'External candidates',
        externalTo: '/admin/external-candidates' },
      { key: 'ticker-page',           label: 'Marketing ticker',
        externalTo: '/admin/ticker' },
    ],
  },
]

const props = defineProps<{
  modelValue: string
  /** Optional badge counts keyed by `badge` string from items above. */
  badges?: Partial<Record<string, number>>
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', tab: string): void
}>()

const allItems = computed(() =>
  GROUPS.flatMap((g) => g.items.filter((i) => !i.externalTo)),
)

function pick(key: string) {
  // External items prefix their option value with "ext::" so we can
  // tell them apart in the mobile select. Without this branch, an
  // operator on mobile cannot reach Property Management or Billing
  // & Revenue (those entries are all `externalTo`).
  if (key.startsWith('ext::')) {
    router.push(key.slice(5))
    return
  }
  emit('update:modelValue', key)
}

function badgeFor(item: Item): number | null {
  if (!item.badge) return null
  const v = props.badges?.[item.badge]
  return typeof v === 'number' && v > 0 ? v : null
}

function fmtBadge(n: number): string {
  return n > 99 ? '99+' : String(n)
}

// ---- Command palette wiring ---------------------------------------
// Register every secondary-nav item as a ⌘K command so operators can
// jump directly to "Webhooks", "Reconcile", "Digest preview", etc.
// without scanning the left rail. Command IDs are prefixed
// `admin-tab.*` to avoid collision with the global AppSidebar's
// `nav.*` entries. Auto-unregister on unmount so commands don't leak
// when the operator leaves /admin.
const router = useRouter()
const palette = useCommandPalette()

let unregisterCmds: (() => void) | null = null

function registerCommands() {
  const cmds = GROUPS.flatMap((group) =>
    group.items.map((item) => ({
      id: `admin-tab.${item.key}`,
      label: item.label,
      hint: group.label,
      kind: 'navigate' as const,
      group: `Admin · ${group.label}`,
      keywords: [group.label.toLowerCase(), item.key, 'admin'],
      perform: () => {
        if (item.externalTo) {
          router.push(item.externalTo)
        } else {
          router.push({ path: '/admin', query: { tab: item.key } })
        }
      },
    })),
  )
  if (cmds.length > 0) {
    palette.register(...cmds)
    const ids = cmds.map((c) => c.id)
    unregisterCmds = () => palette.unregister(...ids)
  }
}

onMounted(registerCommands)
onBeforeUnmount(() => {
  if (unregisterCmds) {
    unregisterCmds()
    unregisterCmds = null
  }
})
</script>

<template>
  <!-- Mobile: select dropdown. Hides on lg+. -->
  <div class="lg:hidden">
    <label class="block">
      <span class="sr-only">Select admin section</span>
      <select
        :value="modelValue"
        class="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        @change="pick(($event.target as HTMLSelectElement).value)"
      >
        <optgroup
          v-for="g in GROUPS"
          :key="g.label"
          :label="g.label"
        >
          <option
            v-for="i in g.items"
            :key="i.key"
            :value="i.externalTo ? `ext::${i.externalTo}` : i.key"
          >
            {{ i.label }}<span v-if="i.externalTo"> ↗</span>
          </option>
        </optgroup>
      </select>
    </label>
  </div>

  <!-- Desktop: vertical grouped nav. -->
  <nav
    class="hidden lg:block"
    aria-label="Admin sections"
  >
    <div
      v-for="(group, idx) in GROUPS"
      :key="group.label"
      :class="idx > 0 ? 'mt-5' : ''"
    >
      <p class="px-2 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {{ group.label }}
      </p>
      <ul class="space-y-0.5">
        <li v-for="item in group.items" :key="item.key">
          <!-- External link variant (Operations page) -->
          <NuxtLink
            v-if="item.externalTo"
            :to="item.externalTo"
            class="group flex items-center gap-2 rounded-lg pr-2 pl-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
          >
            <span class="flex-1 truncate">{{ item.label }}</span>
            <span
              class="text-[10px] text-muted-foreground/60 transition-transform group-hover:translate-x-0.5"
              aria-hidden="true"
            >
              ↗
            </span>
          </NuxtLink>

          <!-- Tab variant -->
          <button
            v-else
            type="button"
            :class="[
              'group relative flex w-full items-center gap-2 rounded-lg pr-2 pl-3 py-1.5 text-left text-sm font-medium transition-colors',
              modelValue === item.key
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
            ]"
            @click="pick(item.key)"
          >
            <span
              v-if="modelValue === item.key"
              class="absolute inset-y-1 left-0 w-0.5 rounded-r bg-primary"
              aria-hidden="true"
            />
            <span class="flex-1 truncate">{{ item.label }}</span>
            <span
              v-if="badgeFor(item) !== null"
              class="rounded-full bg-warning/10 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-warning ring-1 ring-warning/30"
            >
              {{ fmtBadge(badgeFor(item)!) }}
            </span>
          </button>
        </li>
      </ul>
    </div>
  </nav>
</template>
