<script setup lang="ts">
/**
 * Deal workflow stepper. Fetches workflow + steps from
 * GET /api/deals/:id/workflow and renders an ordered list of
 * DealWorkflowStepRow components, filtering out 'skipped' rows.
 * Subscribes to realtime updates on deal_workflows so an admin
 * abandon refreshes the panel without manual reload.
 */
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { showToast } from '~/helpers/helpers'
import DealWorkflowStepRow from '~/components/deals/DealWorkflowStepRow.vue'
import type { Workflow } from '~~/server/repositories/workflows.repo'

const props = defineProps<{
  dealId: string
  /** True iff the caller has admin/manager privileges to abandon. */
  canAbandon: boolean
}>()
const emit = defineEmits<{
  (e: 'workflow-changed'): void
}>()

const supabase = useSupabaseClient()
const workflow = ref<Workflow | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
let channel: any = null

async function load() {
  loading.value = true
  error.value = null
  try {
    workflow.value = await $fetch<Workflow | null>(`/api/deals/${props.dealId}/workflow`)
  } catch (err: any) {
    error.value = err?.statusMessage || err?.message || 'Failed to load workflow'
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await load()
  // Realtime: listen for workflow row changes so admin actions reflect live.
  channel = (supabase as any)
    .channel(`deal_workflow_${props.dealId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'deal_workflows', filter: `deal_id=eq.${props.dealId}` },
      () => { void load() },
    )
    .subscribe()
})

onUnmounted(() => {
  if (channel) (supabase as any).removeChannel(channel)
})

watch(() => props.dealId, async () => { await load() })

defineExpose({ refresh: load })

const visibleSteps = computed(() =>
  (workflow.value?.steps ?? []).filter((s) => s.status !== 'skipped'),
)
const completedCount = computed(() =>
  visibleSteps.value.filter((s) => s.status === 'completed').length,
)
const totalVisible = computed(() => visibleSteps.value.length)
const branchLabel = computed(() => {
  if (!workflow.value?.title_branch) return ''
  return workflow.value.title_branch === 'condo' ? 'Condo (CCT)' : 'House/Land (TCT)'
})

async function onAdvanced() {
  await load()
  emit('workflow-changed')
}

async function abandon() {
  if (!workflow.value) return
  const reason = window.prompt('Reason for abandoning this workflow?')
  if (!reason || !reason.trim()) return
  try {
    await $fetch(`/api/deals/${props.dealId}/workflow/abandon`, {
      method: 'POST',
      body: { workflowId: workflow.value.id, reason: reason.trim() },
    })
    showToast({ title: 'Workflow abandoned.', icon: 'success' })
    await load()
    emit('workflow-changed')
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Could not abandon',
      icon: 'error',
    })
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
</script>

<template>
  <section v-if="!loading && workflow" class="rounded-xl border border-border bg-background p-4">
    <header class="mb-4 flex items-baseline justify-between gap-2">
      <div>
        <h3 class="text-sm font-semibold text-foreground">Transfer document progress</h3>
        <p class="text-xs text-muted-foreground">
          <template v-if="workflow.status === 'completed'">All steps complete — {{ formatDate(workflow.completed_at) }}</template>
          <template v-else-if="workflow.status === 'abandoned'">
            Workflow abandoned · {{ workflow.abandon_reason }}
          </template>
          <template v-else>
            {{ completedCount }} / {{ totalVisible }} complete
            <span v-if="branchLabel"> · Branch: {{ branchLabel }}</span>
            · Started {{ formatDate(workflow.started_at) }}
          </template>
        </p>
      </div>
      <button
        v-if="canAbandon && workflow.status === 'active'"
        type="button"
        class="text-xs text-destructive hover:underline"
        @click="abandon"
      >
        Abandon
      </button>
    </header>

    <div class="space-y-2">
      <DealWorkflowStepRow
        v-for="step in visibleSteps"
        :key="step.id"
        :deal-id="dealId"
        :step="step"
        @advanced="onAdvanced"
      />
    </div>
  </section>
  <section v-else-if="loading" class="rounded-xl border border-border bg-background p-4">
    <div class="h-4 w-1/2 animate-pulse rounded bg-muted" />
  </section>
  <section v-else-if="error" class="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
    {{ error }}
  </section>
</template>
