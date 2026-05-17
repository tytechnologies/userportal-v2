<script setup lang="ts">
/**
 * /admin/inspections/:id — full inspection detail.
 *
 * Surfaces the state machine + per-finding editor + footer actions
 * (Complete / Cancel / Charge damages). Shipped 2026-05-08 alongside
 * migration 20260508000007. The lease-detail Inspections section
 * links here.
 */

import { ref, computed, reactive, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { hasPermission } from '~/composables/useAuth'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })
useHead({ title: 'Inspection | Admin' })

type InspectionKind =
  | 'move_in'
  | 'move_out'
  | 'mid_tenancy'
  | 'maintenance'
  | 'annual'
type InspectionStatus =
  | 'scheduled'
  | 'in_progress'
  | 'completed'
  | 'tenant_signed'
  | 'cancelled'
type FindingCondition =
  | 'excellent'
  | 'good'
  | 'fair'
  | 'damaged'
  | 'requires_repair'
  | 'requires_replacement'
  | 'missing'

type Inspection = {
  id: string
  inspection_no: string
  unit_id: string
  lease_id: string | null
  inspection_kind: InspectionKind
  status: InspectionStatus
  inspector_user_id: string | null
  inspector_external_name: string | null
  scheduled_at: string | null
  conducted_at: string | null
  tenant_party_id: string | null
  tenant_signed_at: string | null
  tenant_signature: Record<string, unknown> | null
  overall_condition: 'excellent' | 'good' | 'fair' | 'poor' | 'unhabitable' | null
  total_damage_estimate_minor: number
  summary_notes: string | null
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

type Photo = { url?: string; key?: string; name?: string; display_url?: string }

type Finding = {
  id: string
  inspection_id: string
  area: string
  item: string
  condition: FindingCondition
  description: string | null
  is_damage: boolean
  estimated_cost_minor: number | null
  baseline_finding_id: string | null
  damage_charge_id: string | null
  photos: Photo[]
  metadata: Record<string, unknown>
  created_at: string
  // Resolved by the GET endpoint when this finding is a move_out
  // observation paired with a move_in baseline. Rendered side-by-side
  // in the comparison section below.
  baseline?: BaselineFinding | null
}

type BaselineFinding = {
  id: string
  inspection_id: string
  area: string
  item: string
  condition: FindingCondition
  description: string | null
  photos: Photo[]
}

const route = useRoute()
const router = useRouter()
const id = computed(() => String(route.params.id ?? ''))

const isChecking = ref(true)
const allowed = ref(false)

const inspection = ref<Inspection | null>(null)
const findings = ref<Finding[]>([])
const loading = ref(true)

// Action busy flags.
const acting = ref<'complete' | 'cancel' | 'charge' | null>(null)

// Add-finding modal.
const addFindingModal = ref(false)
const addingFinding = ref(false)
const addForm = reactive({
  area: 'kitchen',
  item: 'walls',
  condition: 'good' as FindingCondition,
  description: '',
  is_damage: false,
  estimated_cost_minor: 0,
  photo_urls: '',
})
// Files queued from the file picker — uploaded to S3 right after the
// finding row is created (we need the finding.id for the path).
const pendingFiles = ref<File[]>([])
const uploadProgress = ref<string>('')

// Edit-finding inline state. We keep a draft per finding id so
// multiple findings could in principle be edited at once; in practice
// only one is open at a time.
const editingFindingId = ref<string | null>(null)
const editForm = reactive({
  area: '',
  item: '',
  condition: 'good' as FindingCondition,
  description: '',
  is_damage: false,
  estimated_cost_minor: 0,
  // Photos retained from the existing set (operator may have removed
  // some). New files queued for upload land in editPendingFiles.
  retainedPhotos: [] as Photo[],
  editPendingFiles: [] as File[],
})
const savingFinding = ref(false)
const editUploadProgress = ref<string>('')

// Cancel-inspection modal.
const cancelModal = ref(false)
const cancelReason = ref('')

// Edit-inspection-meta modal.
const metaModal = ref(false)
const metaForm = reactive({
  scheduled_at: '',
  inspector_external_name: '',
  summary_notes: '',
})
const savingMeta = ref(false)

const canEditFindings = computed(
  () => inspection.value?.status === 'scheduled' || inspection.value?.status === 'in_progress',
)
const canComplete = computed(() => canEditFindings.value && findings.value.length > 0)
const canCancel = computed(
  () =>
    inspection.value &&
    !['cancelled', 'tenant_signed'].includes(inspection.value.status),
)
const canChargeDamages = computed(
  () =>
    inspection.value &&
    ['completed', 'tenant_signed'].includes(inspection.value.status) &&
    inspection.value.lease_id != null &&
    findings.value.some((f) => f.is_damage && !f.damage_charge_id),
)

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ inspection: Inspection; findings: Finding[] }>(
      `/api/inspections/${id.value}`,
    )
    inspection.value = res.inspection
    findings.value = res.findings ?? []
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Could not load inspection',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}

function openAddFinding() {
  addForm.area = 'kitchen'
  addForm.item = 'walls'
  addForm.condition = 'good'
  addForm.description = ''
  addForm.is_damage = false
  addForm.estimated_cost_minor = 0
  addForm.photo_urls = ''
  pendingFiles.value = []
  uploadProgress.value = ''
  addFindingModal.value = true
}

