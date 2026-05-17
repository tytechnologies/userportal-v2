<script setup lang="ts">
/**
 * Signature placeholders panel.
 *
 * Shows the list of signature blocks the broker has attached to the
 * draft, with an add/remove composer + a manual "Mark signed" button
 * per row. Vendor e-signing (Phase 3) will swap the manual stamp for
 * a real signing flow, but the placeholder schema stays the same.
 *
 * The panel writes back through PATCH /api/document-drafts/:id with
 * the merged data blob (preserving ai_body, ai_prompt, etc.).
 */
import { computed, onMounted, ref, watch } from 'vue'
import { showToast } from '~/helpers/helpers'
import UiBadge from '~/components/ui/UiBadge.vue'
import { useDocumentDrafts, type DocumentDraft } from '~/composables/useDocumentDrafts'
import {
  readPlaceholders,
  writePlaceholders,
  newPlaceholder,
  roleLabel,
  type SignaturePlaceholder,
} from '~/utils/signaturePlaceholders'
import EsignSendModal from '~/components/documents/EsignSendModal.vue'

const props = defineProps<{
  draft: DocumentDraft
}>()

const emit = defineEmits<{
  /** Parent re-loads the draft so other panels (validation, AI editor)
   *  see the new placeholders. */
  (e: 'updated', draft: DocumentDraft): void
}>()

const { saveDraft } = useDocumentDrafts()

// Local working copy so adds/removes feel instant. We persist on
// every change because losing a placeholder mid-edit would be
// confusing — it's not heavy data.
const placeholders = ref<SignaturePlaceholder[]>(readPlaceholders(props.draft.data))
watch(() => props.draft.id, () => {
  placeholders.value = readPlaceholders(props.draft.data)
})

const composerRole = ref<SignaturePlaceholder['party_role']>('seller')
const composerLabel = ref<string>('')
const saving = ref(false)

async function persist(next: SignaturePlaceholder[]) {
  saving.value = true
  try {
    const data = writePlaceholders(props.draft.data, next)
    const updated = await saveDraft(props.draft.id, { data })
    placeholders.value = readPlaceholders(updated.data)
    emit('updated', updated)
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Save failed',
      icon: 'error',
    })
  } finally {
    saving.value = false
  }
}

async function add() {
  const p = newPlaceholder({
    party_role: composerRole.value,
    label: composerLabel.value.trim() || undefined,
  })
  await persist([...placeholders.value, p])
  composerLabel.value = ''
}

async function remove(id: string) {
  await persist(placeholders.value.filter((p) => p.id !== id))
}

async function markSigned(p: SignaturePlaceholder) {
  const next = placeholders.value.map((x) =>
    x.id === p.id
      ? { ...x, signed_at: new Date().toISOString() }
      : x,
  )
  await persist(next)
  showToast({ title: `Marked "${p.label}" signed`, icon: 'success' })
}

async function clearSigned(p: SignaturePlaceholder) {
  const next = placeholders.value.map((x) =>
    x.id === p.id
      ? { ...x, signed_at: null, signed_by_user_id: null }
      : x,
  )
  await persist(next)
}

const allSigned = computed(
  () => placeholders.value.length > 0 && placeholders.value.every((p) => !!p.signed_at),
)

// eSign send modal state. Only enabled when there are placeholders
// to sign and at least one isn't already signed.
const esignOpen = ref(false)
const canSendForEsign = computed(
  () => placeholders.value.length > 0 && !allSigned.value,
)
function openEsign() {
  if (!canSendForEsign.value) return
  esignOpen.value = true
}
function onEsignSent() {
  showToast({
    title: 'Envelope sent. Status updates will appear in the eSign panel.',
    icon: 'success',
  })
}
</script>

