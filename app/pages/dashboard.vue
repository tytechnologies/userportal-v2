<script setup lang="ts">
/**
 * Dashboard — Operations palette redesign.
 *
 * Answer "what needs attention RIGHT NOW?" before anything else.
 *
 * Layout rhythm (action-first, vanity-last):
 *   1. Hero zone (compact) — onboarding hero OR standard hero with
 *      single attention counter. No magazine display.
 *   2. NEEDS ATTENTION — full-width lede. Operational queues live
 *      here so the first scroll-beat is "act on this," not "look at
 *      these counters."
 *   3. Personal scope — caller's open tasks + recent inquiries.
 *   4. Pipeline — inquiry funnel + deals by stage. Where work is.
 *   5. Alerts — stale listings + pipeline alerts (each self-hides
 *      when there's nothing to flag).
 *   6. Activity — recent activity feed.
 *   7. Performance strip (demoted) — KPI counters at the bottom so
 *      they answer "is everything OK" without crowding the lede.
 *
 * Removed in this redesign (per the operational brief):
 *   - TrendChart (giant chart, low-actionable)
 *   - AgentLeaderboard (vanity / non-operational)
 *   - InquirySources (channel attribution — analytics, not action)
 *   - ListingsBreakdown / Inventory & portfolio section (vanity)
 *   - Brass-accent Deck CTA section (editorial moment)
 *   - Twin "Total value · Sale" / "Total value · Rent" tiles
 *   - CrmWidgets (decorative)
 *
 * If any of these come back, they belong on a dedicated /reports or
 * /analytics surface, not on the operator's home screen.
 */
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import DashboardHero from '~/components/dashboard/DashboardHero.vue'
import BrokerageOnboardingHero from '~/components/dashboard/BrokerageOnboardingHero.vue'
import OnboardingChecklist from '~/components/dashboard/OnboardingChecklist.vue'
import ProfileCompletionPrompt from '~/components/dashboard/ProfileCompletionPrompt.vue'
import NeedsAttentionPanel from '~/components/dashboard/NeedsAttentionPanel.vue'
import AnalyticsKpiStrip from '~/components/dashboard/AnalyticsKpiStrip.vue'
import ActivityFeed from '~/components/dashboard/ActivityFeed.vue'
import InquiryFunnel from '~/components/dashboard/InquiryFunnel.vue'
import MyDealsByStage from '~/components/dashboard/MyDealsByStage.vue'
import MyUpcomingViewings from '~/components/dashboard/MyUpcomingViewings.vue'
import MyOpenTasks from '~/components/dashboard/MyOpenTasks.vue'
import MyRecentInquiries from '~/components/dashboard/MyRecentInquiries.vue'
import StaleListings from '~/components/dashboard/StaleListings.vue'
import PipelineAlertsWidget from '~/components/dashboard/PipelineAlertsWidget.vue'
import DashboardFooter from '~/components/DashboardFooter.vue'

const router = useRouter()

// Org membership probe — drives whether we show the onboarding hero
// (zero memberships) or the standard hero (one or more memberships).
type OrgMembership = { id: string; org_role: string; status: string }
const orgMemberships = ref<OrgMembership[]>([])
const orgMembershipsLoaded = ref(false)
const hasNoOrg = computed(() => orgMembershipsLoaded.value && orgMemberships.value.length === 0)

// Snooze: when the user clicks "Skip for now" we stamp localStorage
// with a timestamp and hide the onboarding hero until SNOOZE_MS has
// elapsed. Per-device only — fine for a "remind me later" UX. If the
// user actually creates an org in the meantime, hasNoOrg flips and
// the banner self-resolves without checking the snooze.
const SNOOZE_KEY = 'hi.brokerage_onboarding.snoozed_at'
const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000  // 14 days
const onboardingSnoozed = ref(false)

function readSnooze(): number | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(SNOOZE_KEY)
    if (!raw) return null
    const ts = Number(raw)
    return Number.isFinite(ts) ? ts : null
  } catch {
    return null
  }
}

function refreshSnoozeState() {
  const ts = readSnooze()
  onboardingSnoozed.value = !!(ts && Date.now() - ts < SNOOZE_MS)
}

function dismissBrokerageOnboarding() {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SNOOZE_KEY, String(Date.now()))
  } catch {
    // Quota exceeded / private mode — silently swallow; the user can
    // refresh next time and dismiss again.
  }
  onboardingSnoozed.value = true
}

// Show the hero only when the user has no org AND the snooze isn't
// active. Standard hero takes over otherwise.
const showOnboardingHero = computed(() => hasNoOrg.value && !onboardingSnoozed.value)

async function loadOrgMemberships() {
  try {
    const res = await $fetch<{ memberships: OrgMembership[] }>('/api/organizations')
    orgMemberships.value = res.memberships ?? []
  } catch {
    orgMemberships.value = []
  } finally {
    orgMembershipsLoaded.value = true
  }
}

