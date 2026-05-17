<script setup lang="ts">
/**
 * Validation panel — runs the deterministic engine over the live
 * draft and groups output by severity.
 *
 * Reads:
 *   draft.doc_type_key                 → drives doc-type-specific rules
 *   draft.data._parties                → from PartiesEditor
 *   draft.data._signature_placeholders → from SignaturePlaceholdersPanel
 *   draft.data._title_number           → optional editor-supplied
 *   draft.data._lot_number             → optional editor-supplied
 *   draft.data._effective_date         → optional editor-supplied
 *   draft.data._commission_splits      → optional, for commission docs
 *   draft.data._attachments            → optional record
 *   draft.data._has_notarial_block     → set when an "ACKNOWLEDGMENT"
 *                                         marker is present in the body
 *
 * Engine output is purely advisory — no auto-fix. Brokers see the
 * issues, address them in the right panel (Parties/Signatures/etc.),
 * and the validator re-runs reactively.
 */
import { computed } from 'vue'
import {
  validateDocument,
  groupIssues,
  type Issue,
  type DocumentForValidation,
  type Party,
} from '~/utils/documentValidation'
import { readPlaceholders, type SignaturePlaceholder } from '~/utils/signaturePlaceholders'
import type { DocumentDraft } from '~/composables/useDocumentDrafts'
import UiBadge from '~/components/ui/UiBadge.vue'

const props = defineProps<{
  draft: DocumentDraft
}>()

// Adapter — pull the loose JSONB extras out of draft.data into the
// strict shape validateDocument expects.
const docForValidation = computed<DocumentForValidation>(() => {
  const data = (props.draft.data as Record<string, unknown> | null) ?? {}
  const placeholders: SignaturePlaceholder[] = readPlaceholders(data)
  const placeholderRoles = new Set(placeholders.map((p) => p.party_role))

  // Project signature presence onto the parties before validating.
  // PartiesEditor also writes these on save, but the projection here
  // gives us a live read without forcing a save first.
  const rawParties = Array.isArray((data as any)._parties)
    ? ((data as any)._parties as Party[])
    : []
  const parties: Party[] = rawParties.map((p) => ({
    ...p,
    has_signature: p.role ? placeholderRoles.has(p.role as any) : false,
    has_initials:  p.role ? placeholderRoles.has(p.role as any) : false,
  }))

  return {
    doc_type_key:        (props.draft.doc_type_key as string | null) ?? null,
    parties,
    title_number:        (data as any)._title_number ?? null,
    lot_number:          (data as any)._lot_number ?? null,
    effective_date:      (data as any)._effective_date ?? null,
    commission_splits:   (data as any)._commission_splits ?? undefined,
    attachments:         (data as any)._attachments ?? undefined,
    has_notarial_block:  Boolean((data as any)._has_notarial_block),
  }
})

const issues = computed<Issue[]>(() => validateDocument(docForValidation.value))
const grouped = computed(() => groupIssues(issues.value))
const blockedToShip = computed(() => grouped.value.error.length > 0)
// `parties` is declared optional on the input type, but the adapter
// always sets it to an array. Cache the length here so the template
// doesn't have to deal with the optional shape twice.
const partyCount = computed(() => docForValidation.value.parties?.length ?? 0)
</script>

<template>
  <section class="ui-card p-4">
    <header class="mb-3 flex items-baseline justify-between gap-2">
      <div>
        <h3 class="text-card-title">
          Validation
          <UiBadge
            v-if="grouped.error.length > 0"
            variant="destructive"
            size="xs"
            class="ml-1"
          >
            {{ grouped.error.length }} error{{ grouped.error.length === 1 ? '' : 's' }}
          </UiBadge>
          <UiBadge
            v-else-if="grouped.warning.length > 0"
            variant="warning"
            size="xs"
            class="ml-1"
          >
            {{ grouped.warning.length }} warning{{ grouped.warning.length === 1 ? '' : 's' }}
          </UiBadge>
          <UiBadge
            v-else-if="partyCount > 0"
            variant="success"
            size="xs"
            class="ml-1"
          >
            All checks pass
          </UiBadge>
        </h3>
        <p class="mt-0.5 text-meta">
          Deterministic checks. Errors block ship-ready status; warnings
          are reviewable. AI never overrides these.
        </p>
      </div>
    </header>

    <p
      v-if="!docForValidation.doc_type_key"
      class="mb-3 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-foreground"
    >
      Set a document type to enable type-specific rules (witnesses,
      notary, spouse consent).
    </p>

    <p
      v-if="partyCount === 0"
      class="rounded-md border border-dashed border-border bg-surface-2 px-3 py-3 text-xs text-muted-foreground"
    >
      Add structured parties to activate validation. Most rules need at
      least the buyer/seller (or lessor/lessee) declared.
    </p>

    <div v-else-if="issues.length === 0" class="rounded-md border border-success/30 bg-success/5 px-3 py-3 text-xs text-foreground">
      No validation issues found. Document looks ready for review.
    </div>

    <div v-else class="space-y-3">
      <!-- Errors -->
      <section v-if="grouped.error.length > 0">
        <p class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-destructive">
          Errors ({{ grouped.error.length }})
        </p>
        <ul class="space-y-1.5">
          <li
            v-for="(iss, idx) in grouped.error"
            :key="`err-${idx}`"
            class="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs"
          >
            <p class="font-medium text-foreground">{{ iss.message }}</p>
            <p class="mt-0.5 font-mono text-[10px] text-muted-foreground">
              {{ iss.code }} · {{ iss.path }}
            </p>
          </li>
        </ul>
      </section>

      <!-- Warnings -->
      <section v-if="grouped.warning.length > 0">
        <p class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-warning">
          Warnings ({{ grouped.warning.length }})
        </p>
        <ul class="space-y-1.5">
          <li
            v-for="(iss, idx) in grouped.warning"
            :key="`warn-${idx}`"
            class="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs"
          >
            <p class="font-medium text-foreground">{{ iss.message }}</p>
            <p class="mt-0.5 font-mono text-[10px] text-muted-foreground">
              {{ iss.code }} · {{ iss.path }}
            </p>
          </li>
        </ul>
      </section>

      <!-- Info -->
      <section v-if="grouped.info.length > 0">
        <p class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Heads up ({{ grouped.info.length }})
        </p>
        <ul class="space-y-1.5">
          <li
            v-for="(iss, idx) in grouped.info"
            :key="`info-${idx}`"
            class="rounded-md border border-border bg-surface-2 px-3 py-2 text-xs"
          >
            <p class="text-foreground">{{ iss.message }}</p>
            <p class="mt-0.5 font-mono text-[10px] text-muted-foreground">
              {{ iss.code }} · {{ iss.path }}
            </p>
          </li>
        </ul>
      </section>

      <p
        v-if="blockedToShip"
        class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
      >
        Errors above must be resolved before this document is ship-ready.
      </p>
    </div>
  </section>
</template>
