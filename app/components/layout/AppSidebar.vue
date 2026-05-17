<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import {
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from 'radix-vue'
import ViewDashboard from 'vue-material-design-icons/ViewDashboard.vue'
import HomeCity from 'vue-material-design-icons/HomeCity.vue'
import OfficeBuilding from 'vue-material-design-icons/OfficeBuilding.vue'
import EmailMultiple from 'vue-material-design-icons/EmailMultiple.vue'
import Handshake from 'vue-material-design-icons/Handshake.vue'
import CalendarClock from 'vue-material-design-icons/CalendarClock.vue'
import AccountMultiple from 'vue-material-design-icons/AccountMultiple.vue'
import FileDocument from 'vue-material-design-icons/FileDocument.vue'
import CheckboxMarkedOutline from 'vue-material-design-icons/CheckboxMarkedOutline.vue'
import ShareVariant from 'vue-material-design-icons/ShareVariant.vue'
import Magnify from 'vue-material-design-icons/Magnify.vue'
import ChevronDoubleLeft from 'vue-material-design-icons/ChevronDoubleLeft.vue'
import ChevronDoubleRight from 'vue-material-design-icons/ChevronDoubleRight.vue'
import Cog from 'vue-material-design-icons/Cog.vue'
import Logout from 'vue-material-design-icons/Logout.vue'
import ShieldAccount from 'vue-material-design-icons/ShieldAccount.vue'
import AccountCog from 'vue-material-design-icons/AccountCog.vue'
import AccountKey from 'vue-material-design-icons/AccountKey.vue'
import FileDocumentMultiple from 'vue-material-design-icons/FileDocumentMultiple.vue'
import Bank from 'vue-material-design-icons/Bank.vue'
import WeatherSunny from 'vue-material-design-icons/WeatherSunny.vue'
import WeatherNight from 'vue-material-design-icons/WeatherNight.vue'
import ChartLine from 'vue-material-design-icons/ChartLine.vue'
import Pulse from 'vue-material-design-icons/Pulse.vue'
import HelpCircleOutline from 'vue-material-design-icons/HelpCircleOutline.vue'
// Phase 5 enterprise-domain icons. Each top-level domain gets a
// distinct glyph so the icon-only collapsed sidebar reads cleanly.
import AccountGroup from 'vue-material-design-icons/AccountGroup.vue'
import HomeAccount from 'vue-material-design-icons/HomeAccount.vue'
import Calculator from 'vue-material-design-icons/Calculator.vue'
import RobotOutline from 'vue-material-design-icons/RobotOutline.vue'
import Domain from 'vue-material-design-icons/Domain.vue'
import ChevronDown from 'vue-material-design-icons/ChevronDown.vue'
import { useRouter } from 'vue-router'
import { useUserRole } from '~/composables/useAuth'
import { useTheme } from '~/composables/useTheme'
import BrandLogo from '~/components/BrandLogo.vue'

// Pulse import aliased for clarity in the sections list — the heart-rate
// pulse icon is what we use as the operations-health glyph. Declared
// AFTER all imports so the production-bundled `<script setup>` doesn't
// hit a "Cannot access 'Pulse' before initialization" TDZ — Vue's SFC
// compiler only safely hoists imports that sit at the very top.
const PulseIcon = Pulse

// Sidebar polish — refactor of the flat 8-item nav into grouped
// sections with section headers, live badge counts on actionable items
// (Tasks open, Inquiries new, Shares pending), and a user profile pill
// at the bottom replacing the bare copyright footer.
//
// Badge data piggybacks on /api/dashboard/stats which the dashboard
// already fetches — Nuxt $fetch dedupes per-request so visiting
// /dashboard hits the endpoint once between the strip + sidebar; on
// other pages the sidebar is the only consumer.

// Phase 2 redesign: collapsed the 9-color icon-chip rainbow to a single
// neutral palette. Active state is one accent (primary blue) + a left
// accent bar — matches Linear / Vercel. Live badges keep a small,
// meaningful palette: critical = red, action-needed = amber/blue,
// neutral = slate. Color is reserved for the few places it carries
// information (active link, badge severity), not decoration.

// Severity for badges. Read by `severityFor()` per link to pick the
// pill color so a high "tasks open" count reads "you have work to do"
// at a glance without drowning the rest of the sidebar in tint.
type BadgeSeverity = 'neutral' | 'info' | 'warning' | 'critical'

const badgeClasses: Record<BadgeSeverity, string> = {
  neutral:  'bg-muted-foreground/10 text-foreground/80',
  info:     'bg-primary/10 text-primary',
  warning:  'bg-warning/10 text-warning',
  critical: 'bg-destructive/10 text-destructive',
}

type NavLink = {
  name: string
  text: string
  icon: any
  /** alternate route names that should also light up this link */
  matches?: string[]
  /** Optional query params for deep-linking into a tabbed page
   *  (e.g. /admin?tab=users). Used both as the to= target and to
   *  differentiate active state when two links share the same route. */
  query?: Record<string, string>
  /** Which stats key drives the badge, if any. */
  badge?: 'open_tasks_mine' | 'new_inquiries_7d' | 'pending_shares_incoming'
  /** Render the link with reduced visual weight — used for sub-items
   *  nested under a section parent. */
  subdued?: boolean
  /** Per-link role gate. Hides the link when the caller's role rank
   *  is below this threshold, even if the parent section is visible.
   *  Use sparingly — prefer section-level gates when possible. */
  requiresRole?: 'admin' | 'manager'
}

type NavSection = {
  label: string
  /** Top-level icon used in the collapsed-sidebar state (icon-only).
   *  Falls back to the first link's icon when omitted. */
  icon?: any
  /** Primary route for the domain. When set, the section's label is
   *  itself a clickable link landing on this route — useful for the
   *  enterprise-domain pattern where each domain has a hub. */
  primaryRoute?: string
  links: NavLink[]
  /** When set, the section only renders for callers with that role
   *  rank or higher. Section + its children all hide together. */
  requiresRole?: 'admin' | 'manager'
  /** Route names that put the user "in" this domain. Drives the
   *  contextual sub-sidebar — when the active route matches, this
   *  section's links expand; other sections collapse to label-only.
   *  When omitted, falls back to matching any link's name/matches. */
  domainRoutes?: string[]
}

// Enterprise-domain navigation. Each top-level entry is a self-
// contained workspace: a primary landing route + sub-routes that
// expand contextually when the user is "in" that domain (per
// `domainRoutes`). The pattern lets a 13-domain nav stay visually
// quiet — only the active domain's children are visible by default;
// hovering or clicking a label expands its children inline.
//
// Why not collapse everything always: a flat top-level list of 13
// is too tall to scan. Contextual reveal cuts visual noise to just
// the domain you're working in, while leaving fast access to the
// other 12 labels.
const sections: NavSection[] = [
  {
    label: 'Dashboard',
    icon: ViewDashboard,
    primaryRoute: 'dashboard',
    domainRoutes: ['dashboard', 'index'],
    links: [
      { name: 'dashboard', text: 'Overview', icon: ViewDashboard },
    ],
  },
  {
    label: 'Listings',
    icon: HomeCity,
    primaryRoute: 'listings',
    domainRoutes: [
      'listings', 'listing', 'listing-history',
      'featured-listings', 'deck',
      'buildings', 'buildings-id',
    ],
    links: [
      {
        name: 'listings',
        text: 'All listings',
        icon: HomeCity,
        matches: ['listings', 'listing', 'listing-history'],
      },
      {
        name: 'buildings',
        text: 'Buildings',
        icon: OfficeBuilding,
        matches: ['buildings', 'buildings-id'],
      },
      { name: 'featured-listings',text: 'Featured',          icon: HomeCity, subdued: true },
      { name: 'deck',             text: 'Deck',              icon: HomeCity, subdued: true },
    ],
  },
  {
    label: 'CRM',
    icon: AccountGroup,
    primaryRoute: 'crm',
    domainRoutes: ['crm', 'contacts', 'contacts-id', 'tasks', 'shares', 'viewings'],
    links: [
      { name: 'crm',      text: 'CRM hub',        icon: AccountGroup },
      { name: 'contacts', text: 'Contacts',       icon: AccountMultiple },
      { name: 'tasks',    text: 'Tasks',          icon: CheckboxMarkedOutline, badge: 'open_tasks_mine' },
      { name: 'viewings', text: 'Viewings',       icon: CalendarClock },
      { name: 'shares',   text: 'Shares',         icon: ShareVariant,          badge: 'pending_shares_incoming' },
    ],
  },
  {
    label: 'Inquiries',
    icon: EmailMultiple,
    primaryRoute: 'inquiries',
    domainRoutes: ['inquiries'],
    links: [
      { name: 'inquiries', text: 'Inbox', icon: EmailMultiple, badge: 'new_inquiries_7d' },
    ],
  },
  {
    label: 'Deals',
    icon: Handshake,
    primaryRoute: 'deals',
    domainRoutes: ['deals', 'deals-id'],
    links: [
      { name: 'deals', text: 'Pipeline', icon: Handshake },
    ],
  },
  {
    label: 'Transactions',
    icon: Bank,
    primaryRoute: 'transactions',
    domainRoutes: ['transactions', 'transactions-id'],
    links: [
      { name: 'transactions', text: 'Closing rooms', icon: Bank },
    ],
  },
  {
    label: 'Documents',
    icon: FileDocument,
    primaryRoute: 'document-drafts',
    domainRoutes: [
      'document-drafts', 'document-drafts-id', 'document-drafts-new',
      'documents', 'document-tabs', 'documents-old',
      'envelopes', 'envelopes-id', 'envelopes-new',
      'viewing-list-tabs', 'contracts-list-tabs',
      'commercial-viewing-list', 'residential-viewing-list',
      'document-viewing-list',
      'contracts-commercial-viewing-list',
      'contracts-residential-viewing-list',
    ],
    links: [
      {
        name: 'document-drafts',
        text: 'Drafts',
        icon: FileDocument,
        matches: ['document-drafts', 'document-drafts-id', 'document-drafts-new'],
      },
      {
        name: 'envelopes',
        text: 'Envelopes',
        icon: FileDocument,
        matches: ['envelopes', 'envelopes-id', 'envelopes-new'],
      },
      {
        // Reference checklist of standard PH gov/agency docs.
        name: 'document-tabs',
        text: 'Doc checklist',
        icon: Bank,
        query: { tab: 'document-checklist' },
        matches: ['document-tabs', 'documents-government-references'],
        subdued: true,
      },
    ],
  },
  {
    label: 'Organizations',
    icon: Domain,
    requiresRole: 'manager',
    primaryRoute: 'admin',
    domainRoutes: ['admin', 'invite'],
    links: [
      // Org-membership management lives on the admin tabbed page;
      // surfacing it here so non-admin managers see it too.
      { name: 'admin', text: 'Members', icon: Domain, query: { tab: 'organizations' } },
      { name: 'admin', text: 'Invites', icon: Domain, query: { tab: 'invitations' }, subdued: true },
    ],
  },
  {
    label: 'Property Mgmt',
    icon: HomeAccount,
    requiresRole: 'manager',
    primaryRoute: 'property-management',
    domainRoutes: [
      'property-management',
      'admin-leases', 'admin-leases-id', 'admin-units',
      'admin-work-orders', 'admin-maintenance', 'admin-inspections',
      'admin-vendors', 'admin-owners', 'admin-property-charges',
      'admin-late-fees',
    ],
    links: [
      { name: 'property-management', text: 'PM hub',        icon: HomeAccount },
      { name: 'admin-leases',        text: 'Leases',        icon: FileDocument },
      { name: 'admin-units',         text: 'Units',         icon: HomeCity },
      { name: 'admin-work-orders',   text: 'Work orders',   icon: CheckboxMarkedOutline },
      { name: 'admin-maintenance',   text: 'Maintenance',   icon: CheckboxMarkedOutline, subdued: true },
      { name: 'admin-inspections',   text: 'Inspections',   icon: CheckboxMarkedOutline, subdued: true },
      { name: 'admin-vendors',       text: 'Vendors',       icon: AccountMultiple,       subdued: true },
      { name: 'admin-owners',        text: 'Owners',        icon: AccountMultiple,       subdued: true },
      { name: 'admin-property-charges', text: 'Charges',    icon: Calculator,            subdued: true },
      { name: 'admin-late-fees',     text: 'Late fees',     icon: Calculator,            subdued: true },
    ],
  },
  {
    label: 'Accounting',
    icon: Calculator,
    requiresRole: 'manager',
    primaryRoute: 'accounting',
    domainRoutes: [
      'accounting',
      'admin-accounting',
      'admin-journal-entry-new', 'admin-bank-reconciliation',
      'admin-statements', 'admin-platform-commission-rule',
      'admin-platform-fees', 'admin-bir-2306', 'admin-bir-2307',
      'admin-eis-submissions', 'admin-audit-export',
    ],
    links: [
      { name: 'accounting',                   text: 'Accounting hub', icon: Calculator },
      { name: 'admin-accounting',             text: 'Ledger',         icon: Calculator },
      { name: 'admin-journal-entry-new',      text: 'Journal entry',  icon: Calculator,           subdued: true },
      { name: 'admin-bank-reconciliation',    text: 'Bank reconcile', icon: Calculator,           subdued: true },
      { name: 'admin-statements',             text: 'Statements',     icon: FileDocument,         subdued: true },
      { name: 'admin-platform-commission-rule', text: 'Commissions',  icon: Calculator,           subdued: true },
      { name: 'admin-platform-fees',          text: 'Platform fees',  icon: Calculator,           subdued: true },
      { name: 'admin-bir-2306',               text: 'BIR 2306',       icon: FileDocumentMultiple, subdued: true },
      { name: 'admin-bir-2307',               text: 'BIR 2307',       icon: FileDocumentMultiple, subdued: true },
      { name: 'admin-eis-submissions',        text: 'EIS',            icon: FileDocumentMultiple, subdued: true },
      { name: 'admin-audit-export',           text: 'Audit export',   icon: FileDocumentMultiple, subdued: true },
    ],
  },
  {
    label: 'Analytics',
    icon: ChartLine,
    primaryRoute: 'market',
    domainRoutes: ['market', 'analytics', 'admin-operations'],
    links: [
      { name: 'market',           text: 'Market intelligence', icon: ChartLine },
      { name: 'analytics',        text: 'Reports',             icon: ChartLine,    subdued: true },
      { name: 'admin-operations', text: 'Operations',          icon: PulseIcon,    subdued: true },
    ],
  },
  {
    label: 'AI Tools',
    icon: RobotOutline,
    primaryRoute: 'ai-tools',
    domainRoutes: [
      'ai-tools', 'admin-ai-settings', 'admin-clause-library',
      'admin-ai-suggestions',
    ],
    links: [
      { name: 'ai-tools',             text: 'AI Tools hub',    icon: RobotOutline },
      { name: 'admin-clause-library', text: 'Clause library',  icon: FileDocumentMultiple },
      { name: 'admin-ai-suggestions', text: 'AI suggestions',  icon: RobotOutline, subdued: true },
      { name: 'admin-ai-settings',    text: 'AI settings',     icon: Cog, requiresRole: 'admin', subdued: true } as NavLink,
    ],
  },
  {
    label: 'Administration',
    icon: AccountCog,
    requiresRole: 'admin',
    primaryRoute: 'admin',
    domainRoutes: [
      'admin', 'admin-document-templates', 'admin-document-templates-id',
      'admin-government-documents', 'admin-clause-library',
      'admin-ai-settings', 'admin-esign-settings',
      'admin-listing-syndication', 'admin-lead-routing',
      'admin-platform-settings', 'admin-tools',
    ],
    links: [
      { name: 'admin',                       text: 'Users',                  icon: AccountCog,           query: { tab: 'users' } },
      { name: 'admin',                       text: 'Roles & permissions',    icon: AccountKey,           query: { tab: 'permissions' }, subdued: true },
      { name: 'admin-document-templates',    text: 'Document templates',     icon: FileDocumentMultiple, subdued: true,
        matches: ['admin-document-templates', 'admin-document-templates-id'] },
      { name: 'admin-government-documents',  text: 'Doc checklist (admin)',  icon: Bank,                 subdued: true },
      { name: 'admin-esign-settings',        text: 'eSign (DocuSign)',       icon: AccountKey,           subdued: true },
      { name: 'admin-listing-syndication',   text: 'Listing syndication',    icon: HomeCity,             subdued: true },
      { name: 'admin-lead-routing',          text: 'Lead routing',           icon: EmailMultiple,        subdued: true },
      { name: 'admin-platform-settings',     text: 'Platform settings',      icon: Cog,                  subdued: true },
      { name: 'help',                        text: 'Help & support',         icon: HelpCircleOutline,    subdued: true },
    ],
  },
]

const route = useRoute()
const router = useRouter()
const { mobileOpen, close } = useAppSidebar()
const display = useDisplayUser()
const palette = useCommandPalette()
const { theme, toggleTheme } = useTheme()
// Role gate uses useUserRole() — it auto-fetches /api/me and caches
// the result, so the admin section appears as soon as the profile
// loads.
const role = useUserRole()
const ROLE_RANK = { admin: 3, manager: 2, agent: 1 } as const

/** Section-level role gate. Sections with a higher requirement than
 *  the caller's role are hidden entirely. */
const visibleSections = computed(() =>
  sections
    .filter((s) => {
      if (!s.requiresRole) return true
      return ROLE_RANK[role.value] >= ROLE_RANK[s.requiresRole]
    })
    // Per-link role filter — strips child links whose requiredRole
    // is above the caller's. Section stays visible as long as at
    // least one link survives.
    .map((s) => ({
      ...s,
      links: s.links.filter((l) => {
        if (!l.requiresRole) return true
        return ROLE_RANK[role.value] >= ROLE_RANK[l.requiresRole]
      }),
    }))
    .filter((s) => s.links.length > 0),
)

/** "Active domain" — the section whose `domainRoutes` matches the
 *  current route name. Drives the contextual reveal: the active
 *  domain renders its links inline; other domains render label-only
 *  (or with their primaryRoute as the only clickable target).
 *
 *  Falls back to the section that owns any link matching the route
 *  when domainRoutes isn't set. */
const activeDomainKey = computed<string | null>(() => {
  const rname = String(route.name || '')
  for (const s of visibleSections.value) {
    if (s.domainRoutes?.includes(rname)) return s.label
    if (s.links.some((l) => l.name === rname || l.matches?.includes(rname))) return s.label
  }
  return null
})

/** Manual expand state — clicking a section header toggles it open
 *  even when not the active domain. Resets when the route changes
 *  to a different domain. */
const expandedDomain = ref<string | null>(null)
function toggleDomain(label: string) {
  expandedDomain.value = expandedDomain.value === label ? null : label
}
watch(() => route.name, () => {
  // When the user navigates, snap the manual-expand back to the
  // active domain so the sidebar stays predictable.
  expandedDomain.value = null
})

/** True when the section's children should render. Active domain
 *  always expands; other domains expand only when manually toggled
 *  or when the sidebar is in collapsed/icon-only mode (where every
 *  domain's tooltip-style flyout shows children). */
function isExpanded(label: string): boolean {
  if (activeDomainKey.value === label) return true
  if (expandedDomain.value === label) return true
  return false
}

async function logout() {
  await useSupabaseClient().auth.signOut()
  await router.push('/login')
}

// ---- Collapsed state ------------------------------------------------
// Sidebar can collapse to icon-only on lg+ to free horizontal real
// estate on smaller laptops. State persists in localStorage so it
// stays put across page reloads. Mobile drawer ignores this — it's
// always full-width when open.
const COLLAPSE_KEY = 'hi:sidebar:collapsed'
const isCollapsed = ref(false)

onMounted(() => {
  try {
    isCollapsed.value = localStorage.getItem(COLLAPSE_KEY) === '1'
  } catch { /* SSR or denied storage — default expanded */ }
})

watch(isCollapsed, (next) => {
  try {
    localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0')
  } catch { /* ignore quota / privacy errors */ }
})

function toggleCollapsed() {
  isCollapsed.value = !isCollapsed.value
}

// Mac users see âŒ˜K, others see Ctrl+K. Display-only — the global
// hotkey installed by useCommandPalette accepts both.
const hotkeyLabel = computed(() => {
  if (typeof navigator === 'undefined') return 'Ctrl K'
  return /Mac|iPhone|iPad/.test(navigator.platform) ? 'âŒ˜ K' : 'Ctrl K'
})

// Register every visible nav item as a command-palette entry. âŒ˜K +
// typing the label jumps to the route — useful on long pages where
// the sidebar is offscreen. Admin commands hide for non-admins via
// visibleSections.
//
// Scoped registration cleans up on unmount, but the sidebar is always
// mounted on default-layout pages so cleanup is a no-op in practice.
// Re-registering when role flips so admin commands appear post-login
// without a refresh.
let unregisterCmds: (() => void) | null = null
function rebuildCommands() {
  if (unregisterCmds) {
    unregisterCmds()
    unregisterCmds = null
  }
  const cmds = visibleSections.value.flatMap((section) =>
    section.links.map((link) => ({
      id: `nav.${link.name}.${JSON.stringify(link.query ?? {})}`,
      label: link.text,
      hint: section.label,
      kind: 'navigate' as const,
      group: 'Navigate',
      keywords: [section.label.toLowerCase(), link.name],
      perform: () => { router.push({ name: link.name, query: link.query }).catch(() => {}) },
    })),
  )
  if (cmds.length > 0) {
    palette.register(...cmds)
    const ids = cmds.map((c) => c.id)
    unregisterCmds = () => palette.unregister(...ids)
  }
}

onMounted(rebuildCommands)
onBeforeUnmount(() => { if (unregisterCmds) unregisterCmds() })
watch(visibleSections, () => rebuildCommands())

const isLinkActive = (link: NavLink) => {
  const current = String(route.name ?? '')
  const nameMatches = current === link.name || !!link.matches?.includes(current)
  if (!nameMatches) return false

  // When the link specifies query params (deep-linking into a tabbed
  // page), require the route's current query to match. Default-tab
  // links (no `tab` in current URL) match the link with `tab=users`
  // — same view in either form.
  if (link.query) {
    for (const [k, v] of Object.entries(link.query)) {
      const cur = route.query[k]
      // Exact match, OR — for the default tab — accept absence as a
      // match against the canonical default value.
      if (cur === v) continue
      if (cur === undefined && k === 'tab' && v === 'users') continue
      return false
    }
  } else if (Object.keys(route.query).length > 0 && current === 'admin') {
    // Plain Admin parent link without query — don't claim active
    // state when the URL has any tab=... since a tab-specific link
    // owns it.
    return false
  }
  return true
}

// Kept around for diagnostics, but link-level templates now call
// isLinkActive(link) directly so two links sharing a route name (e.g.
// the admin tab variants) can both be matched correctly.
const activeName = computed(() =>
  sections.flatMap((s) => s.links).find((l) => isLinkActive(l))?.name,
)

// Close the mobile drawer on every navigation.
watch(() => route.fullPath, () => close())

// ---- Live badges ---------------------------------------------------
// Single batch fetch from /api/dashboard/stats. Refresh on a slow
// interval (60s) — same cadence as the notification bell, no need to
// chase real-time for a sidebar counter. Errors silently zero out
// the badges so the nav still renders.

type BadgeKey = NonNullable<NavLink['badge']>
const badges = ref<Record<BadgeKey, number>>({
  open_tasks_mine: 0,
  new_inquiries_7d: 0,
  pending_shares_incoming: 0,
})
let pollHandle: ReturnType<typeof setInterval> | null = null

async function refreshBadges() {
  try {
    const res = await $fetch<{ kpi: Record<BadgeKey, number> }>('/api/dashboard/stats')
    if (res?.kpi) {
      badges.value = {
        open_tasks_mine: Number(res.kpi.open_tasks_mine) || 0,
        new_inquiries_7d: Number(res.kpi.new_inquiries_7d) || 0,
        pending_shares_incoming: Number(res.kpi.pending_shares_incoming) || 0,
      }
    }
  } catch {
    // Leave whatever was last loaded; no need to flicker on transient
    // failures.
  }
}

onMounted(() => {
  refreshBadges()
  pollHandle = setInterval(refreshBadges, 60_000)
})
onBeforeUnmount(() => {
  if (pollHandle) clearInterval(pollHandle)
})

function badgeFor(link: NavLink): number | null {
  if (!link.badge) return null
  const v = badges.value[link.badge]
  return v > 0 ? v : null
}

// Format large badge counts: 99+ for anything â‰¥ 100 so the pill never
// blows out the row width.
function badgeText(n: number): string {
  return n > 99 ? '99+' : String(n)
}

// Severity for a link's badge. Default is neutral — the count itself
// already conveys "you have N items". Only escalate when a count
// actually becomes operationally urgent (currently we treat
// pending shares as info because they ask for a response, not because
// they're "wrong"). If we wire ops-alert counts in here later, those
// can return 'critical'.
function severityFor(link: NavLink, n: number): BadgeSeverity {
  if (link.badge === 'pending_shares_incoming') return 'info'
  return 'neutral'
}
</script>

<template>
  <!-- Desktop sidebar (lg+). Sticky, full height. Collapses to icon-
       only when isCollapsed, persists via localStorage. -->
  <aside
    :class="[
      'hidden lg:flex lg:flex-col lg:shrink-0 lg:border-r lg:border-border lg:bg-card lg:sticky lg:top-0 lg:h-screen lg:transition-all lg:duration-200',
      isCollapsed ? 'lg:w-16' : 'lg:w-64',
    ]"
  >
    <!-- Sidebar header — same h-14 as the global navbar so the two
         chrome regions share a baseline. Operations palette runs
         denser than the prior h-20 editorial header. -->
    <div class="flex h-14 items-center justify-between px-3 border-b border-border">
      <NuxtLink :to="{ name: 'dashboard' }" class="flex items-center font-semibold text-foreground overflow-hidden">
        <BrandLogo
          v-if="!isCollapsed"
          class="h-8 w-auto"
        />
        <BrandLogo
          v-else
          class="h-8 w-8 object-cover object-left"
        />
      </NuxtLink>
      <button
        v-if="!isCollapsed"
        type="button"
        class="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-ring"
        :title="'Collapse sidebar'"
        @click="toggleCollapsed"
      >
        <ChevronDoubleLeft :size="16" />
      </button>
    </div>

    <!-- Search / command-palette trigger. Bound to the existing
         useCommandPalette() global state — same surface âŒ˜K opens. -->
    <button
      type="button"
      class="mx-3 mt-3 flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      :title="'Search · ' + hotkeyLabel"
      @click="palette.open()"
    >
      <Magnify :size="16" />
      <span v-if="!isCollapsed" class="flex-1 text-left">Search…</span>
      <kbd
        v-if="!isCollapsed"
        class="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
      >
        {{ hotkeyLabel }}
      </kbd>
    </button>

    <!-- Re-expand affordance when collapsed: a small button below the
         search row. Avoids hiding the toggle entirely once collapsed. -->
    <button
      v-if="isCollapsed"
      type="button"
      class="mx-3 mt-1 flex items-center justify-center rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
      :title="'Expand sidebar'"
      @click="toggleCollapsed"
    >
      <ChevronDoubleRight :size="16" />
    </button>

    <nav class="flex-1 overflow-y-auto px-3 py-4" aria-label="Primary">
      <div v-for="(section, idx) in visibleSections" :key="section.label" :class="idx > 0 ? 'mt-1.5' : ''">
        <!-- Domain header. In expanded mode it's a click-to-toggle button
             rendered as a row with the domain icon, label, and chevron.
             In collapsed mode it's just the icon (linking to the
             primary route) — saves vertical space and lets users
             click straight to the domain hub.

             Active domain (route lives within domainRoutes) auto-expands
             and renders the brass accent bar. Other domains collapse
             unless the user manually toggles them. -->
        <component
          :is="section.primaryRoute ? 'NuxtLink' : 'div'"
          v-if="isCollapsed"
          :to="section.primaryRoute ? { name: section.primaryRoute } : undefined"
          :title="section.label"
          :class="[
            'group relative flex items-center justify-center rounded-md py-1.5 px-2 transition-colors duration-150',
            activeDomainKey === section.label
              ? 'bg-accent text-foreground'
              : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
          ]"
        >
          <span
            v-if="activeDomainKey === section.label"
            class="absolute inset-y-1.5 left-0 w-[2px] rounded-r bg-brass"
            aria-hidden="true"
          />
          <component :is="section.icon || section.links[0]?.icon" :size="18" />
        </component>
        <button
          v-else
          type="button"
          class="group flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left transition-colors duration-150"
          :class="activeDomainKey === section.label
            ? 'text-foreground'
            : 'text-muted-foreground hover:text-foreground'"
          :aria-expanded="isExpanded(section.label)"
          @click="toggleDomain(section.label)"
        >
          <component :is="section.icon || section.links[0]?.icon" :size="16" class="shrink-0" />
          <span class="flex-1 truncate text-[13px] font-semibold">
            {{ section.label }}
          </span>
          <ChevronDown
            :size="14"
            :class="['shrink-0 transition-transform duration-150', isExpanded(section.label) ? 'rotate-0' : '-rotate-90']"
            aria-hidden="true"
          />
        </button>
        <!-- Children — render only when expanded. Active-domain auto-
             expand keeps brokers in their current workspace context;
             a click on another domain header reveals its children
             without navigating. -->
        <div
          v-if="!isCollapsed && isExpanded(section.label)"
          class="mt-1 space-y-0.5"
        >
          <NuxtLink
            v-for="link in section.links"
            :key="link.text"
            :to="{ name: link.name, query: link.query }"
            :title="isCollapsed ? link.text : undefined"
            :class="[
              'group relative flex items-center gap-2.5 rounded-md transition-colors duration-150 ease-out',
              link.subdued ? 'py-1' : 'py-1.5',
              isCollapsed
                ? 'px-2 justify-center'
                : link.subdued ? 'pr-2 pl-7 text-[12px] font-medium' : 'pr-2 pl-2 text-[13px] font-medium',
              isLinkActive(link)
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
            ]"
          >
            <!-- Active marker — brass accent bar on the left. Brass
                 is the sidebar's identity color in the Estate aesthetic
                 (premium, editorial, not "tech blue"). -->
            <span
              v-if="isLinkActive(link)"
              class="absolute inset-y-1.5 left-0 w-[2px] rounded-r bg-brass"
              aria-hidden="true"
            />
            <!-- Icon. Subdued sub-items get a smaller glyph so the
                 hierarchy reads "parent then children". No chip
                 background — the icon itself is the affordance. -->
            <span
              :class="[
                'flex shrink-0 items-center justify-center transition-colors duration-150',
                link.subdued && !isCollapsed ? 'h-4 w-4' : 'h-5 w-5',
                isLinkActive(link)
                  ? 'text-foreground'
                  : 'text-muted-foreground group-hover:text-foreground',
              ]"
            >
              <component :is="link.icon" :size="link.subdued && !isCollapsed ? 13 : 16" />
            </span>
            <span v-if="!isCollapsed" class="flex-1 truncate">{{ link.text }}</span>
            <!-- Badge: full pill when expanded; small accent dot when
                 collapsed. Color reflects severity, not link identity. -->
            <span
              v-if="badgeFor(link) !== null && !isCollapsed"
              :class="['rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums', badgeClasses[severityFor(link, badgeFor(link)!)]]"
            >
              {{ badgeText(badgeFor(link)!) }}
            </span>
            <span
              v-else-if="badgeFor(link) !== null && isCollapsed"
              class="absolute right-1 top-1 h-2 w-2 rounded-full bg-primary"
              aria-hidden="true"
            />
          </NuxtLink>
        </div>
      </div>
    </nav>

    <!-- Settings / logout strip. Single row when expanded; stacked
         icon buttons when collapsed so they stay clickable in the
         narrow gutter. -->
    <div
      :class="[
        'mx-3 mb-2 flex gap-1',
        isCollapsed ? 'flex-col items-center' : 'items-center',
      ]"
    >
      <NuxtLink
        to="/notification-settings"
        :title="'Notification settings'"
        :class="[
          'flex items-center gap-2 rounded-md text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
          isCollapsed ? 'p-2 justify-center' : 'flex-1 px-3 py-1.5',
        ]"
      >
        <Cog :size="16" />
        <span v-if="!isCollapsed">Settings</span>
      </NuxtLink>
      <!-- Theme toggle. Sun icon when in light mode (clicking goes to
           dark), moon icon when in dark mode. Stays icon-only even
           when sidebar is expanded — wider button would crowd out
           Settings + Sign out. -->
      <button
        type="button"
        :title="theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'"
        :aria-label="theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'"
        class="flex items-center justify-center rounded-md p-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        @click="toggleTheme"
      >
        <WeatherSunny v-if="theme === 'dark'" :size="16" />
        <WeatherNight v-else :size="16" />
      </button>
      <button
        type="button"
        :title="'Sign out'"
        :class="[
          'flex items-center gap-2 rounded-md text-sm text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive',
          isCollapsed ? 'p-2 justify-center' : 'flex-1 px-3 py-1.5',
        ]"
        @click="logout"
      >
        <Logout :size="16" />
        <span v-if="!isCollapsed">Sign out</span>
      </button>
    </div>

    <!-- User profile footer. Click → /my-profile. Collapses to
         avatar-only when isCollapsed. -->
    <NuxtLink
      to="/my-profile"
      :title="isCollapsed ? `${display.name} · view profile` : undefined"
      :class="[
        'mx-3 mb-3 flex items-center rounded-lg border border-border bg-background transition-colors hover:bg-accent',
        isCollapsed ? 'justify-center p-1.5' : 'gap-3 px-3 py-2',
      ]"
    >
      <div class="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/10 text-primary">
        <img
          v-if="display.avatar"
          :src="display.avatar"
          :alt="display.name"
          class="h-full w-full object-cover"
        />
        <span v-else class="text-xs font-semibold">{{ display.initial }}</span>
      </div>
      <div v-if="!isCollapsed" class="min-w-0 flex-1">
        <p class="truncate text-xs font-semibold text-foreground">{{ display.name }}</p>
        <p class="truncate text-[10px] text-muted-foreground">
          {{ display.email || 'View profile' }}
        </p>
      </div>
    </NuxtLink>
  </aside>

  <!-- Mobile drawer (<lg). Slides in from the left. -->
  <DialogRoot v-model:open="mobileOpen">
    <DialogPortal>
      <DialogOverlay
        class="fixed inset-0 z-[9998] bg-foreground/55 lg:hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
      />
      <DialogContent
        :class="[
          'fixed inset-y-0 left-0 z-[9999] flex w-72 flex-col border-r border-border bg-card lg:hidden outline-none',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          'data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left',
          'data-[state=closed]:duration-200 data-[state=open]:duration-300',
        ]"
        :aria-describedby="undefined"
      >
        <DialogTitle class="sr-only">Navigation</DialogTitle>
        <DialogDescription class="sr-only">Primary navigation menu.</DialogDescription>

        <div class="flex h-14 items-center justify-between px-4 border-b border-border-strong">
          <NuxtLink :to="{ name: 'dashboard' }" class="flex items-center font-semibold text-foreground">
            <BrandLogo class="h-8 w-auto" />
          </NuxtLink>
          <button
            type="button"
            class="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-ring"
            aria-label="Close menu"
            @click="close"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
              <path d="M3 3l10 10M13 3L3 13" />
            </svg>
          </button>
        </div>

        <button
          type="button"
          class="mx-3 mt-3 flex h-9 items-center gap-2 rounded-md border border-border bg-surface-2 px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground hover:border-border-strong focus-ring"
          @click="palette.open(); close()"
        >
          <Magnify :size="16" />
          <span class="flex-1 text-left">Search…</span>
        </button>

        <nav class="flex-1 overflow-y-auto px-3 py-4" aria-label="Primary mobile">
          <div v-for="(section, idx) in visibleSections" :key="section.label" :class="idx > 0 ? 'mt-1.5' : ''">
            <!-- Domain header — same expand/collapse pattern as the
                 desktop nav. Mobile users tap to reveal children;
                 active domain auto-expands. -->
            <button
              type="button"
              class="group flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left transition-colors"
              :class="activeDomainKey === section.label
                ? 'text-foreground'
                : 'text-muted-foreground hover:text-foreground'"
              :aria-expanded="isExpanded(section.label)"
              @click="toggleDomain(section.label)"
            >
              <component :is="section.icon || section.links[0]?.icon" :size="16" class="shrink-0" />
              <span class="flex-1 truncate text-sm font-semibold">{{ section.label }}</span>
              <ChevronDown
                :size="14"
                :class="['shrink-0 transition-transform', isExpanded(section.label) ? 'rotate-0' : '-rotate-90']"
                aria-hidden="true"
              />
            </button>
            <div v-if="isExpanded(section.label)" class="mt-1 space-y-0.5">
              <NuxtLink
                v-for="link in section.links"
                :key="link.text"
                :to="{ name: link.name, query: link.query }"
                :class="[
                  'group relative flex items-center gap-3 rounded-lg transition-colors',
                  link.subdued ? 'py-1 pr-2 pl-7 text-xs font-medium' : 'py-1.5 pr-2 pl-2 text-sm font-medium',
                  isLinkActive(link)
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
                ]"
              >
                <span
                  v-if="isLinkActive(link)"
                  class="absolute inset-y-1 left-0 w-0.5 rounded-r bg-brass"
                  aria-hidden="true"
                />
                <span
                  :class="[
                    'flex shrink-0 items-center justify-center transition-colors',
                    link.subdued ? 'h-5 w-5' : 'h-6 w-6',
                    isLinkActive(link)
                      ? 'text-foreground'
                      : 'text-muted-foreground group-hover:text-foreground',
                  ]"
                >
                  <component :is="link.icon" :size="link.subdued ? 14 : 18" />
                </span>
                <span class="flex-1 truncate">{{ link.text }}</span>
                <span
                  v-if="badgeFor(link) !== null"
                  :class="['rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums', badgeClasses[severityFor(link, badgeFor(link)!)]]"
                >
                  {{ badgeText(badgeFor(link)!) }}
                </span>
              </NuxtLink>
            </div>
          </div>
        </nav>

        <div class="mx-3 mb-2 flex items-center gap-1">
          <NuxtLink
            to="/notification-settings"
            class="flex flex-1 items-center gap-2 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Cog :size="16" />
            <span>Settings</span>
          </NuxtLink>
          <button
            type="button"
            :title="theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'"
            :aria-label="theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'"
            class="flex items-center justify-center rounded-md p-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            @click="toggleTheme"
          >
            <WeatherSunny v-if="theme === 'dark'" :size="16" />
            <WeatherNight v-else :size="16" />
          </button>
          <button
            type="button"
            class="flex flex-1 items-center gap-2 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            @click="logout"
          >
            <Logout :size="16" />
            <span>Sign out</span>
          </button>
        </div>

        <NuxtLink
          to="/my-profile"
          class="mx-3 mb-3 flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2 transition-colors hover:bg-accent"
        >
          <div class="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/10 text-primary">
            <img
              v-if="display.avatar"
              :src="display.avatar"
              :alt="display.name"
              class="h-full w-full object-cover"
            />
            <span v-else class="text-xs font-semibold">{{ display.initial }}</span>
          </div>
          <div class="min-w-0 flex-1">
            <p class="truncate text-xs font-semibold text-foreground">{{ display.name }}</p>
            <p class="truncate text-[10px] text-muted-foreground">
              {{ display.email || 'View profile' }}
            </p>
          </div>
        </NuxtLink>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
