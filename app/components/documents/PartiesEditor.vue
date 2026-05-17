<script setup lang="ts">
/**
 * Structured-parties editor.
 *
 * Persists into draft.data._parties — a JSONB array of Party records
 * shaped exactly like documentValidation.ts expects, so the validation
 * panel can run all 14 rules without an adapter layer.
 *
 * Why this is its own surface separate from DocumentEditor's template
 * field overlay: template-driven drafts already capture parties as
 * field values; AI-generated and freeform drafts don't, but they
 * still need structured parties for validation + signature placement.
 * This panel is the universal entry point — it works on any draft
 * regardless of editor branch.
 *
 * The signature-presence flags (`has_signature`, `has_initials`) are
 * auto-derived from data._signature_placeholders so brokers don't
 * have to maintain two lists. The validator reads what's flagged
 * here; signing actually happens through SignaturePlaceholdersPanel.
 */
import { computed, ref, watch } from 'vue'
import { showToast } from '~/helpers/helpers'
import { useDocumentDrafts, type DocumentDraft } from '~/composables/useDocumentDrafts'
import type { Party, PartyRole } from '~/utils/documentValidation'
import {
  readPlaceholders,
  type SignaturePlaceholder,
} from '~/utils/signaturePlaceholders'
import UiBadge from '~/components/ui/UiBadge.vue'

const props = defineProps<{
  draft: DocumentDraft
}>()

const emit = defineEmits<{
  /** Parent re-loads the draft so the validation panel sees the
   *  updated _parties. */
  (e: 'updated', draft: DocumentDraft): void
}>()

const { saveDraft } = useDocumentDrafts()

// Local working copy. Saves on every Apply; we don't auto-save on
// every keystroke because validating partially-typed parties would
// flood the validation panel with noise.
function readParties(d: DocumentDraft): Party[] {
  const data = (d.data as Record<string, unknown> | null) ?? {}
  const raw = (data._parties as unknown) ?? null
  return Array.isArray(raw) ? (raw as Party[]) : []
}

const parties = ref<Party[]>(readParties(props.draft))
watch(() => props.draft.id, () => { parties.value = readParties(props.draft) })

const dirty = ref(false)
function markDirty() { dirty.value = true }

const composer = ref<Party>({
  full_name: '',
  role: 'buyer',
  tin: '',
  address: '',
  is_married: false,
  spouse_consented: false,
})
const saving = ref(false)

function addParty() {
  if (!composer.value.full_name?.trim()) {
    showToast({ title: 'Full name required', icon: 'error' })
    return
  }
  parties.value = [...parties.value, { ...composer.value, full_name: composer.value.full_name!.trim() }]
  composer.value = {
    full_name: '',
    role: 'buyer',
    tin: '',
    address: '',
    is_married: false,
    spouse_consented: false,
  }
  dirty.value = true
}

function removeParty(idx: number) {
  parties.value = parties.value.filter((_, i) => i !== idx)
  dirty.value = true
}

async function apply() {
  if (saving.value || !dirty.value) return
  saving.value = true
  try {
    // Auto-derive has_signature / has_initials per role from the
    // signature placeholders. Brokers shouldn't need to maintain two
    // lists in lockstep — placeholders are the source of truth.
    const placeholders: SignaturePlaceholder[] = readPlaceholders(props.draft.data)
    const sigByRole = new Map<string, SignaturePlaceholder>()
    for (const p of placeholders) sigByRole.set(p.party_role, p)
    const partiesWithSig: Party[] = parties.value.map((p) => {
      const sig = p.role ? sigByRole.get(p.role) : null
      return {
        ...p,
        has_signature: !!sig,
        has_initials:  !!sig,
      }
    })

    const data = {
      ...((props.draft.data as Record<string, unknown> | null) ?? {}),
      _parties: partiesWithSig,
    }
    const updated = await saveDraft(props.draft.id, { data })
    parties.value = readParties(updated)
    dirty.value = false
    emit('updated', updated)
    showToast({ title: 'Parties saved', icon: 'success' })
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Save failed',
      icon: 'error',
    })
  } finally {
    saving.value = false
  }
}

const ROLES: Array<{ value: PartyRole; label: string }> = [
  { value: 'seller',           label: 'Seller' },
  { value: 'buyer',            label: 'Buyer' },
  { value: 'lessor',           label: 'Lessor' },
  { value: 'lessee',           label: 'Lessee' },
  { value: 'principal',        label: 'Principal' },
  { value: 'agent',            label: 'Agent' },
  { value: 'broker',           label: 'Broker' },
  { value: 'witness',          label: 'Witness' },
  { value: 'notary',           label: 'Notary' },
  { value: 'spouse_consenter', label: 'Spouse (consenter)' },
  { value: 'other',            label: 'Other' },
]

function roleLabel(r: PartyRole | null | undefined): string {
  return ROLES.find((x) => x.value === r)?.label ?? String(r || 'unknown')
}

const showsSpouseFields = (role: PartyRole | null | undefined) =>
  role === 'seller' || role === 'principal' || role === 'lessor'