// Post-signup wizard redirect. Independent of the dashboard-hero snooze
// (different key, different UX): the wizard catches BRAND NEW brokers
// on first login and walks them through brokerage → invite → listing.
// Auto-redirect fires when:
//   - the dashboard is the entry point (this onMounted hook)
//   - onboarding is incomplete (any of has_org / team_size / listings missing)
//   - the user hasn't already skipped the wizard within the snooze window
// Skip persists per-device. Returning to /dashboard inside the window
// stays on the dashboard; outside the window, the wizard re-prompts.
const WIZARD_SKIP_KEY = 'hi.onboarding_wizard.skipped_at'
const WIZARD_SKIP_MS  = 14 * 24 * 60 * 60 * 1000  // 14 days

function wizardSkipActive(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const raw = window.localStorage.getItem(WIZARD_SKIP_KEY)
    if (!raw) return false
    const ts = Number(raw)
    return Number.isFinite(ts) && Date.now() - ts < WIZARD_SKIP_MS
  } catch {
    return false
  }
}

async function maybeRedirectToOnboardingWizard() {
  if (wizardSkipActive()) return
  try {
    const p = await $fetch<{ is_complete: boolean }>(
      '/api/dashboard/onboarding-progress',
    )
    if (!p?.is_complete) {
      // Use router so we don't trigger a full-page reload — keeps the
      // Supabase session in memory across the navigation.
      router.push('/onboarding/welcome')
    }
  } catch {
    // Progress endpoint failing isn't worth blocking the dashboard for.
    // The OnboardingChecklist widget on the dashboard surfaces the
    // milestones inline as a fallback.
  }
}

onMounted(() => {
  refreshSnoozeState()
  loadOrgMemberships()
  maybeRedirectToOnboardingWizard()
})

// Attention payload — single round-trip used by Hero (count) + Panel (rows).
type Attention = {
  total_count: number
  sections: Record<string, { count: number; items: any[]; note?: string }>
}
const attention = ref<Attention | null>(null)
const attentionLoading = ref(true)

async function loadAttention() {
  attentionLoading.value = true
  try {
    const res = await $fetch<Attention>('/api/dashboard/attention')
    attention.value = res
  } catch {
    attention.value = null
  } finally {
    attentionLoading.value = false
  }
}

onMounted(loadAttention)
</script>

<template>
  <div class="mx-auto max-w-[1400px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
    <!-- 1. Hero zone — compact. Onboarding variant for users with no
         org AND no active snooze; standard variant otherwise. The
         snooze fires on the hero's "Skip for now" button and lasts
         ~2 weeks per device. Creating an org bypasses the snooze
         (hasNoOrg flips to false and we render the standard hero). -->
    <BrokerageOnboardingHero
      v-if="showOnboardingHero"
      @dismiss="dismissBrokerageOnboarding"
    />
    <DashboardHero
      v-else-if="orgMembershipsLoaded"
      :attention-count="attention?.total_count ?? 0"
      :loading="attentionLoading"
      data-tour="dashboard-hero"
    />

    <!-- 1b. Onboarding checklist — only renders for users who HAVE an
         org but haven't yet hit team_size>=1 + listings_count>=1. -->
    <OnboardingChecklist v-if="!hasNoOrg && orgMembershipsLoaded" />

    <!-- 1c. Profile completion nudge — visible when name OR avatar
         is missing on the caller's profile. Self-hides when complete. -->
    <ProfileCompletionPrompt />

    <!-- ============================================================
         2. NEEDS ATTENTION — full-width lede.
         The first thing the operator sees after the hero. Replaces
         the prior dashboard's chart-first layout.
    ============================================================== -->
    <NeedsAttentionPanel
      :data="(attention as any)"
      @loaded="(a: any) => (attention = a)"
    />

    <!-- 3. Personal scope — caller's tasks, inquiries, and next
         viewings. The operator's individual queue. MyUpcomingViewings
         self-hides when nothing's scheduled, so the row collapses to
         two columns on quiet days. -->
    <div class="grid gap-4 lg:grid-cols-2">
      <MyOpenTasks />
      <MyRecentInquiries />
    </div>
    <MyUpcomingViewings />

    <!-- 4. Pipeline — where deals are. Two-column structural pair. -->
    <div class="grid gap-4 lg:grid-cols-2">
      <InquiryFunnel />
      <MyDealsByStage />
    </div>

    <!-- 5. Inventory & pipeline alerts — full-width when present.
         Each widget self-hides when there's nothing to flag, so the
         dashboard stays calm on healthy days. -->
    <StaleListings />
    <PipelineAlertsWidget />

    <!-- 6. Activity feed — recent actions across the team. -->
    <ActivityFeed />

    <!-- 7. Performance strip — demoted to the bottom. Answers
         "is everything OK" without crowding the lede. -->
    <section class="space-y-3 border-t border-border pt-6">
      <div class="flex items-baseline justify-between gap-3">
        <p class="text-eyebrow">Performance · last 30 days</p>
      </div>
      <AnalyticsKpiStrip />
    </section>

    <DashboardFooter />
  </div>
</template>
