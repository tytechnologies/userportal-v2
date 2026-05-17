<script setup lang="ts">
/**
 * Breadcrumb trail.
 *
 * Two modes:
 *
 *   1. Auto: derive crumbs from the current route name. The component
 *      maps the route into a domain ("Listings", "CRM", etc.) using a
 *      small registry, then optionally appends a trailing entity-name
 *      crumb supplied via the `entity` prop.
 *
 *   2. Explicit: pass a `crumbs` array of `{ label, to? }`. Useful for
 *      pages where the auto-derivation doesn't have enough info
 *      (e.g. an entity name that comes from an async fetch).
 *
 * Visual: minimal — no icons, just text with " › " separators. The
 * last crumb is non-clickable (it's the current page); earlier
 * crumbs are NuxtLink-driven if `to` is supplied.
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'

export type Crumb = {
  label: string
  to?: string | { name: string; query?: Record<string, string> }
}

const props = defineProps<{
  /** Optional entity-specific tail crumb. When set, appended after
   *  the auto-derived domain/route crumbs. Pure label or full
   *  Crumb object. */
  entity?: string | Crumb
  /** When set, replaces the auto-derivation entirely. */
  crumbs?: Crumb[]
}>()

const route = useRoute()

/** Maps route names → (domain label, route label, parent path).
 *  Kept inline rather than imported from a sidebar registry because
 *  the breadcrumb only needs a flat lookup; the sidebar's tree
 *  metadata is overkill here. Add a row when you ship a new domain
 *  page. */
const ROUTE_REGISTRY: Record<string, { domain: string; domainTo?: string; label: string; parentTo?: string; parentLabel?: string }> = {
  // Dashboard
  'dashboard':                       { domain: 'Dashboard',        domainTo: '/dashboard',           label: 'Overview' },

  // Listings
  'listings':                        { domain: 'Listings',         domainTo: '/listings',            label: 'All listings' },
  'listing':                         { domain: 'Listings',         domainTo: '/listings',            label: 'Listing detail' },
  'listing-history':                 { domain: 'Listings',         domainTo: '/listings',            label: 'History' },
  'archives':                        { domain: 'Listings',         domainTo: '/listings',            label: 'Archives' },
  'outdated':                        { domain: 'Listings',         domainTo: '/listings',            label: 'Outdated' },
  'featured-listings':               { domain: 'Listings',         domainTo: '/listings',            label: 'Featured' },
  'deck':                            { domain: 'Listings',         domainTo: '/listings',            label: 'Deck' },
  'buildings':                       { domain: 'Listings',         domainTo: '/listings',            label: 'Buildings' },
  'buildings-id':                    { domain: 'Listings',         domainTo: '/listings',            label: 'Building',                  parentTo: '/buildings', parentLabel: 'Buildings' },

  // CRM
  'crm':                             { domain: 'CRM',              domainTo: '/crm',                 label: 'Hub' },
  'contacts':                        { domain: 'CRM',              domainTo: '/crm',                 label: 'Contacts' },
  'contacts-id':                     { domain: 'CRM',              domainTo: '/crm',                 label: 'Contact',                   parentTo: '/contacts', parentLabel: 'Contacts' },
  'tasks':                           { domain: 'CRM',              domainTo: '/crm',                 label: 'Tasks' },
  'viewings':                        { domain: 'CRM',              domainTo: '/crm',                 label: 'Viewings' },
  'shares':                          { domain: 'CRM',              domainTo: '/crm',                 label: 'Shares' },

  // Inquiries
  'inquiries':                       { domain: 'Inquiries',        domainTo: '/inquiries',           label: 'Inbox' },

  // Deals
  'deals':                           { domain: 'Deals',            domainTo: '/deals',               label: 'Pipeline' },
  'deals-id':                        { domain: 'Deals',            domainTo: '/deals',               label: 'Deal',                      parentTo: '/deals', parentLabel: 'Pipeline' },

  // Transactions
  'transactions':                    { domain: 'Transactions',     domainTo: '/transactions',        label: 'Closing rooms' },
  'transactions-id':                 { domain: 'Transactions',     domainTo: '/transactions',        label: 'Room',                      parentTo: '/transactions', parentLabel: 'Closing rooms' },

  // Documents
  'document-drafts':                 { domain: 'Documents',        domainTo: '/document-drafts',     label: 'Drafts' },
  'document-drafts-new':             { domain: 'Documents',        domainTo: '/document-drafts',     label: 'New draft' },
  'document-drafts-id':              { domain: 'Documents',        domainTo: '/document-drafts',     label: 'Draft',                     parentTo: '/document-drafts', parentLabel: 'Drafts' },
  'envelopes':                       { domain: 'Documents',        domainTo: '/document-drafts',     label: 'Envelopes' },
  'document-tabs':                   { domain: 'Documents',        domainTo: '/document-drafts',     label: 'Doc checklist' },

  // Property Management
  'property-management':             { domain: 'Property Mgmt',    domainTo: '/property-management', label: 'Hub' },
  'admin-leases':                    { domain: 'Property Mgmt',    domainTo: '/property-management', label: 'Leases' },
  'admin-units':                     { domain: 'Property Mgmt',    domainTo: '/property-management', label: 'Units' },
  'admin-work-orders':               { domain: 'Property Mgmt',    domainTo: '/property-management', label: 'Work orders' },
  'admin-maintenance':               { domain: 'Property Mgmt',    domainTo: '/property-management', label: 'Maintenance' },
  'admin-inspections':               { domain: 'Property Mgmt',    domainTo: '/property-management', label: 'Inspections' },
  'admin-vendors':                   { domain: 'Property Mgmt',    domainTo: '/property-management', label: 'Vendors' },
  'admin-owners':                    { domain: 'Property Mgmt',    domainTo: '/property-management', label: 'Owners' },
  'admin-property-charges':          { domain: 'Property Mgmt',    domainTo: '/property-management', label: 'Charges' },
  'admin-late-fees':                 { domain: 'Property Mgmt',    domainTo: '/property-management', label: 'Late fees' },

  // Accounting
  'accounting':                      { domain: 'Accounting',       domainTo: '/accounting',          label: 'Hub' },
  'admin-accounting':                { domain: 'Accounting',       domainTo: '/accounting',          label: 'Ledger' },
  'admin-journal-entry-new':         { domain: 'Accounting',       domainTo: '/accounting',          label: 'New journal entry' },
  'admin-bank-reconciliation':       { domain: 'Accounting',       domainTo: '/accounting',          label: 'Bank reconciliation' },
  'admin-statements':                { domain: 'Accounting',       domainTo: '/accounting',          label: 'Statements' },
  'admin-platform-commission-rule':  { domain: 'Accounting',       domainTo: '/accounting',          label: 'Commission rules' },

  // Analytics
  'market':                          { domain: 'Analytics',        domainTo: '/market',              label: 'Market intelligence' },
  'analytics':                       { domain: 'Analytics',        domainTo: '/analytics',           label: 'Reports' },
  'admin-operations':                { domain: 'Analytics',        domainTo: '/admin/operations',    label: 'Operations' },

  // AI Tools
  'ai-tools':                        { domain: 'AI Tools',         domainTo: '/ai-tools',            label: 'Hub' },
  'admin-clause-library':            { domain: 'AI Tools',         domainTo: '/ai-tools',            label: 'Clause library' },
  'admin-ai-suggestions':            { domain: 'AI Tools',         domainTo: '/ai-tools',            label: 'AI suggestions' },
  'admin-ai-settings':               { domain: 'AI Tools',         domainTo: '/ai-tools',            label: 'AI settings' },

  // Administration
  'admin':                           { domain: 'Administration',   domainTo: '/admin',               label: 'Users' },
  'admin-document-templates':        { domain: 'Administration',   domainTo: '/admin',               label: 'Document templates' },
  'admin-document-templates-id':     { domain: 'Administration',   domainTo: '/admin',               label: 'Template',                  parentTo: '/admin/document-templates', parentLabel: 'Templates' },
  'admin-government-documents':      { domain: 'Administration',   domainTo: '/admin',               label: 'Doc checklist (admin)' },
  'admin-esign-settings':            { domain: 'Administration',   domainTo: '/admin',               label: 'eSign (DocuSign)' },
  'admin-listing-syndication':       { domain: 'Administration',   domainTo: '/admin',               label: 'Listing syndication' },
  'admin-lead-routing':              { domain: 'Administration',   domainTo: '/admin',               label: 'Lead routing' },
  'admin-platform-settings':         { domain: 'Administration',   domainTo: '/admin',               label: 'Platform settings' },
}

