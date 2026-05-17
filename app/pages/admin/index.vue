<script setup lang="ts">
// /admin — gated entry point.
//
// Access is gated TWO ways. Both must hold for the page to be useful;
// either alone is not enough:
//
//   1. UI guard: this page calls has_permission('admin.access') in
//      onMounted. If false, the user is bounced to /dashboard and a
//      toast explains why. Pure UX — prevents the page from rendering
//      a half-loaded form to a non-admin while RLS rejects every query.
//
//   2. Backend RLS: even if a non-admin somehow lands here, every
//      mutation in the child components hits a policy gated by
//      has_permission('users.manage') or current_user_role()='admin'.
//      Service role is never used on the client.

import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useUserProfile } from '~/composables/useAuth'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import AdminHero from '~/components/admin/AdminHero.vue'
import AdminSecondaryNav from '~/components/admin/AdminSecondaryNav.vue'
import OperationsStatusStrip from '~/components/admin/OperationsStatusStrip.vue'
import UsersTable from '~/components/admin/UsersTable.vue'
import RolePermissions from '~/components/admin/RolePermissions.vue'
import VerificationsTabs from '~/components/admin/VerificationsTabs.vue'
import SourcesTable from '~/components/admin/SourcesTable.vue'
import ActivityLog from '~/components/admin/ActivityLog.vue'
import BroadcastCompose from '~/components/admin/BroadcastCompose.vue'
import LegacyReconcile from '~/components/admin/LegacyReconcile.vue'
import WebhookSubscriptions from '~/components/admin/WebhookSubscriptions.vue'
import UnassignedInquiries from '~/components/admin/UnassignedInquiries.vue'
import ReviewModerationQueue from '~/components/admin/ReviewModerationQueue.vue'
import OrganizationsTab from '~/components/admin/OrganizationsTab.vue'
import DuplicateReviewQueue from '~/components/admin/DuplicateReviewQueue.vue'
import BrokerImportTab from '~/components/admin/BrokerImportTab.vue'
import ListingImportTab from '~/components/admin/ListingImportTab.vue'
import PendingListingsTab from '~/components/admin/PendingListingsTab.vue'
import BrokerInvitationsTab from '~/components/admin/BrokerInvitationsTab.vue'
import SavedSearchPreviewTab from '~/components/admin/SavedSearchPreviewTab.vue'

definePageMeta({
  layout: 'default',
})

useHead({ title: 'Admin | Housinginteractive' })

// Ensure the profile is loaded; the visual "you" tag in UsersTable
// depends on it, and triggering it here means the cache is warm before
// the children mount.
useUserProfile()

type Tab =
  | 'users'
  | 'permissions'
  | 'verifications'
  | 'sources'
  | 'activity'
  | 'broadcast'
  | 'reconcile'
  | 'webhooks'
  | 'triage'
  | 'moderation'
  | 'organizations'
  | 'duplicates'
  | 'broker-import'
  | 'listing-import'
  | 'pending-listings'
  | 'broker-invitations'
  | 'saved-search-preview'
const tab = ref<Tab>('users')

// Allow deep-linking from notification href: /admin?tab=verifications
const route = useRoute()
const initialTab = (route.query.tab as Tab | undefined) ?? 'users'
if (
  initialTab === 'users' ||
  initialTab === 'permissions' ||
  initialTab === 'verifications' ||
  initialTab === 'sources' ||
  initialTab === 'activity' ||
  initialTab === 'broadcast' ||
  initialTab === 'reconcile' ||
  initialTab === 'webhooks' ||
  initialTab === 'triage' ||
  initialTab === 'moderation' ||
  initialTab === 'organizations' ||
  initialTab === 'duplicates' ||
  initialTab === 'broker-import' ||
  initialTab === 'listing-import' ||
  initialTab === 'pending-listings' ||
  initialTab === 'broker-invitations' ||
  initialTab === 'saved-search-preview'
) {
  tab.value = initialTab
}

