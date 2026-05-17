<script setup lang="ts">
/**
 * Brokerage manager dashboard.
 *
 * Picks the user's highest-priority membership (brokerage_owner >
 * branch_manager > team_lead > ...) and renders the three rollups
 * from organization_pipeline_summary, branch_performance, and
 * broker_performance.
 *
 * Single endpoint (/api/organizations/:id/dashboard) so the page
 * paints atomically. Multi-org switcher is deferred — a later turn
 * adds a select widget when there's >1 active membership.
 *
 * Access gate: any active org member can view (RLS gates the
 * underlying views). The dashboard's primary audience is managers,
 * but agents seeing their org's aggregate isn't a leak.
 */
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from '~/helpers/helpers'
import TeamInvitations from '~/components/organization/TeamInvitations.vue'

type Membership = {
  id: string
  org_role: string
  status: string
  branch_id: string | null
  organization: {
    id: string
    name: string
    slug: string
    verified: boolean
    description: string | null
  }
}

type PipelineRow = {
  stage_key: string
  deal_count: number
  won_count: number
  lost_count: number
  gmv_won: number | null
}

type BranchRow = {
  branch_id: string
  branch_name: string
  agent_count: number | null
  active_deal_count: number | null
  deals_closed_30d: number | null
  gmv_30d: number | null
}

type BrokerRow = {
  user_id: string
  branch_id: string | null
  org_role: string
  active_deal_count: number | null
  deals_won_30d: number | null
  gmv_90d: number | null
  inquiries_received_30d: number | null
  inquiries_responded_30d: number | null
  profile: {
    id: string
    full_name: string | null
    avatar_url: string | null
  } | null
}

type DashboardPayload = {
  organization: {
    id: string
    name: string
    slug: string
    verified: boolean
    description: string | null
  }
  pipeline: {
    by_stage: PipelineRow[]
    totals: {
      deal_count: number
      won_count: number
      lost_count: number
      gmv_won: number
    }
  }
  branches: BranchRow[]
  brokers: BrokerRow[]
}

definePageMeta({ layout: 'default' })
useHead({ title: 'Organization | Housinginteractive' })

const router = useRouter()
const memberships = ref<Membership[]>([])
const activeOrgId = ref<string | null>(null)
const dashboard = ref<DashboardPayload | null>(null)
const loadingMemberships = ref(true)
const loadingDashboard = ref(false)

async function loadMemberships() {
  try {
    const res = await $fetch<{ memberships: Membership[] }>('/api/organizations')
    memberships.value = res.memberships ?? []
    if (memberships.value.length === 0) {
      showToast({
        title: "You aren't a member of any organization yet.",
        icon: 'info',
      })
      // No org to show — bounce back to dashboard.
      router.replace('/dashboard')
      return
    }
    activeOrgId.value = memberships.value[0]!.organization.id
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load organizations',
      icon: 'error',
    })
  } finally {
    loadingMemberships.value = false
  }
}

async function loadDashboard(orgId: string) {
  loadingDashboard.value = true
  try {
    const res = await $fetch<DashboardPayload>(`/api/organizations/${orgId}/dashboard`)
    dashboard.value = res
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load dashboard',
      icon: 'error',
    })
  } finally {
    loadingDashboard.value = false
  }
}

onMounted(async () => {
  await loadMemberships()
  if (activeOrgId.value) await loadDashboard(activeOrgId.value)
})

const activeMembership = computed(() =>
  memberships.value.find((m) => m.organization.id === activeOrgId.value) ?? null,
)

function fmtCurrency(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  const v = Number(n)
  if (v >= 1_000_000) return '₱' + (v / 1_000_000).toFixed(1) + 'M'
  if (v >= 1_000)     return '₱' + (v / 1_000).toFixed(1) + 'K'
  return '₱' + v.toFixed(0)
}
function fmtInt(n: number | null | undefined): string {
  if (n == null) return '—'
  return Number(n).toLocaleString()
}
function stageLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
function responseRate(b: BrokerRow): number | null {
  const recv = b.inquiries_received_30d ?? 0
  const resp = b.inquiries_responded_30d ?? 0
  if (recv === 0) return null
  return Math.round((resp / recv) * 100)
}
</script>