function onFilePick(e: Event) {
  const input = e.target as HTMLInputElement
  if (!input.files) return
  const next = [...pendingFiles.value]
  for (const f of Array.from(input.files)) {
    if (next.length >= 12) break
    if (f.size > 20 * 1024 * 1024) {
      showToast({ title: `${f.name} exceeds 20 MB — skipped`, icon: 'warning' })
      continue
    }
    if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(f.type)) {
      showToast({ title: `${f.name} is not a supported image — skipped`, icon: 'warning' })
      continue
    }
    next.push(f)
  }
  pendingFiles.value = next
  // Reset the input so the same file can be re-picked if the user removes it.
  input.value = ''
}

function removePendingFile(idx: number) {
  pendingFiles.value = pendingFiles.value.filter((_, i) => i !== idx)
}

async function uploadInspectionPhoto(
  inspectionId: string,
  findingId: string,
  file: File,
): Promise<{ key: string; name: string }> {
  const presign = await $fetch<{
    key: string
    upload_url: string
    content_type: string
  }>(`/api/inspections/${inspectionId}/findings/${findingId}/photo-upload-url`, {
    method: 'POST',
    body: {
      content_type: file.type || 'image/jpeg',
      byte_length: file.size,
      filename: file.name,
    },
  })
  const putRes = await fetch(presign.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': presign.content_type },
    body: file,
  })
  if (!putRes.ok) {
    throw new Error(`S3 PUT failed: ${putRes.status} ${await putRes.text().catch(() => '')}`)
  }
  return { key: presign.key, name: file.name }
}

function parsePhotoList(raw: string): Array<{ url: string }> {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((url) => ({ url }))
}

async function addFinding() {
  if (!addForm.area.trim() || !addForm.item.trim()) {
    showToast({ title: 'Area and item are required', icon: 'warning' })
    return
  }
  if (addForm.is_damage && (!addForm.estimated_cost_minor || addForm.estimated_cost_minor <= 0)) {
    showToast({
      title: 'Damage findings require an estimated cost > 0',
      icon: 'warning',
    })
    return
  }
  addingFinding.value = true
  uploadProgress.value = ''
  try {
    // 1. Parse hand-pasted URLs (legacy / external photos).
    const urlPhotos = parsePhotoList(addForm.photo_urls)

    // 2. Create the finding without S3 photos first — we need its
    //    id to key the upload paths under. URL-shaped photos go in
    //    on this initial POST.
    const payload: Record<string, unknown> = {
      area: addForm.area.trim(),
      item: addForm.item.trim(),
      condition: addForm.condition,
      description: addForm.description.trim() || null,
      is_damage: addForm.is_damage,
    }
    if (addForm.is_damage) payload.estimated_cost_minor = addForm.estimated_cost_minor
    if (urlPhotos.length > 0) payload.photos = urlPhotos

    const created = await $fetch<{ finding: Finding }>(
      `/api/inspections/${id.value}/findings`,
      { method: 'POST', body: payload },
    )

    // 3. If the user picked files, upload each in turn and PATCH the
    //    finding with the union (URL photos + uploaded keys). Done
    //    sequentially to keep the progress message simple; small N
    //    typically (â‰¤12 capped at the input).
    if (pendingFiles.value.length > 0) {
      const uploaded: Array<{ key: string; name: string }> = []
      for (let i = 0; i < pendingFiles.value.length; i++) {
        const f = pendingFiles.value[i]!
        uploadProgress.value = `Uploading photo ${i + 1} of ${pendingFiles.value.length}…`
        try {
          uploaded.push(await uploadInspectionPhoto(id.value, created.finding.id, f))
        } catch (err: any) {
          showToast({
            title: `Photo ${f.name} upload failed: ${err?.message ?? 'unknown'}`,
            icon: 'error',
          })
        }
      }
      if (uploaded.length > 0) {
        await $fetch(
          `/api/inspections/${id.value}/findings/${created.finding.id}`,
          {
            method: 'PATCH',
            body: { photos: [...urlPhotos, ...uploaded] },
          },
        )
      }
    }

    showToast({ title: 'Finding added' })
    addFindingModal.value = false
    pendingFiles.value = []
    uploadProgress.value = ''
    await load()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not add finding', icon: 'error' })
  } finally {
    addingFinding.value = false
  }
}

function startEditFinding(f: Finding) {
  editingFindingId.value = f.id
  editForm.area = f.area
  editForm.item = f.item
  editForm.condition = f.condition
  editForm.description = f.description ?? ''
  editForm.is_damage = f.is_damage
  editForm.estimated_cost_minor = f.estimated_cost_minor ?? 0
  // Strip enrichment fields (display_url) before sending back — server
  // stores only {url? | key? | name?}. Shallow copy so toggling remove
  // doesn't mutate the read-mode photos until Save.
  editForm.retainedPhotos = (f.photos ?? []).map((p) => ({
    url: p.url,
    key: p.key,
    name: p.name,
  }))
  editForm.editPendingFiles = []
  editUploadProgress.value = ''
}

function removeRetainedPhoto(idx: number) {
  editForm.retainedPhotos = editForm.retainedPhotos.filter((_, i) => i !== idx)
}

function onEditFilePick(e: Event) {
  const input = e.target as HTMLInputElement
  if (!input.files) return
  const next = [...editForm.editPendingFiles]
  const totalCap = 12 - editForm.retainedPhotos.length
  for (const f of Array.from(input.files)) {
    if (next.length >= totalCap) {
      showToast({ title: '12 photos max per finding', icon: 'warning' })
      break
    }
    if (f.size > 20 * 1024 * 1024) {
      showToast({ title: `${f.name} exceeds 20 MB — skipped`, icon: 'warning' })
      continue
    }
    if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(f.type)) {
      showToast({ title: `${f.name} is not a supported image — skipped`, icon: 'warning' })
      continue
    }
    next.push(f)
  }
  editForm.editPendingFiles = next
  input.value = ''
}