// KPI badges fed into the secondary nav. Single round-trip via the
// admin summary endpoint; refreshed on mount + every 60s while the
// page is open. Failures silently zero out (matches the Hero's own
// resilience). AdminPageShell handles the access gate.
type SummaryKpi = {
  active_users: number
  pending_verifications: number
  failed_imports: number
  duplicate_candidates: number
  alerts: number
  alerts_critical: number
  alerts_warning: number
}
const summary = ref<SummaryKpi | null>(null)
let summaryTimer: ReturnType<typeof setInterval> | null = null

async function loadSummary() {
  try {
    const res = await $fetch<{ kpi: SummaryKpi }>('/api/admin/summary')
    summary.value = res?.kpi ?? null
  } catch {
    // Leave whatever was last loaded — no flicker on transient errors.
  }
}

onBeforeUnmount(() => {
  if (summaryTimer) clearInterval(summaryTimer)
})

onMounted(() => {
  // Hero loads its own KPI fetch; duplicating here drives the
  // secondary-nav badge counts. Polled every 60s while the page is
  // mounted so badges stay fresh without a websocket. AdminPageShell
  // already gated the page on admin.access — children only mount after
  // the RPC confirms.
  // Initial badge fetch + 60s poll. Errors here would leave the
  // sidebar counts stale; surface in console so flaky RLS / network
  // is visible during launch monitoring. The UI degrades gracefully
  // (badges just don't paint) so we don't toast.
  loadSummary().catch((err) =>
    console.warn('[admin index] initial summary load failed', err),
  )
  summaryTimer = setInterval(
    () => loadSummary().catch((err) =>
      console.warn('[admin index] summary poll failed', err),
    ),
    60_000,
  )
})
</script>

<template>
  <AdminPageShell permission="admin.access" max-width="wide">
    <!-- Operations Control Center hero + 5-card KPI strip -->
    <AdminHero />

    <!-- Persistent ops status strip — 6 indicators (verifications,
         failed imports, duplicates, webhooks, cron, alerts). Click
         any indicator to drill into the relevant tab/page. Polls
         every 60s; calm by default, lights up only when something
         needs attention. -->
    <OperationsStatusStrip />

    <!-- Two-column body: secondary nav (240px on lg+) + content -->
    <div class="grid gap-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
      <!-- Secondary nav. Mobile: select dropdown. Desktop: vertical
           grouped list. Active row gets the blue accent left bar. -->
      <aside class="lg:sticky lg:top-20 lg:self-start">
        <AdminSecondaryNav
          v-model="tab"
          :badges="summary ?? undefined"
        />
      </aside>

      <main class="min-w-0">
        <!-- Tab content. Mounted lazily and KeepAlive-cached so each
             tab loads its own data only on first open. -->
        <KeepAlive>
          <UsersTable v-if="tab === 'users'" key="users" />
          <RolePermissions v-else-if="tab === 'permissions'" key="permissions" />
          <VerificationsTabs v-else-if="tab === 'verifications'" key="verifications" />
          <SourcesTable v-else-if="tab === 'sources'" key="sources" />
          <ActivityLog v-else-if="tab === 'activity'" key="activity" />
          <BroadcastCompose v-else-if="tab === 'broadcast'" key="broadcast" />
          <LegacyReconcile v-else-if="tab === 'reconcile'" key="reconcile" />
          <WebhookSubscriptions v-else-if="tab === 'webhooks'" key="webhooks" />
          <UnassignedInquiries v-else-if="tab === 'triage'" key="triage" />
          <ReviewModerationQueue v-else-if="tab === 'moderation'" key="moderation" />
          <OrganizationsTab v-else-if="tab === 'organizations'" key="organizations" />
          <DuplicateReviewQueue v-else-if="tab === 'duplicates'" key="duplicates" />
          <BrokerImportTab v-else-if="tab === 'broker-import'" key="broker-import" />
          <ListingImportTab v-else-if="tab === 'listing-import'" key="listing-import" />
          <PendingListingsTab v-else-if="tab === 'pending-listings'" key="pending-listings" />
          <BrokerInvitationsTab v-else-if="tab === 'broker-invitations'" key="broker-invitations" />
          <SavedSearchPreviewTab v-else key="saved-search-preview" />
        </KeepAlive>
      </main>
    </div>
  </AdminPageShell>
</template>