</script>

<template>
  <section class="ui-card p-4">
    <header class="mb-3 flex items-baseline justify-between gap-2">
      <div>
        <h3 class="text-card-title">
          Parties
          <UiBadge
            v-if="parties.length > 0"
            variant="neutral"
            size="xs"
            class="ml-1"
          >
            {{ parties.length }}
          </UiBadge>
        </h3>
        <p class="mt-0.5 text-meta">
          Structured parties feed the validation panel. Add the
          buyer/seller/witnesses/notary at minimum — addresses + TINs
          unlock more checks.
        </p>
      </div>
      <button
        v-if="dirty"
        type="button"
        class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 focus-ring disabled:opacity-50"
        :disabled="saving"
        @click="apply"
      >
        {{ saving ? 'Saving…' : 'Apply changes' }}
      </button>
    </header>

    <!-- Composer -->
    <form
      class="mb-3 grid gap-2 border-b border-border pb-3 sm:grid-cols-[120px_1fr_auto]"
      @submit.prevent="addParty"
    >
      <select
        v-model="composer.role"
        class="rounded-md border border-input bg-card px-2 py-1.5 text-xs"
        @change="markDirty"
      >
        <option v-for="r in ROLES" :key="r.value" :value="r.value">{{ r.label }}</option>
      </select>
      <input
        v-model="composer.full_name"
        type="text"
        maxlength="200"
        placeholder="Full legal name"
        class="rounded-md border border-input bg-card px-3 py-1.5 text-xs focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
      />
      <button
        type="submit"
        class="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-ring"
      >
        + Add
      </button>
      <input
        v-model="composer.tin"
        type="text"
        maxlength="20"
        placeholder="TIN (e.g. 123-456-789-000)"
        class="rounded-md border border-input bg-card px-3 py-1.5 font-mono text-xs focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25 sm:col-span-1"
      />
      <input
        v-model="composer.address"
        type="text"
        maxlength="500"
        placeholder="Address (street, barangay, city)"
        class="rounded-md border border-input bg-card px-3 py-1.5 text-xs focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25 sm:col-span-2"
      />
    </form>

    <!-- Existing parties -->
    <p
      v-if="parties.length === 0"
      class="rounded-md border border-dashed border-border bg-surface-2 px-3 py-3 text-xs text-muted-foreground"
    >
      No parties yet. Add the buyer + seller (or lessor + lessee) to
      activate validation.
    </p>

    <ul v-else class="space-y-2">
      <li
        v-for="(p, idx) in parties"
        :key="idx"
        class="rounded-md border border-border bg-card p-3 text-xs"
      >
        <div class="flex flex-wrap items-baseline gap-2">
          <UiBadge variant="neutral" size="xs">{{ roleLabel(p.role) }}</UiBadge>
          <span class="font-semibold text-foreground">
            {{ p.full_name || 'unnamed' }}
          </span>
          <span v-if="p.tin" class="font-mono text-[11px] text-muted-foreground">{{ p.tin }}</span>
          <button
            type="button"
            class="ml-auto rounded-md border border-destructive/30 bg-card px-2 py-0.5 text-[10px] font-medium text-destructive hover:bg-destructive/10 focus-ring"
            @click="removeParty(idx)"
          >
            Remove
          </button>
        </div>
        <p v-if="p.address" class="mt-1 text-muted-foreground">{{ p.address }}</p>

        <!-- Inline editors so brokers don't need a modal for tweaks -->
        <div class="mt-2 grid gap-2 sm:grid-cols-2">
          <input
            v-model="p.tin"
            type="text"
            maxlength="20"
            placeholder="TIN"
            class="rounded-md border border-input bg-card px-2 py-1 font-mono text-[11px] focus:outline-none focus:border-primary focus:ring-1 focus:ring-ring/25"
            @input="markDirty"
          />
          <input
            v-model="p.address"
            type="text"
            maxlength="500"
            placeholder="Address"
            class="rounded-md border border-input bg-card px-2 py-1 text-[11px] focus:outline-none focus:border-primary focus:ring-1 focus:ring-ring/25"
            @input="markDirty"
          />
        </div>

        <!-- Marriage / spouse-consent checkboxes — shown only for
             roles where the validator might require spouse consent
             on certain doc types (Deed of Sale, SPA). -->
        <label
          v-if="showsSpouseFields(p.role)"
          class="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground"
        >
          <span class="flex items-center gap-1">
            <input
              v-model="p.is_married"
              type="checkbox"
              class="h-3.5 w-3.5 cursor-pointer accent-primary focus-ring"
              @change="markDirty"
            />
            Married
          </span>
          <span v-if="p.is_married" class="flex items-center gap-1">
            <input
              v-model="p.spouse_consented"
              type="checkbox"
              class="h-3.5 w-3.5 cursor-pointer accent-primary focus-ring"
              @change="markDirty"
            />
            Spouse has consented
          </span>
        </label>
      </li>
    </ul>
  </section>
</template>