function removeEditPendingFile(idx: number) {
  editForm.editPendingFiles = editForm.editPendingFiles.filter((_, i) => i !== idx)
}

async function saveFinding() {
  if (!editingFindingId.value) return
  if (editForm.is_damage && (!editForm.estimated_cost_minor || editForm.estimated_cost_minor <= 0)) {
    showToast({
      title: 'Damage findings require an estimated cost > 0',
      icon: 'warning',
    })
    return
  }
  savingFinding.value = true
  editUploadProgress.value = ''
  try {
    // Upload any newly-picked files first; failures toast individually
    // but the save still proceeds with whatever uploaded successfully.
    const uploaded: Array<{ key: string; name: string }> = []
    for (let i = 0; i < editForm.editPendingFiles.length; i++) {
      const f = editForm.editPendingFiles[i]!
      editUploadProgress.value = `Uploading photo ${i + 1} of ${editForm.editPendingFiles.length}…`
      try {
        uploaded.push(
          await uploadInspectionPhoto(id.value, editingFindingId.value, f),
        )
      } catch (err: any) {
        showToast({
          title: `Photo ${f.name} upload failed: ${err?.message ?? 'unknown'}`,
          icon: 'error',
        })
      }
    }

    // Strip server-only enrichment fields from retained photos (the
    // server stores {url? | key? | name?} — no display_url).
    const cleanRetained = editForm.retainedPhotos.map((p) => {
      const out: { url?: string; key?: string; name?: string } = {}
      if (p.url) out.url = p.url
      if (p.key) out.key = p.key
      if (p.name) out.name = p.name
      return out
    })

    const payload: Record<string, unknown> = {
      area: editForm.area.trim(),
      item: editForm.item.trim(),
      condition: editForm.condition,
      description: editForm.description.trim() || null,
      is_damage: editForm.is_damage,
      estimated_cost_minor: editForm.is_damage ? editForm.estimated_cost_minor : null,
      photos: [...cleanRetained, ...uploaded],
    }
    await $fetch(
      `/api/inspections/${id.value}/findings/${editingFindingId.value}`,
      { method: 'PATCH', body: payload },
    )
    showToast({ title: 'Finding saved' })
    editingFindingId.value = null
    editForm.editPendingFiles = []
    editUploadProgress.value = ''
    await load()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Save failed', icon: 'error' })
  } finally {
    savingFinding.value = false
  }
}

async function deleteFinding(f: Finding) {
  if (f.damage_charge_id) {
    showToast({
      title: 'Void the linked damage charge first',
      icon: 'warning',
    })
    return
  }
  if (!confirm(`Delete finding ${f.area} / ${f.item}? This cannot be undone.`)) return
  try {
    await $fetch(`/api/inspections/${id.value}/findings/${f.id}`, {
      method: 'DELETE',
    })
    showToast({ title: 'Finding deleted' })
    await load()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Delete failed', icon: 'error' })
  }
}

async function complete() {
  if (!inspection.value) return
  acting.value = 'complete'
  try {
    await $fetch(`/api/inspections/${id.value}/complete`, { method: 'POST' })
    showToast({ title: 'Inspection completed' })
    await load()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Complete failed', icon: 'error' })
  } finally {
    acting.value = null
  }
}

function openCancel() {
  cancelReason.value = ''
  cancelModal.value = true
}

async function cancel() {
  if (!cancelReason.value.trim()) {
    showToast({ title: 'Reason is required', icon: 'warning' })
    return
  }
  acting.value = 'cancel'
  try {
    await $fetch(`/api/inspections/${id.value}/cancel`, {
      method: 'POST',
      body: { reason: cancelReason.value.trim() },
    })
    showToast({ title: 'Inspection cancelled' })
    cancelModal.value = false
    await load()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Cancel failed', icon: 'error' })
  } finally {
    acting.value = null
  }
}

async function chargeDamages() {
  if (!inspection.value) return
  if (!confirm('Create property_charges (kind=damage) for all is_damage findings without a charge yet? Idempotent — safe to re-run.'))
    return
  acting.value = 'charge'
  try {
    const res = await $fetch<{
      inspection_id: string
      charges_created: number
      total_amount_minor: number
    }>(`/api/inspections/${id.value}/charge-damages`, { method: 'POST' })
    showToast({
      title: `${res.charges_created} damage charge(s) created (₱${(res.total_amount_minor / 100).toFixed(2)})`,
    })
    await load()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Charge failed', icon: 'error' })
  } finally {
    acting.value = null
  }
}

function openMeta() {
  if (!inspection.value) return
  metaForm.scheduled_at = inspection.value.scheduled_at
    ? new Date(inspection.value.scheduled_at).toISOString().slice(0, 16)
    : ''
  metaForm.inspector_external_name = inspection.value.inspector_external_name ?? ''
  metaForm.summary_notes = inspection.value.summary_notes ?? ''
  metaModal.value = true
}

async function saveMeta() {
  savingMeta.value = true
  try {
    const payload: Record<string, unknown> = {
      scheduled_at: metaForm.scheduled_at
        ? new Date(metaForm.scheduled_at).toISOString()
        : null,
      inspector_external_name:
        metaForm.inspector_external_name.trim() || null,
      summary_notes: metaForm.summary_notes.trim() || null,
    }
    await $fetch(`/api/inspections/${id.value}`, {
      method: 'PATCH',
      body: payload,
    })
    showToast({ title: 'Inspection updated' })
    metaModal.value = false
    await load()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Save failed', icon: 'error' })
  } finally {
    savingMeta.value = false
  }
}

