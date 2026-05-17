<script setup lang="ts">
// Modal wrapper for SignatureCanvas. Uploads the captured PNG to S3
// via uploadSignature, then emits the resulting signed URL so the
// parent (DocumentEditor) can stash it in formData[fieldKey] and
// render the saved signature on the canvas.

import { ref } from 'vue'
import { useDocumentDrafts } from '~/composables/useDocumentDrafts'
import SignatureCanvas from './SignatureCanvas.vue'
import { showToast } from '~/helpers/helpers'

const props = defineProps<{
  draftId: string
  fieldKey: string
  fieldLabel: string
  open: boolean
}>()

const emit = defineEmits<{
  (e: 'update:open', open: boolean): void
  (e: 'saved', payload: { url: string; path: string; field_key: string }): void
}>()

const { uploadSignature } = useDocumentDrafts()

const canvasRef = ref<InstanceType<typeof SignatureCanvas> | null>(null)
const isSaving = ref(false)

function close() {
  if (isSaving.value) return
  emit('update:open', false)
}

async function save() {
  const canvas = canvasRef.value
  if (!canvas) return
  if (canvas.isEmpty()) {
    showToast({ title: 'Please sign before saving.', icon: 'warning' })
    return
  }
  if (!props.draftId) {
    showToast({ title: 'Save the draft first, then add signatures.', icon: 'warning' })
    return
  }
  isSaving.value = true
  try {
    const dataUrl = canvas.toDataUrl()
    const result = await uploadSignature(props.draftId, props.fieldKey, dataUrl)
    emit('saved', result)
    emit('update:open', false)
    showToast({ title: 'Signature saved.', icon: 'success' })
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Could not save signature.',
      icon: 'error',
    })
  } finally {
    isSaving.value = false
  }
}

function clearCanvas() {
  canvasRef.value?.clear()
}
</script>

<template>
  <UiModal
    :open="open"
    :title="`Sign ${fieldLabel}`"
    width="lg"
    :persistent="isSaving"
    @update:open="(v) => { if (!v) close() }"
  >
    <SignatureCanvas ref="canvasRef" :width="600" :height="200" />
    <template #footer>
      <div class="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          class="btn-secondary"
          :disabled="isSaving"
          @click="clearCanvas"
        >
          Clear
        </button>
        <button
          type="button"
          class="btn-primary disabled:opacity-60"
          :disabled="isSaving"
          @click="save"
        >
          <span v-if="isSaving">Saving…</span>
          <span v-else>Save signature</span>
        </button>
      </div>
    </template>
  </UiModal>
</template>