<template>
  <section class="ui-card p-4">
    <header class="mb-3 flex items-baseline justify-between gap-2">
      <div>
        <h3 class="text-card-title">
          Signatures
          <UiBadge
            v-if="placeholders.length > 0"
            :variant="allSigned ? 'success' : 'warning'"
            size="xs"
            class="ml-1"
          >
            {{ placeholders.filter(p => p.signed_at).length }}/{{ placeholders.length }}
            signed
          </UiBadge>
        </h3>
        <p class="mt-0.5 text-meta">
          Tagged signature blocks. Send for e-signing through DocuSign,
          or stamp signed status manually after offline notarization.
        </p>
      </div>
      <button
        v-if="canSendForEsign"
        type="button"
        class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 focus-ring disabled:opacity-50"
        @click="openEsign"
      >
        Send for eSign
      </button>
    </header>

    <!-- Composer -->
    <form
      class="mb-3 flex flex-wrap items-center gap-2 border-b border-border pb-3"
      @submit.prevent="add"
    >
      <select
        v-model="composerRole"
        class="rounded-md border border-input bg-card px-2 py-1.5 text-xs"
      >
        <option value="seller">Seller</option>
        <option value="buyer">Buyer</option>
        <option value="lessor">Lessor</option>
        <option value="lessee">Lessee</option>
        <option value="principal">Principal</option>
        <option value="agent">Agent</option>
        <option value="broker">Broker</option>
        <option value="witness">Witness</option>
        <option value="notary">Notary</option>
        <option value="spouse_consenter">Spouse (consenter)</option>
        <option value="other">Other</option>
      </select>
      <input
        v-model="composerLabel"
        type="text"
        maxlength="80"
        :placeholder="`Label (default: ${roleLabel(composerRole)})`"
        class="min-w-[180px] flex-1 rounded-md border border-input bg-card px-3 py-1.5 text-xs focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
      />
      <button
        type="submit"
        class="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-ring disabled:opacity-50"
        :disabled="saving"
      >
        {{ saving ? 'Saving…' : '+ Add' }}
      </button>
    </form>

    <p
      v-if="placeholders.length === 0"
      class="rounded-md border border-dashed border-border bg-surface-2 px-3 py-3 text-xs text-muted-foreground"
    >
      No signature blocks yet. Add one per party who'll sign — at
      minimum the buyer/seller (and witnesses + notary if the doc
      type requires them).
    </p>

    <ul v-else class="space-y-1.5">
      <li
        v-for="p in placeholders"
        :key="p.id"
        class="flex flex-wrap items-baseline gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs"
      >
        <UiBadge variant="neutral" size="xs">{{ roleLabel(p.party_role) }}</UiBadge>
        <span class="font-semibold text-foreground">{{ p.label }}</span>
        <UiBadge
          v-if="p.signed_at"
          variant="success"
          size="xs"
        >
          Signed {{ new Date(p.signed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }}
        </UiBadge>
        <span class="ml-auto flex items-center gap-1.5">
          <button
            v-if="!p.signed_at"
            type="button"
            class="rounded-md bg-success px-2 py-0.5 text-[10px] font-semibold text-success-foreground hover:bg-success/90 focus-ring disabled:opacity-50"
            :disabled="saving"
            @click="markSigned(p)"
          >
            Mark signed
          </button>
          <button
            v-else
            type="button"
            class="rounded-md border border-border bg-card px-2 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent focus-ring disabled:opacity-50"
            :disabled="saving"
            @click="clearSigned(p)"
          >
            Unsign
          </button>
          <button
            type="button"
            class="rounded-md border border-destructive/30 bg-card px-2 py-0.5 text-[10px] font-medium text-destructive hover:bg-destructive/10 focus-ring disabled:opacity-50"
            :disabled="saving"
            @click="remove(p.id)"
          >
            Remove
          </button>
        </span>
      </li>
    </ul>

    <!-- DocuSign send modal — opens with one row pre-filled per
         placeholder. Routing order matches placeholder order. -->
    <EsignSendModal
      :open="esignOpen"
      :draft="draft"
      @update:open="esignOpen = $event"
      @sent="onEsignSent"
    />
  </section>
</template>