function formatPHP(minor: number) {
  return ((minor || 0) / 100).toLocaleString('en-PH', {
    style: 'currency',
    currency: 'PHP',
  })
}

function statusClass(s: InspectionStatus): string {
  switch (s) {
    case 'scheduled':
      return 'bg-muted text-muted-foreground'
    case 'in_progress':
      return 'bg-primary/15 text-primary'
    case 'completed':
      return 'bg-warning/15 text-warning'
    case 'tenant_signed':
      return 'bg-success/15 text-success'
    case 'cancelled':
      return 'bg-destructive/15 text-destructive'
  }
}

function conditionClass(c: FindingCondition): string {
  switch (c) {
    case 'excellent':
    case 'good':
      return 'bg-success/15 text-success'
    case 'fair':
      return 'bg-muted text-muted-foreground'
    case 'damaged':
    case 'requires_repair':
      return 'bg-warning/15 text-warning'
    case 'requires_replacement':
    case 'missing':
      return 'bg-destructive/15 text-destructive'
  }
}

// Group findings by area for the rendered list.
const groupedFindings = computed(() => {
  const map = new Map<string, Finding[]>()
  for (const f of findings.value) {
    if (!map.has(f.area)) map.set(f.area, [])
    map.get(f.area)!.push(f)
  }
  return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))
})

// Comparison-section gating: only show for move_out inspections that
// actually have at least one baseline link.
const findingsWithBaseline = computed(() =>
  findings.value.filter((f): f is Finding & { baseline: BaselineFinding } => !!f.baseline),
)
const showComparison = computed(
  () => inspection.value?.inspection_kind === 'move_out' && findingsWithBaseline.value.length > 0,
)

function conditionRank(c: FindingCondition): number {
  switch (c) {
    case 'excellent':
      return 1
    case 'good':
      return 2
    case 'fair':
      return 3
    case 'damaged':
      return 4
    case 'requires_repair':
      return 5
    case 'requires_replacement':
      return 6
    case 'missing':
      return 7
  }
}

function conditionDelta(baseline: FindingCondition, current: FindingCondition): 'improved' | 'same' | 'worse' {
  const b = conditionRank(baseline)
  const c = conditionRank(current)
  if (c < b) return 'improved'
  if (c > b) return 'worse'
  return 'same'
}

onMounted(async () => {
  const ok =
    (await hasPermission('inspections.manage')) ||
    (await hasPermission('property.manage')) ||
    (await hasPermission('admin.access'))
  isChecking.value = false
  if (!ok) {
    showToast({ title: 'Access denied', icon: 'warning' })
    router.replace('/dashboard')
    return
  }
  allowed.value = true
  await load()
})
</script>