<template>
  <div class="px-4 py-6 sm:px-6 lg:px-8">
    <header class="mb-6">
      <h1 class="text-page-title">
        {{ dashboard?.organization?.name ?? 'Organization' }}
      </h1>
      <p v-if="activeMembership" class="text-xs text-muted-foreground">
        Your role: <span class="font-mono">{{ activeMembership.org_role }}</span>
        <span v-if="dashboard?.organization?.verified" class="ml-2 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">verified</span>
      </p>
    </header>

    <div
      v-if="loadingMemberships"
      class="rounded-xl border border-border bg-background p-5 text-center text-sm text-muted-foreground"
    >
      Loading organizations…
    </div>

    <div v-else-if="memberships.length === 0" class="rounded-xl border border-border bg-background p-6 text-sm text-muted-foreground">
      You aren't a member of any organization. Contact your brokerage owner or platform admin to be added.
    </div>

    <div v-else class="space-y-6">
      <!-- Pipeline overview -->
      <section class="rounded-xl border border-border bg-background p-4">
        <header class="mb-3">
          <h2 class="text-sm font-semibold text-foreground">Pipeline</h2>
          <p class="text-xs text-muted-foreground">
            Deals where any active member is the buyer agent.
          </p>
        </header>
        <div v-if="loadingDashboard" class="rounded-md border border-border bg-muted/50 p-4 text-xs text-muted-foreground">Loading…</div>
        <div v-else-if="dashboard" class="space-y-3">
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div class="rounded-md border border-border bg-muted/40 p-3">
              <p class="text-[10px] uppercase tracking-wide text-muted-foreground">Deals</p>
              <p class="text-lg font-semibold text-foreground">{{ fmtInt(dashboard.pipeline.totals.deal_count) }}</p>
            </div>
            <div class="rounded-md border border-success/30 bg-success/10 p-3">
              <p class="text-[10px] uppercase tracking-wide text-success">Won</p>
              <p class="text-lg font-semibold text-success">{{ fmtInt(dashboard.pipeline.totals.won_count) }}</p>
            </div>
            <div class="rounded-md border border-destructive/30 bg-destructive/10 p-3">
              <p class="text-[10px] uppercase tracking-wide text-destructive">Lost</p>
              <p class="text-lg font-semibold text-destructive">{{ fmtInt(dashboard.pipeline.totals.lost_count) }}</p>
            </div>
            <div class="rounded-md border border-primary/30 bg-primary/10 p-3">
              <p class="text-[10px] uppercase tracking-wide text-primary">GMV won</p>
              <p class="text-lg font-semibold text-primary">{{ fmtCurrency(dashboard.pipeline.totals.gmv_won) }}</p>
            </div>
          </div>

          <div v-if="dashboard.pipeline.by_stage.length > 0" class="overflow-x-auto">
            <table class="w-full text-left text-xs">
              <thead class="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th class="py-1 pr-2 font-semibold">Stage</th>
                  <th class="py-1 pr-2 font-semibold">Deals</th>
                  <th class="py-1 pr-2 font-semibold">Won</th>
                  <th class="py-1 pr-2 font-semibold">Lost</th>
                  <th class="py-1 font-semibold">GMV won</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-border">
                <tr v-for="row in dashboard.pipeline.by_stage" :key="row.stage_key">
                  <td class="py-1.5 pr-2 font-medium">{{ stageLabel(row.stage_key) }}</td>
                  <td class="py-1.5 pr-2">{{ fmtInt(row.deal_count) }}</td>
                  <td class="py-1.5 pr-2 text-success">{{ fmtInt(row.won_count) }}</td>
                  <td class="py-1.5 pr-2 text-destructive">{{ fmtInt(row.lost_count) }}</td>
                  <td class="py-1.5">{{ fmtCurrency(row.gmv_won) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <!-- Branches -->
      <section v-if="dashboard && dashboard.branches.length > 0" class="rounded-xl border border-border bg-background p-4">
        <header class="mb-3">
          <h2 class="text-sm font-semibold text-foreground">Branches</h2>
          <p class="text-xs text-muted-foreground">Per-office headcount and 30-day activity.</p>
        </header>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs">
            <thead class="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th class="py-1 pr-2 font-semibold">Branch</th>
                <th class="py-1 pr-2 font-semibold">Agents</th>
                <th class="py-1 pr-2 font-semibold">Active deals</th>
                <th class="py-1 pr-2 font-semibold">Closed 30d</th>
                <th class="py-1 font-semibold">GMV 30d</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              <tr v-for="b in dashboard.branches" :key="b.branch_id">
                <td class="py-1.5 pr-2 font-medium">{{ b.branch_name }}</td>
                <td class="py-1.5 pr-2">{{ fmtInt(b.agent_count) }}</td>
                <td class="py-1.5 pr-2">{{ fmtInt(b.active_deal_count) }}</td>
                <td class="py-1.5 pr-2 text-success">{{ fmtInt(b.deals_closed_30d) }}</td>
                <td class="py-1.5">{{ fmtCurrency(b.gmv_30d) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Team & invitations — visible to brokerage_owner / branch_manager
           via the component's own canManage gate. Renders nothing for
           agents (so the page stays read-only for them). -->
      <TeamInvitations
        v-if="activeOrgId"
        :organization-id="activeOrgId"
        :caller-org-role="activeMembership?.org_role ?? null"
      />

      <!-- Broker leaderboard -->
      <section v-if="dashboard && dashboard.brokers.length > 0" class="rounded-xl border border-border bg-background p-4">
        <header class="mb-3">
          <h2 class="text-sm font-semibold text-foreground">Brokers</h2>
          <p class="text-xs text-muted-foreground">
            Sorted by 30-day wins. Response rate = inquiries responded ÷ received.
          </p>
        </header>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs">
            <thead class="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th class="py-1 pr-2 font-semibold">Broker</th>
                <th class="py-1 pr-2 font-semibold">Role</th>
                <th class="py-1 pr-2 font-semibold">Active</th>
                <th class="py-1 pr-2 font-semibold">Won 30d</th>
                <th class="py-1 pr-2 font-semibold">GMV 90d</th>
                <th class="py-1 font-semibold">Resp 30d</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              <tr v-for="b in dashboard.brokers" :key="b.user_id">
                <td class="py-1.5 pr-2">
                  <div class="flex items-center gap-2">
                    <img
                      v-if="b.profile?.avatar_url"
                      :src="b.profile.avatar_url"
                      class="h-6 w-6 rounded-full object-cover"
                      alt=""
                    />
                    <div
                      v-else
                      class="h-6 w-6 rounded-full bg-muted text-[10px] font-semibold text-muted-foreground flex items-center justify-center"
                    >
                      {{ (b.profile?.full_name || '?').charAt(0).toUpperCase() }}
                    </div>
                    <span class="font-medium">{{ b.profile?.full_name || '—' }}</span>
                  </div>
                </td>
                <td class="py-1.5 pr-2 font-mono text-[11px] text-muted-foreground">{{ b.org_role }}</td>
                <td class="py-1.5 pr-2">{{ fmtInt(b.active_deal_count) }}</td>
                <td class="py-1.5 pr-2 text-success">{{ fmtInt(b.deals_won_30d) }}</td>
                <td class="py-1.5 pr-2">{{ fmtCurrency(b.gmv_90d) }}</td>
                <td class="py-1.5">
                  <span v-if="responseRate(b) != null" :class="(responseRate(b) ?? 0) < 50 ? 'text-warning font-semibold' : 'text-foreground'">
                    {{ responseRate(b) }}%
                  </span>
                  <span v-else class="text-muted-foreground/70">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Empty state if dashboard loaded but no activity -->
      <div
        v-if="dashboard && dashboard.brokers.length === 0 && dashboard.branches.length === 0 && dashboard.pipeline.totals.deal_count === 0"
        class="rounded-xl border border-dashed border-border bg-muted/50 p-6 text-center text-sm text-muted-foreground"
      >
        This organization has no activity yet. As deals, inquiries, and members are added, the dashboard will populate.
      </div>
    </div>
  </div>
</template>
