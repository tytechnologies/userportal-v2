<script setup lang="ts">
/**
 * One row in the deal workflow stepper. Three visual variants:
 *   - `completed`: collapsed summary. Click to expand for doc preview.
 *   - `active`:    full upload + attestation + advance affordance.
 *   - `locked`:    label only.
 *  `skipped` rows are filtered out by the parent and never rendered.
 */
import { ref, computed } from 'vue'
import { showToast } from '~/helpers/helpers'
import type { WorkflowStep } from '~~/server/repositories/workflows.repo'

const props = defineProps<{
  dealId: string
  step: WorkflowStep
}>()
const emit = defineEmits<{
  /** Emitted on successful advance — parent re-fetches workflow. */
  (e: 'advanced', payload: { nextStepId: string | null }): void
}>()

const file = ref<File | null>(null)
const uploadedDocId = ref<string | null>(null)
const attestChecked = ref(false)
const submitting = ref(false)
const expanded = ref(false)

const canAdvance = computed(
  () => props.step.status === 'active' && !!uploadedDocId.value && attestChecked.value,
)

async function onFileChange(e: Event) {
  const target = e.target as HTMLInputElement
  const picked = target.files?.[0]
  if (!picked) return
  file.value = picked
  uploadedDocId.value = null
  // Upload via the existing documents pipeline. document_type carries the
  // workflow step key so future analytics can filter cleanly.
  const fd = new FormData()
  fd.append('file', picked)
  fd.append('deal_id', props.dealId)
  fd.append('document_type', `workflow_step_${props.step.key}`)
  try {
    submitting.value = true
    const res = await $fetch<{ id: string }>('/api/documents/upload', {
      method: 'POST',
      body: fd,
    })
    uploadedDocId.value = res.id
    showToast({ title: 'File uploaded.', icon: 'success' })
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Upload failed',
      icon: 'error',
    })
  } finally {
    submitting.value = false
  }
}

async function advance() {
  if (!canAdvance.value || !uploadedDocId.value) return
  submitting.value = true
  try {
    const res = await $fetch<{ nextStepId: string | null }>(
      `/api/deals/${props.dealId}/workflow/advance`,
      {
        method: 'POST',
        body: {
          stepId: props.step.id,
          documentId: uploadedDocId.value,
          attestationSignature: props.step.attestation_text,
        },
      },
    )
    emit('advanced', { nextStepId: res.nextStepId })
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Could not save step',
      icon: 'error',
    })
  } finally {
    submitting.value = false
  }
}

const statusBadge = computed(() => {
  switch (props.step.status) {
    case 'completed': return { label: '✓', cls: 'bg-success/15 text-success' }
    case 'active':    return { label: '●', cls: 'bg-primary/15 text-primary' }
    case 'locked':    return { label: '🔒', cls: 'bg-muted text-muted-foreground' }
    default:          return { label: '·', cls: 'bg-muted text-muted-foreground' }
  }
})

function formatDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
</script>

<template>
  <div
    class="rounded-lg border border-border bg-card p-3"
    :class="step.status === 'active' ? 'ring-2 ring-primary/40' : ''"
  >
    <header class="flex items-center gap-2">
      <span class="inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold" :class="statusBadge.cls">
        {{ statusBadge.label }}
      </span>
      <span class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Step {{ step.step_index }}
      </span>
      <span class="text-sm font-semibold text-foreground">{{ step.title }}</span>
      <span v-if="step.status === 'completed' && step.completed_at" class="ml-auto text-xs text-muted-foreground">
        {{ formatDate(step.completed_at) }}
      </span>
      <button
        v-if="step.status === 'completed'"
        type="button"
        class="ml-auto text-xs text-muted-foreground hover:text-foreground"
        @click="expanded = !expanded"
      >
        {{ expanded ? 'Hide' : 'Details' }}
      </button>
    </header>

    <!-- Active step: upload + attest + advance -->
    <div v-if="step.status === 'active'" class="mt-3 space-y-3">
      <p v-if="step.description" class="text-sm text-foreground/80">{{ step.description }}</p>
      <div>
        <input
          type="file"
          accept="application/pdf,image/*"
          class="block w-full text-sm text-foreground"
          :disabled="submitting"
          @change="onFileChange"
        />
        <p v-if="uploadedDocId" class="mt-1 text-xs text-success">File uploaded — ready to attest.</p>
      </div>
      <label class="flex items-start gap-2 text-sm text-foreground">
        <input
          v-model="attestChecked"
          type="checkbox"
          class="mt-0.5"
          :disabled="!uploadedDocId || submitting"
        />
        <span>{{ step.attestation_text }}</span>
      </label>
      <button
        type="button"
        class="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
        :disabled="!canAdvance || submitting"
        @click="advance"
      >
        {{ submitting ? 'Saving…' : 'Save & continue' }}
      </button>
    </div>

    <!-- Completed step: show signature when expanded -->
    <div v-else-if="step.status === 'completed' && expanded" class="mt-3 space-y-1 text-xs text-muted-foreground">
      <p><strong>Attested:</strong> {{ step.attestation_signature }}</p>
      <p v-if="step.attested_at"><strong>When:</strong> {{ formatDate(step.attested_at) }}</p>
    </div>

    <!-- Locked: nothing else to show -->
  </div>
</template>
