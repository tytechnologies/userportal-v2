<script setup lang="ts">
/**
 * /admin/operations — Operations & Health Dashboard.
 *
 * Centralized view of platform health: ingestion, webhooks, search /
 * MV refresh, cron jobs, rate limits, notifications. Reads
 * /api/admin/ops/{overview,alerts,metrics} — all admin-gated.
 *
 * Sections:
 *   1. Overview cards     — top-line numbers, drilldown links
 *   2. Alert feed         — derived from public.ops_alerts SQL view
 *   3. (Time-series chart — deferred to follow-up turn; stub below)
 *
 * Polling: overview refreshes every 30s; alert feed has its own
 * polling internally. KeepAlive keeps the dashboard mounted across
 * tab switches inside /admin so the polling timer survives.
 */
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { showToast } from '~/helpers/helpers'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import OpsOverviewCards from '~/components/admin/ops/OpsOverviewCards.vue'
import OpsAlertFeed from '~/components/admin/ops/OpsAlertFeed.vue'
import OpsTimeSeriesChart from '~/components/admin/ops/OpsTimeSeriesChart.vue'
import OpsStoragePanel from '~/components/admin/ops/OpsStoragePanel.vue'
import OpsDomainPanels from '~/components/admin/ops/OpsDomainPanels.vue'
import OpsAlertThresholds from '~/components/admin/ops/OpsAlertThresholds.vue'
import SchemaDriftPanel from '~/components/admin/ops/SchemaDriftPanel.vue'
import OpsCronJobsPanel from '~/components/admin/ops/OpsCronJobsPanel.vue'
import OpsRunbookPanel from '~/components/admin/ops/OpsRunbookPanel.vue'

definePageMeta({ layout: 'default' })
useHead({ title: 'Operations | Housinginteractive' })

const overview = ref<any | null>(null)
const overviewLoading = ref(true)
let overviewTimer: ReturnType<typeof setInterval> | null = null

async function loadOverview() {
  try {
    const data = await $fetch<any>('/api/admin/ops/overview')
    overview.value = data
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load overview',
      icon: 'error',
    })
  } finally {
    overviewLoading.value = false
  }
}

onMounted(async () => {
  await loadOverview()
  overviewTimer = setInterval(loadOverview, 30_000)
})

onBeforeUnmount(() => {
  if (overviewTimer) clearInterval(overviewTimer)
})
</script>

<template>
  <AdminPageShell permission="admin.access" max-width="7xl">
    <UiPageHeader
      title="Operations"
      description="Platform health at a glance. Drilldowns route to the existing admin tabs (Sources, Webhooks, Triage, Reconcile)."
      :back="{ label: 'Back to admin', to: '/admin' }"
    />

    <OpsOverviewCards :overview="overview" :loading="overviewLoading" />
    <OpsAlertFeed />
    <OpsDomainPanels />
    <OpsCronJobsPanel />
    <OpsRunbookPanel slug="eis-submitter-runbook" title="EIS submitter (BIR e-invoicing)" />
    <OpsTimeSeriesChart />
    <OpsStoragePanel />
    <OpsAlertThresholds />
    <SchemaDriftPanel />
  </AdminPageShell>
</template>
