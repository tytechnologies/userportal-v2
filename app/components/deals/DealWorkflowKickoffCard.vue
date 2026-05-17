<script setup lang="ts">
/**
 * Shown on /deals/:id when:
 *   - No deal_workflows row exists for this deal, AND
 *   - Either an envelope linked to this deal is in status='completed',
 *     OR the broker clicked the manual entry button.
 *
 * Resolves the right template (sale_transfer_v1 vs lease_v1) from the
 * deal's listing flags (for_sale / for_rent). For sale flows, prompts
 * the operator to pick condo vs land before starting.
 */
import { ref, computed } from 'vue'
import { showToast } from '~/helpers/helpers'

const props = defineProps<{
  dealId: string
  /** Listing flags — drive template selection. */
  listingForSale: boolean
  listingForRent: boolean
  /** Envelope id if auto-eligible; null for manual. */
  eligibleEnvelopeId: string | null
}>()
const emit = defineEmits<{
  (e: 'started'): void
}>()

const templateKey = computed<'sale_transfer_v1' | 'lease_v1' | null>(() => {
  if (props.listingForSale) return 'sale_transfer_v1'
  if (props.listingForRent) return 'lease_v1'
  return null
})

const isSale = computed(() => templateKey.value === 'sale_transfer_v1')
const titleBranch = ref<'condo' | 'land' | null>(null)
const submitting = ref(false)

const startedVia = computed<'envelope_auto' | 'manual'>(() =>
  props.eligibleEnvelopeId ? 'envelope_auto' : 'manual',
)

const canStart = computed(() => {
  if (!templateKey.value) return false
  if (isSale.value && !titleBranch.value) return false
  return true
})

async function start() {
  if (!canStart.value || !templateKey.value) return
  submitting.value = true
  try {
    await $fetch(`/api/deals/${props.dealId}/workflow/start`, {
      method: 'POST',
      body: {
        templateKey: templateKey.value,
        titleBranch: isSale.value ? titleBranch.value : null,
        startedVia: startedVia.value,
        envelopeId: props.eligibleEnvelopeId,
      },
    })
    showToast({ title: 'Transfer process started.', icon: 'success' })
    emit('started')
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Could not start workflow',
      icon: 'error',
    })
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <section
    v-if="templateKey"
    class="rounded-xl border-2 border-primary/40 bg-primary/5 p-5"
  >
    <h3 class="text-lg font-bold text-foreground">Contract signed!</h3>
    <p class="mt-1 text-sm text-foreground/80">
      <template v-if="isSale">
        Start the transfer-document workflow to track CGT, DST, the BIR-issued CAR,
        transfer tax, title transfer, and final tax declaration. Each step is
        gated by its predecessor.
      </template>
      <template v-else>
        Start the lease document checklist: signed lease, tenant ID, deposit + advance receipts.
      </template>
    </p>

    <fieldset v-if="isSale" class="mt-4 space-y-2">
      <legend class="text-sm font-semibold text-foreground">This deal is for a:</legend>
      <label class="flex items-center gap-2 text-sm">
        <input v-model="titleBranch" type="radio" value="condo" />
        Condo unit (CCT-based title transfer)
      </label>
      <label class="flex items-center gap-2 text-sm">
        <input v-model="titleBranch" type="radio" value="land" />
        House / Land (TCT-based title transfer)
      </label>
    </fieldset>

    <button
      type="button"
      class="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
      :disabled="!canStart || submitting"
      @click="start"
    >
      {{ submitting ? 'Starting…' : 'Start transfer process' }}
    </button>
  </section>
  <section v-else class="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
    The deal's listing has neither sale nor rent flagged — fix the listing before starting the
    transfer workflow.
  </section>
</template>