<template>
  <div class="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
    <div
      v-if="isChecking"
      class="rounded-lg border border-border bg-card p-5 text-center text-sm text-muted-foreground"
    >
      Checking access…
    </div>

    <template v-else-if="allowed">
      <NuxtLink
        v-if="inspection?.lease_id"
        :to="`/admin/leases/${inspection.lease_id}`"
        class="inline-flex items-center text-sm text-primary hover:underline"
      >
        ← Back to lease
      </NuxtLink>
      <NuxtLink
        v-else
        to="/admin"
        class="inline-flex items-center text-sm text-primary hover:underline"
      >
        ← Back to admin
      </NuxtLink>

      <div
        v-if="loading"
        class="rounded-lg border border-border bg-card p-5 text-center text-sm text-muted-foreground"
      >
        Loading…
      </div>

      <template v-else-if="inspection">
        <!-- Header card -->
        <section class="rounded-lg border border-border bg-card p-5 text-card-foreground">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="mb-2 flex flex-wrap items-center gap-2">
                <span class="font-mono text-xs text-foreground">
                  {{ inspection.inspection_no }}
                </span>
                <span class="text-xs uppercase tracking-wide text-muted-foreground">
                  {{ inspection.inspection_kind.replace('_', '-') }}
                </span>
                <span
                  :class="['inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium', statusClass(inspection.status)]"
                >{{ inspection.status.replace('_', ' ') }}</span>
                <span
                  v-if="inspection.overall_condition"
                  class="text-xs uppercase tracking-wide text-muted-foreground"
                >
                  · overall {{ inspection.overall_condition }}
                </span>
              </div>
              <h1 class="text-page-title">
                Inspection
                <span class="text-sm font-normal text-muted-foreground">
                  for unit {{ inspection.unit_id.slice(0, 8) }}…
                </span>
              </h1>
              <p class="mt-1 text-sm text-muted-foreground">
                <span v-if="inspection.scheduled_at">
                  scheduled {{ new Date(inspection.scheduled_at).toLocaleString() }}
                </span>
                <span v-if="inspection.conducted_at">
                  · conducted {{ new Date(inspection.conducted_at).toLocaleDateString() }}
                </span>
                <span v-if="inspection.tenant_signed_at" class="text-success">
                  · tenant signed {{ new Date(inspection.tenant_signed_at).toLocaleDateString() }}
                </span>
              </p>
              <p class="mt-1 text-xs text-muted-foreground/70">
                Inspector:
                <span v-if="inspection.inspector_external_name">
                  {{ inspection.inspector_external_name }}
                </span>
                <span v-else-if="inspection.inspector_user_id">
                  user {{ inspection.inspector_user_id.slice(0, 8) }}…
                </span>
                <span v-else>—</span>
                <span v-if="inspection.total_damage_estimate_minor > 0" class="text-destructive">
                  · damage estimate {{ formatPHP(inspection.total_damage_estimate_minor) }}
                </span>
              </p>
            </div>

            <div class="flex flex-wrap gap-2">
              <button
                v-if="canEditFindings"
                type="button"
                class="btn-secondary focus-ring"
                @click="openMeta"
              >
                Edit details
              </button>
              <button
                v-if="canComplete"
                type="button"
                :disabled="acting !== null"
                class="rounded-lg bg-success px-3 py-2 text-sm font-semibold text-success-foreground shadow hover:bg-success/90 disabled:opacity-60"
                @click="complete"
              >
                <span v-if="acting === 'complete'">Completing…</span>
                <span v-else>Complete</span>
              </button>
              <button
                v-if="canChargeDamages"
                type="button"
                :disabled="acting !== null"
                class="rounded-lg bg-warning px-3 py-2 text-sm font-semibold text-warning-foreground shadow hover:bg-warning/90 disabled:opacity-60"
                @click="chargeDamages"
              >
                <span v-if="acting === 'charge'">Charging…</span>
                <span v-else>Charge damages</span>
              </button>
              <button
                v-if="canCancel"
                type="button"
                :disabled="acting !== null"
                class="rounded-lg border border-destructive/40 bg-background px-3 py-2 text-sm font-semibold text-destructive hover:bg-destructive/10 disabled:opacity-60"
                @click="openCancel"
              >
                Cancel
              </button>
            </div>
          </div>

          <p v-if="inspection.summary_notes" class="mt-4 border-t border-border pt-3 text-sm text-muted-foreground">
            {{ inspection.summary_notes }}
          </p>
        </section>

        <!-- Findings -->
        <section class="rounded-lg border border-border bg-card p-5 text-card-foreground">
          <div class="mb-3 flex items-center justify-between">
            <h2 class="text-base font-semibold text-foreground">
              Findings
              <span class="text-xs font-normal text-muted-foreground">
                ({{ findings.length }})
              </span>
            </h2>
            <button
              v-if="canEditFindings"
              type="button"
              class="text-xs text-primary hover:underline"
              @click="openAddFinding"
            >
              + Add finding
            </button>
          </div>

          <div v-if="findings.length === 0" class="text-sm text-muted-foreground">
            No findings recorded yet. Add at least one before completing the inspection.
          </div>

          <div v-else class="space-y-5">
            <div v-for="[area, items] in groupedFindings" :key="area">
              <h3 class="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {{ area.replace('_', ' ') }}
              </h3>
              <ul class="divide-y divide-border rounded-lg border border-border">
                <li v-for="f in items" :key="f.id" class="px-3 py-2.5">
                  <!-- Read mode -->
                  <div v-if="editingFindingId !== f.id" class="flex flex-wrap items-start justify-between gap-3">
                    <div class="min-w-0">
                      <div class="flex flex-wrap items-center gap-2">
                        <span class="text-sm font-medium text-foreground">{{ f.item }}</span>
                        <span :class="['inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase', conditionClass(f.condition)]">
                          {{ f.condition.replace('_', ' ') }}
                        </span>
                        <span
                          v-if="f.is_damage"
                          class="inline-flex rounded-full bg-destructive/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-destructive"
                        >damage</span>
                        <span
                          v-if="f.damage_charge_id"
                          class="text-[10px] uppercase tracking-wide text-success"
                        >
                          · charged
                        </span>
                      </div>
                      <p v-if="f.description" class="mt-0.5 text-xs text-muted-foreground">
                        {{ f.description }}
                      </p>
                      <p v-if="f.is_damage && f.estimated_cost_minor" class="mt-0.5 text-xs">
                        <span class="text-muted-foreground">Estimated cost:</span>
                        <span class="font-medium text-foreground">{{ formatPHP(f.estimated_cost_minor) }}</span>
                      </p>
                      <ul v-if="f.photos.length > 0" class="mt-1 flex flex-wrap gap-1">
                        <li v-for="(p, pi) in f.photos" :key="(p.key ?? p.url ?? '') + ':' + pi">
                          <a
                            v-if="p.display_url || p.url"
                            :href="(p.display_url || p.url) as string"
                            target="_blank"
                            rel="noopener noreferrer"
                            class="text-[10px] font-mono text-primary hover:underline"
                          >
                            ðŸ“· {{ p.name ?? (p.key ? p.key.split('/').pop() : ((p.url ?? '').slice(0, 40) + '…')) }}
                          </a>
                          <span
                            v-else
                            class="text-[10px] font-mono text-muted-foreground"
                          >
                            ðŸ“· {{ p.name ?? p.key ?? '(unresolvable)' }}
                          </span>
                        </li>
                      </ul>
                    </div>
                    <div v-if="canEditFindings" class="flex flex-shrink-0 items-center gap-2">
                      <button
                        type="button"
                        class="text-xs text-primary hover:underline"
                        @click="startEditFinding(f)"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        class="text-xs text-destructive hover:underline"
                        @click="deleteFinding(f)"
                      >
                        Delete
                      </button>
                    </div>
                  </div>

                  <!-- Edit mode -->
                  <div v-else class="space-y-2">
                    <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <label class="block">
                        <span class="block text-[11px] font-medium text-muted-foreground">Area</span>
                        <input
                          v-model="editForm.area"
                          type="text"
                          maxlength="64"
                          class="mt-0.5 block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                        />
                      </label>
                      <label class="block">
                        <span class="block text-[11px] font-medium text-muted-foreground">Item</span>
                        <input
                          v-model="editForm.item"
                          type="text"
                          maxlength="64"
                          class="mt-0.5 block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                        />
                      </label>
                      <label class="block">
                        <span class="block text-[11px] font-medium text-muted-foreground">Condition</span>
                        <select
                          v-model="editForm.condition"
                          class="mt-0.5 block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                        >
                          <option value="excellent">excellent</option>
                          <option value="good">good</option>
                          <option value="fair">fair</option>
                          <option value="damaged">damaged</option>
                          <option value="requires_repair">requires repair</option>
                          <option value="requires_replacement">requires replacement</option>
                          <option value="missing">missing</option>
                        </select>
                      </label>
                      <label class="flex items-end gap-2 text-xs text-foreground">
                        <input
                          v-model="editForm.is_damage"
                          type="checkbox"
                          class="h-4 w-4 rounded border-border"
                        />
                        <span>Tenant-chargeable damage</span>
                      </label>
                    </div>
                    <label class="block">
                      <span class="block text-[11px] font-medium text-muted-foreground">Description</span>
                      <textarea
                        v-model="editForm.description"
                        rows="2"
                        maxlength="2000"
                        class="mt-0.5 block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                      />
                    </label>
                    <label v-if="editForm.is_damage" class="block">
                      <span class="block text-[11px] font-medium text-muted-foreground">
                        Estimated cost (centavos · ₱{{ ((editForm.estimated_cost_minor || 0) / 100).toFixed(2) }})
                      </span>
                      <input
                        v-model.number="editForm.estimated_cost_minor"
                        type="number"
                        min="0"
                        step="100"
                        class="mt-0.5 block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                      />
                    </label>

                    <!-- Photos: existing (with remove) + new (file picker + chip preview) -->
                    <div class="space-y-1.5">
                      <span class="block text-[11px] font-medium text-muted-foreground">
                        Photos ({{ editForm.retainedPhotos.length + editForm.editPendingFiles.length }} / 12)
                      </span>
                      <ul
                        v-if="editForm.retainedPhotos.length > 0"
                        class="flex flex-wrap gap-1"
                      >
                        <li
                          v-for="(p, pi) in editForm.retainedPhotos"
                          :key="(p.key ?? p.url ?? '') + ':retained:' + pi"
                          class="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[10px] text-success"
                        >
                          <span class="font-mono">
                            {{ p.name ?? (p.key ? p.key.split('/').pop() : (p.url ?? '').slice(-30)) }}
                          </span>
                          <button
                            type="button"
                            class="ml-1 hover:text-destructive"
                            @click="removeRetainedPhoto(pi)"
                            title="Remove this photo from the finding (S3 object stays until the daily cleanup cron lands)"
                          >
                            ×
                          </button>
                        </li>
                      </ul>
                      <ul
                        v-if="editForm.editPendingFiles.length > 0"
                        class="flex flex-wrap gap-1"
                      >
                        <li
                          v-for="(f, fi) in editForm.editPendingFiles"
                          :key="f.name + ':pending:' + fi"
                          class="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] text-foreground"
                        >
                          <span class="font-mono">{{ f.name }}</span>
                          <span class="text-muted-foreground">{{ (f.size / 1024).toFixed(0) }} KB</span>
                          <button
                            type="button"
                            class="ml-1 text-muted-foreground hover:text-destructive"
                            @click="removeEditPendingFile(fi)"
                          >
                            ×
                          </button>
                        </li>
                      </ul>
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                        multiple
                        class="block w-full text-xs text-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-background file:px-2.5 file:py-1 file:text-[11px] file:font-medium file:text-foreground hover:file:bg-accent"
                        @change="onEditFilePick"
                      />
                    </div>

                    <div class="flex items-center justify-end gap-2 pt-1">
                      <span
                        v-if="editUploadProgress"
                        class="mr-auto text-[11px] text-muted-foreground"
                      >
                        {{ editUploadProgress }}
                      </span>
                      <button
                        type="button"
                        class="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground"
                        @click="editingFindingId = null"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        :disabled="savingFinding"
                        class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 focus-ring disabled:opacity-60"
                        @click="saveFinding"
                      >
                        <span v-if="savingFinding">Saving…</span>
                        <span v-else>Save</span>
                      </button>
                    </div>
                  </div>
                </li>
              </ul>
            </div>
          </div>
        </section>

        <!-- Move-in vs move-out comparison -->
        <section
          v-if="showComparison"
          class="rounded-lg border border-border bg-card p-5 text-card-foreground"
        >
          <div class="mb-3 flex items-center justify-between">
            <h2 class="text-base font-semibold text-foreground">
              Move-in baseline comparison
              <span class="text-xs font-normal text-muted-foreground">
                ({{ findingsWithBaseline.length }} paired)
              </span>
            </h2>
          </div>
          <p class="mb-3 text-xs text-muted-foreground">
            Move-out findings paired with their move-in baseline. Condition
            shifts that worsen are flagged for damage assessment.
          </p>
          <ul class="space-y-3">
            <li
              v-for="f in findingsWithBaseline"
              :key="f.id + ':compare'"
              class="rounded-lg border border-border bg-muted/20 p-3"
            >
              <div class="mb-2 flex flex-wrap items-center gap-2">
                <span class="text-sm font-medium text-foreground">
                  {{ f.area.replace('_', ' ') }} — {{ f.item }}
                </span>
                <span
                  :class="[
                    'inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase',
                    conditionDelta(f.baseline.condition, f.condition) === 'worse'
                      ? 'bg-destructive/15 text-destructive'
                      : conditionDelta(f.baseline.condition, f.condition) === 'improved'
                        ? 'bg-success/15 text-success'
                        : 'bg-muted text-muted-foreground',
                  ]"
                >
                  {{ conditionDelta(f.baseline.condition, f.condition) }}
                </span>
                <span
                  v-if="f.is_damage"
                  class="inline-flex rounded-full bg-destructive/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-destructive"
                >damage</span>
                <span
                  v-if="f.is_damage && f.estimated_cost_minor"
                  class="text-xs font-medium text-foreground"
                >
                  est. {{ formatPHP(f.estimated_cost_minor) }}
                </span>
              </div>
              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <!-- Baseline -->
                <div class="rounded border border-border bg-card p-2.5">
                  <div class="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    Move-in baseline
                  </div>
                  <div class="flex items-center gap-2">
                    <span :class="['inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase', conditionClass(f.baseline.condition)]">
                      {{ f.baseline.condition.replace('_', ' ') }}
                    </span>
                  </div>
                  <p v-if="f.baseline.description" class="mt-1 text-xs text-muted-foreground">
                    {{ f.baseline.description }}
                  </p>
                  <ul v-if="f.baseline.photos.length > 0" class="mt-1 flex flex-wrap gap-1">
                    <li v-for="(p, pi) in f.baseline.photos" :key="(p.key ?? p.url ?? '') + ':base:' + pi">
                      <a
                        v-if="p.display_url || p.url"
                        :href="(p.display_url || p.url) as string"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="text-[10px] font-mono text-primary hover:underline"
                      >
                        ðŸ“· {{ p.name ?? 'photo' }}
                      </a>
                    </li>
                  </ul>
                </div>
                <!-- Current -->
                <div class="rounded border border-border bg-card p-2.5">
                  <div class="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    Move-out current
                  </div>
                  <div class="flex items-center gap-2">
                    <span :class="['inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase', conditionClass(f.condition)]">
                      {{ f.condition.replace('_', ' ') }}
                    </span>
                  </div>
                  <p v-if="f.description" class="mt-1 text-xs text-muted-foreground">
                    {{ f.description }}
                  </p>
                  <ul v-if="f.photos.length > 0" class="mt-1 flex flex-wrap gap-1">
                    <li v-for="(p, pi) in f.photos" :key="(p.key ?? p.url ?? '') + ':cur:' + pi">
                      <a
                        v-if="p.display_url || p.url"
                        :href="(p.display_url || p.url) as string"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="text-[10px] font-mono text-primary hover:underline"
                      >
                        ðŸ“· {{ p.name ?? 'photo' }}
                      </a>
                    </li>
                  </ul>
                </div>
              </div>
            </li>
          </ul>
        </section>

        <!-- Tenant attestation panel (read-only display) -->
        <section
          v-if="inspection.tenant_signed_at"
          class="rounded-lg border border-success/30 bg-success/5 p-5"
        >
          <h2 class="text-base font-semibold text-success">Tenant attestation</h2>
          <p class="mt-1 text-sm text-foreground">
            Signed {{ new Date(inspection.tenant_signed_at).toLocaleString() }}
            <span v-if="inspection.tenant_party_id">
              by lease party {{ inspection.tenant_party_id.slice(0, 8) }}…
            </span>
          </p>
          <p
            v-if="inspection.tenant_signature && (inspection.tenant_signature as any).kind"
            class="mt-1 text-xs text-muted-foreground"
          >
            Signature kind: {{ (inspection.tenant_signature as any).kind }}
            <span v-if="(inspection.tenant_signature as any).value">
              · "{{ String((inspection.tenant_signature as any).value).slice(0, 100) }}"
            </span>
          </p>
        </section>
      </template>

      <!-- Add finding — Phase 5 Operations primitive -->
      <UiModal
        :open="addFindingModal"
        title="Add finding"
        width="lg"
        @update:open="addFindingModal = $event"
      >
        <div class="space-y-3">
            <div class="grid grid-cols-2 gap-3">
              <label class="block">
                <span class="block text-xs font-medium text-muted-foreground">Area</span>
                <input
                  v-model="addForm.area"
                  type="text"
                  maxlength="64"
                  list="area-suggestions"
                  class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
                />
                <datalist id="area-suggestions">
                  <option value="kitchen" />
                  <option value="living_room" />
                  <option value="bedroom_1" />
                  <option value="bedroom_2" />
                  <option value="bathroom_master" />
                  <option value="bathroom_common" />
                  <option value="utility" />
                  <option value="parking" />
                  <option value="balcony" />
                  <option value="common_area" />
                  <option value="exterior" />
                </datalist>
              </label>
              <label class="block">
                <span class="block text-xs font-medium text-muted-foreground">Item</span>
                <input
                  v-model="addForm.item"
                  type="text"
                  maxlength="64"
                  list="item-suggestions"
                  class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
                />
                <datalist id="item-suggestions">
                  <option value="walls" />
                  <option value="floor" />
                  <option value="ceiling" />
                  <option value="doors" />
                  <option value="windows" />
                  <option value="plumbing" />
                  <option value="electrical" />
                  <option value="appliances" />
                  <option value="fixtures" />
                  <option value="cabinetry" />
                  <option value="security" />
                  <option value="overall" />
                </datalist>
              </label>
            </div>
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">Condition</span>
              <select
                v-model="addForm.condition"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              >
                <option value="excellent">excellent</option>
                <option value="good">good</option>
                <option value="fair">fair</option>
                <option value="damaged">damaged</option>
                <option value="requires_repair">requires repair</option>
                <option value="requires_replacement">requires replacement</option>
                <option value="missing">missing</option>
              </select>
            </label>
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">Description</span>
              <textarea
                v-model="addForm.description"
                rows="2"
                maxlength="2000"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>
            <label class="flex items-start gap-2 text-sm text-foreground">
              <input
                v-model="addForm.is_damage"
                type="checkbox"
                class="mt-0.5 h-4 w-4 rounded border-border"
              />
              <span>
                Tenant-chargeable damage. <em>Charge damages</em> on the
                inspection footer creates a property_charge per flagged finding.
              </span>
            </label>
            <label v-if="addForm.is_damage" class="block">
              <span class="block text-xs font-medium text-muted-foreground">
                Estimated cost (centavos · ₱{{ ((addForm.estimated_cost_minor || 0) / 100).toFixed(2) }})
              </span>
              <input
                v-model.number="addForm.estimated_cost_minor"
                type="number"
                min="0"
                step="100"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>
            <div class="space-y-2">
              <span class="block text-xs font-medium text-muted-foreground">Photos</span>

              <!-- File picker — uploads to S3 via presigned URL after the
                   finding row is created (uses finding.id in the path). -->
              <label class="block">
                <span class="block text-[11px] text-muted-foreground">
                  Pick image files (jpeg / png / webp / heic — up to 12, max 20 MB each)
                </span>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                  multiple
                  class="mt-1 block w-full text-xs text-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-background file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-foreground hover:file:bg-accent"
                  @change="onFilePick"
                />
              </label>
              <ul v-if="pendingFiles.length > 0" class="flex flex-wrap gap-1">
                <li
                  v-for="(f, i) in pendingFiles"
                  :key="f.name + ':' + f.size + ':' + i"
                  class="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] text-foreground"
                >
                  <span class="font-mono">{{ f.name }}</span>
                  <span class="text-muted-foreground">
                    {{ (f.size / 1024).toFixed(0) }} KB
                  </span>
                  <button
                    type="button"
                    class="ml-1 text-muted-foreground hover:text-destructive"
                    @click="removePendingFile(i)"
                    :title="`Remove ${f.name}`"
                  >
                    ×
                  </button>
                </li>
              </ul>

              <!-- Hand-pasted URLs (legacy / external photos still work). -->
              <label class="block">
                <span class="block text-[11px] text-muted-foreground">
                  Or paste photo URLs (one per line, or comma-separated)
                </span>
                <textarea
                  v-model="addForm.photo_urls"
                  rows="2"
                  placeholder="https://… one URL per line"
                  class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
                />
              </label>
            </div>
        </div>
        <template #footer>
          <div class="flex items-center justify-between gap-2">
            <p
              v-if="uploadProgress"
              class="text-[11px] text-muted-foreground"
            >
              {{ uploadProgress }}
            </p>
            <div class="ml-auto flex gap-2">
              <button
                type="button"
                class="btn-secondary"
                @click="addFindingModal = false"
              >
                Cancel
              </button>
              <button
                type="button"
                :disabled="addingFinding"
                class="btn-primary disabled:opacity-60"
                @click="addFinding"
              >
                <span v-if="addingFinding">Adding…</span>
                <span v-else>Add finding</span>
              </button>
            </div>
          </div>
        </template>
      </UiModal>

      <!-- Cancel inspection — Phase 5 Operations primitive (destructive) -->
      <UiModal
        :open="cancelModal"
        title="Cancel inspection"
        subtitle="Sets the inspection to cancelled (terminal). Findings remain attached to the audit trail. Reason is required."
        width="md"
        tone="destructive"
        @update:open="cancelModal = $event"
      >
        <textarea
          v-model="cancelReason"
          rows="3"
          maxlength="500"
          placeholder="e.g., tenant rescheduled · operator double-booked"
          class="block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-destructive focus:ring-2 focus:ring-destructive/30"
        />
        <template #footer>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="btn-secondary"
              @click="cancelModal = false"
            >
              Cancel
            </button>
            <button
              type="button"
              :disabled="acting === 'cancel'"
              class="btn-destructive disabled:opacity-60"
              @click="cancel"
            >
              <span v-if="acting === 'cancel'">Cancelling…</span>
              <span v-else>Confirm cancel</span>
            </button>
          </div>
        </template>
      </UiModal>

      <!-- Edit inspection metadata — Phase 5 Operations primitive -->
      <UiModal
        :open="metaModal"
        title="Edit inspection"
        width="md"
        @update:open="metaModal = $event"
      >
        <div class="space-y-3">
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">Scheduled at</span>
            <input
              v-model="metaForm.scheduled_at"
              type="datetime-local"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
          </label>
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">Inspector (external)</span>
            <input
              v-model="metaForm.inspector_external_name"
              type="text"
              maxlength="200"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
          </label>
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">Summary notes</span>
            <textarea
              v-model="metaForm.summary_notes"
              rows="3"
              maxlength="2000"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
          </label>
        </div>
        <template #footer>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="btn-secondary"
              @click="metaModal = false"
            >
              Cancel
            </button>
            <button
              type="button"
              :disabled="savingMeta"
              class="btn-primary disabled:opacity-60"
              @click="saveMeta"
            >
              <span v-if="savingMeta">Saving…</span>
              <span v-else>Save</span>
            </button>
          </div>
        </template>
      </UiModal>
    </template>
  </div>
</template>