const derived = computed<Crumb[]>(() => {
  if (props.crumbs) return props.crumbs

  const rname = String(route.name || '')
  const entry = ROUTE_REGISTRY[rname]
  if (!entry) {
    // Unknown route — show only the entity tail if provided.
    if (props.entity) return [normalizeEntity(props.entity)]
    return []
  }

  const out: Crumb[] = [
    { label: entry.domain, to: entry.domainTo },
  ]
  if (entry.parentTo && entry.parentLabel) {
    out.push({ label: entry.parentLabel, to: entry.parentTo })
  }
  out.push({ label: entry.label })

  if (props.entity) {
    // Replace the last (route-level) crumb with the entity tail when
    // the page is a detail view — the registry's "Deal" / "Contact"
    // generic gets overridden by the actual entity name.
    out.pop()
    out.push(normalizeEntity(props.entity))
  }
  return out
})

function normalizeEntity(e: string | Crumb): Crumb {
  return typeof e === 'string' ? { label: e } : e
}
</script>

<template>
  <nav v-if="derived.length > 0" aria-label="Breadcrumb" class="mb-3">
    <ol class="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
      <li
        v-for="(c, idx) in derived"
        :key="idx"
        class="flex items-center gap-1"
      >
        <span
          v-if="idx > 0"
          aria-hidden="true"
          class="text-muted-foreground/60"
        >
          ›
        </span>
        <NuxtLink
          v-if="c.to && idx < derived.length - 1"
          :to="c.to"
          class="hover:text-foreground focus-ring rounded transition-colors"
        >
          {{ c.label }}
        </NuxtLink>
        <span
          v-else
          :class="idx === derived.length - 1 ? 'text-foreground font-medium' : ''"
        >
          {{ c.label }}
        </span>
      </li>
    </ol>
  </nav>
</template>
