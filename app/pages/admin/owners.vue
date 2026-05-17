<script setup lang="ts">
/**
 * /admin/owners — property owners directory.
 *
 * Read-mostly view. Operators add owners during onboarding via
 * /api/units/:id/owners (POST register_unit_owner) so this page
 * focuses on browsing and editing existing records — not bulk creation.
 */

import { ref, computed, onMounted, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { hasPermission } from '~/composables/useAuth'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })
useHead({ title: 'Property Owners | Admin' })

type Owner = {
  id: string
  user_id: string | null
  contact_id: number | null
  external_name: string | null
  external_email: string | null
  tax_id: string | null
  billing_address: Record<string, unknown>
  bank_account: Record<string, unknown>
  notes: string | null
  created_at: string
  updated_at: string
}

type PortalInvitationStatus = 'active' | 'accepted' | 'revoked' | 'expired'

type PortalInvitation = {
  id: string
  property_owner_id: string
  invite_email: string
  expires_at: string
  accepted_at: string | null
  accepted_by_user_id: string | null
  revoked_at: string | null
  revoked_reason: string | null
  created_at: string
  status: PortalInvitationStatus
}

type IssuedInvitation = {
  invitation_id: string
  property_owner_id: string
  invite_email: string
  expires_at: string
  accept_url: string
  email_delivered: boolean
}

type OwnerStatementPolicy = {
  id: string
  property_owner_id: string
  cadence: 'monthly' | 'quarterly'
  fire_day_of_period: number
  auto_issue: boolean
  status: 'active' | 'paused'
  next_run_at: string
  last_generated_period_start: string | null
  notes: string | null
}

const router = useRouter()
const isChecking = ref(true)
const allowed = ref(false)

const owners = ref<Owner[]>([])
const loading = ref(false)
const search = ref('')

const editingId = ref<string | null>(null)
const editForm = reactive({
  external_name: '',
  external_email: '',
  tax_id: '',
  notes: '',
})
const saving = ref(false)

// Most-recent invitation per property owner (any status). Drives the
// per-row Portal column + invite/revoke action buttons.
const invitationsByOwner = ref<Record<string, PortalInvitation | null>>({})

// Issue / revoke modal state.
const inviteModal = ref(false)
const inviteOwner = ref<Owner | null>(null)
const inviteForm = reactive({
  invite_email: '',
  expires_in_days: 14,
})
const issuingInvite = ref(false)
const issuedInvite = ref<IssuedInvitation | null>(null)
const copyConfirm = ref(false)

const revokeModal = ref(false)
const revokeTarget = ref<PortalInvitation | null>(null)
const revokeReason = ref('')
const revoking = ref(false)

// Owner statement policy state, indexed by property_owner_id.
const statementPolicyByOwner = ref<Record<string, OwnerStatementPolicy | null>>({})

// Editor modal.
const statementPolicyModal = ref(false)
const statementPolicyOwner = ref<Owner | null>(null)
const statementPolicyForm = reactive({
  cadence: 'monthly' as 'monthly' | 'quarterly',
  fire_day_of_period: 1,
  auto_issue: false,
  notes: '',
})
const savingStatementPolicy = ref(false)
const optingOutOfStatements = ref(false)
// Page-level "Generate now" button — fires the cron once across all
// active policies, not just this owner.
const generatingStatements = ref(false)

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ items: Owner[] }>('/api/property-owners')
    owners.value = res.items ?? []
    // Don't block render on the badge data.
    void loadInvitations()
    void loadStatementPolicies()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not load owners', icon: 'error' })
  } finally {
    loading.value = false
  }
}

async function loadInvitations() {
  // Single fetch, indexed client-side. Endpoint returns rows DESC by
  // created_at so the first row per owner is the most recent. limit=200
  // is the upper bound on the GET endpoint (z.coerce max(100) actually,
  // so we cap at 100 and accept that operators with >100 invitations
  // need to wait for a future paginated badge view).
  try {
    const res = await $fetch<{ rows: PortalInvitation[] }>(
      '/api/admin/owner-portal-invitations',
      { query: { limit: 100 } },
    )
    const next: Record<string, PortalInvitation | null> = {}
    for (const row of res.rows ?? []) {
      // Keep the FIRST (most recent) row we see per owner.
      if (!(row.property_owner_id in next)) {
        next[row.property_owner_id] = row
      }
    }
    invitationsByOwner.value = next
  } catch {
    // Fail silently — Portal column just shows "—" for all rows.
  }
}

function openInvite(owner: Owner) {
  inviteOwner.value = owner
  inviteForm.invite_email = owner.external_email ?? ''
  inviteForm.expires_in_days = 14
  issuedInvite.value = null
  copyConfirm.value = false
  inviteModal.value = true
}

async function issueInvite() {
  if (!inviteOwner.value) return
  const email = inviteForm.invite_email.trim()
  if (!email) {
    showToast({ title: 'Email is required', icon: 'warning' })
    return
  }
  issuingInvite.value = true
  try {
    const res = await $fetch<IssuedInvitation>(
      '/api/admin/owner-portal-invitations',
      {
        method: 'POST',
        body: {
          property_owner_id: inviteOwner.value.id,
          invite_email: email,
          expires_in_days: inviteForm.expires_in_days,
        },
      },
    )
    issuedInvite.value = res
    showToast({
      title: res.email_delivered
        ? 'Invitation sent'
        : 'Invitation created — copy the link below to deliver manually',
    })
    void loadInvitations()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not issue invitation', icon: 'error' })
  } finally {
    issuingInvite.value = false
  }
}

async function copyInviteLink() {
  if (!issuedInvite.value?.accept_url) return
  try {
    await navigator.clipboard.writeText(issuedInvite.value.accept_url)
    copyConfirm.value = true
    setTimeout(() => (copyConfirm.value = false), 1500)
  } catch {
    showToast({ title: 'Could not copy — select the link and copy manually', icon: 'warning' })
  }
}

function openRevoke(invitation: PortalInvitation) {
  revokeTarget.value = invitation
  revokeReason.value = ''
  revokeModal.value = true
}

async function revokeInvite() {
  if (!revokeTarget.value) return
  const reason = revokeReason.value.trim()
  if (!reason) {
    showToast({ title: 'Revoke reason is required', icon: 'warning' })
    return
  }
  revoking.value = true
  try {
    await $fetch(
      `/api/admin/owner-portal-invitations/${revokeTarget.value.id}/revoke`,
      { method: 'POST', body: { reason } },
    )
    showToast({ title: 'Invitation revoked' })
    revokeModal.value = false
    void loadInvitations()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not revoke invitation', icon: 'error' })
  } finally {
    revoking.value = false
  }
}

async function loadStatementPolicies() {
  // Per-owner GET — N owners on the page = N parallel calls. For the
  // typical admin operator with O(10s) of owners this is acceptable;
  // for larger fleets a batch endpoint would be worth it.
  const ids = owners.value.map((o) => o.id)
  if (ids.length === 0) {
    statementPolicyByOwner.value = {}
    return
  }
  try {
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          const res = await $fetch<{ policy: OwnerStatementPolicy | null }>(
            `/api/admin/property-owners/${id}/statement-policy`,
          )
          return [id, res.policy] as const
        } catch {
          return [id, null] as const
        }
      }),
    )
    const next: Record<string, OwnerStatementPolicy | null> = {}
    for (const [id, policy] of results) next[id] = policy
    statementPolicyByOwner.value = next
  } catch {
    // Fail silent — Statements column shows "—" for all rows.
  }
}

function openStatementPolicyEditor(owner: Owner) {
  statementPolicyOwner.value = owner
  const p = statementPolicyByOwner.value[owner.id]
  statementPolicyForm.cadence = p?.cadence ?? 'monthly'
  statementPolicyForm.fire_day_of_period = p?.fire_day_of_period ?? 1
  statementPolicyForm.auto_issue = p?.auto_issue ?? false
  statementPolicyForm.notes = p?.notes ?? ''
  statementPolicyModal.value = true
}

async function saveStatementPolicy() {
  if (!statementPolicyOwner.value) return
  savingStatementPolicy.value = true
  try {
    const res = await $fetch<{ policy: OwnerStatementPolicy }>(
      `/api/admin/property-owners/${statementPolicyOwner.value.id}/statement-policy`,
      {
        method: 'PUT',
        body: {
          cadence: statementPolicyForm.cadence,
          fire_day_of_period: statementPolicyForm.fire_day_of_period,
          auto_issue: statementPolicyForm.auto_issue,
          notes: statementPolicyForm.notes.trim() || null,
        },
      },
    )
    statementPolicyByOwner.value = {
      ...statementPolicyByOwner.value,
      [statementPolicyOwner.value.id]: res.policy,
    }
    showToast({ title: 'Statement schedule saved' })
    statementPolicyModal.value = false
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Could not save schedule',
      icon: 'error',
    })
  } finally {
    savingStatementPolicy.value = false
  }
}

async function optOutOfStatementsFor(owner: Owner) {
  if (!confirm(`Pause auto-statements for ${owner.external_name || 'this owner'}? Past-issued statements remain.`)) return
  optingOutOfStatements.value = true
  try {
    await $fetch(`/api/admin/property-owners/${owner.id}/statement-policy`, {
      method: 'DELETE',
    })
    statementPolicyByOwner.value = {
      ...statementPolicyByOwner.value,
      [owner.id]: null,
    }
    showToast({ title: 'Schedule ended' })
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Could not end schedule',
      icon: 'error',
    })
  } finally {
    optingOutOfStatements.value = false
  }
}

async function generateOwnerStatementsNow() {
  if (!confirm('Run the owner-statement generation cron now? This processes ALL active policies, not just one owner. Idempotent — safe to re-run.')) return
  generatingStatements.value = true
  try {
    const res = await $fetch<{
      run_id: string | null
      policies_processed: number
      statements_created: number
      skipped: number
      errors: number
    }>('/api/admin/owner-statements/generate', {
      method: 'POST',
      body: {},
    })
    showToast({
      title: `Generation done: ${res.statements_created} created across ${res.policies_processed} owner(s), ${res.skipped} skipped${res.errors ? `, ${res.errors} error(s)` : ''}`,
    })
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Generation failed',
      icon: 'error',
    })
  } finally {
    generatingStatements.value = false
  }
}

function statementPolicyBadge(p: OwnerStatementPolicy | null | undefined): string {
  if (!p) return 'off'
  return p.auto_issue ? `auto · ${p.cadence}` : `draft · ${p.cadence}`
}

function statementPolicyBadgeClass(p: OwnerStatementPolicy | null | undefined): string {
  if (!p) return 'bg-muted text-muted-foreground'
  return p.auto_issue ? 'bg-success/15 text-success' : 'bg-primary/15 text-primary'
}

function inviteStatusClass(s: PortalInvitationStatus): string {
  switch (s) {
    case 'active':
      return 'bg-primary/15 text-primary'
    case 'accepted':
      return 'bg-success/15 text-success'
    case 'revoked':
      return 'bg-muted text-muted-foreground'
    case 'expired':
      return 'bg-warning/15 text-warning'
  }
}

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return owners.value
  return owners.value.filter(
    (o) =>
      (o.external_name ?? '').toLowerCase().includes(q) ||
      (o.external_email ?? '').toLowerCase().includes(q) ||
      (o.tax_id ?? '').toLowerCase().includes(q),
  )
})

function startEdit(o: Owner) {
  editingId.value = o.id
  editForm.external_name = o.external_name ?? ''
  editForm.external_email = o.external_email ?? ''
  editForm.tax_id = o.tax_id ?? ''
  editForm.notes = o.notes ?? ''
}

async function save() {
  if (!editingId.value) return
  saving.value = true
  try {
    await $fetch(`/api/property-owners/${editingId.value}`, {
      method: 'PATCH',
      body: {
        external_name: editForm.external_name.trim() || null,
        external_email: editForm.external_email.trim() || null,
        tax_id: editForm.tax_id.trim() || null,
        notes: editForm.notes.trim() || null,
      },
    })
    showToast({ title: 'Owner updated' })
    editingId.value = null
    await load()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Save failed', icon: 'error' })
  } finally {
    saving.value = false
  }
}

function ownerLabel(o: Owner): string {
  if (o.external_name) return o.external_name
  if (o.user_id) return `User ${o.user_id.slice(0, 8)}…`
  if (o.contact_id) return `Contact #${o.contact_id}`
  if (o.external_email) return o.external_email
  return 'Unknown owner'
}

function ownerKind(o: Owner): string {
  if (o.user_id) return 'portal user'
  if (o.contact_id) return 'CRM contact'
  if (o.external_email || o.external_name) return 'external'
  return 'unspecified'
}

onMounted(async () => {
  const ok =
    (await hasPermission('property.manage')) || (await hasPermission('admin.access'))
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
  <div class="mx-auto max-w-[1400px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
    <div
      v-if="isChecking"
      class="rounded-lg border border-border bg-card p-5 text-center text-sm text-muted-foreground"
    >
      Checking access…
    </div>

    <template v-else-if="allowed">
      <header>
        <h1 class="text-page-title">
          Property Owners
        </h1>
        <p class="mt-1 text-sm text-muted-foreground">
          Identity records linked to units. Add new owners via the unit's "Register owner"
          flow on the unit page.
        </p>
      </header>

      <div class="flex flex-wrap items-center gap-2">
        <input
          v-model="search"
          type="search"
          placeholder="Search name, email, TIN…"
          class="w-72 rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground shadow-sm focus:border-ring focus:ring-1 focus:ring-ring"
        />
        <button
          type="button"
          :disabled="generatingStatements"
          class="ml-auto rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground focus-ring disabled:opacity-60"
          @click="generateOwnerStatementsNow"
          title="Run the daily owner-statement cron now (processes all active policies; idempotent)"
        >
          <span v-if="generatingStatements">Running…</span>
          <span v-else>Generate statements now</span>
        </button>
        <button
          type="button"
          class="text-xs text-muted-foreground underline-offset-2 hover:underline"
          @click="load"
        >
          Refresh
        </button>
      </div>

      <section class="rounded-lg border border-border bg-card text-card-foreground">
        <div v-if="loading" class="p-5 text-center text-sm text-muted-foreground">
          Loading…
        </div>
        <div
          v-else-if="filtered.length === 0"
          class="p-5 text-center text-sm text-muted-foreground"
        >
          No owners match the current filter.
        </div>
        <div v-else>
          <!-- Mobile: card list (< md). Mirrors the table's actions
               with the same handlers. -->
          <ul class="divide-y divide-border md:hidden">
            <li v-for="o in filtered" :key="o.id" class="p-4">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <NuxtLink
                    :to="`/admin/owners/${o.id}`"
                    class="block truncate text-sm font-semibold text-foreground hover:underline"
                  >
                    {{ ownerLabel(o) }}
                  </NuxtLink>
                  <p class="mt-0.5 text-xs text-muted-foreground">{{ ownerKind(o) }}</p>
                  <p v-if="o.external_email" class="mt-1 truncate text-xs text-foreground">
                    {{ o.external_email }}
                  </p>
                  <p v-if="o.tax_id" class="mt-0.5 truncate font-mono text-xs text-foreground">
                    TIN {{ o.tax_id }}
                  </p>
                </div>
                <div class="flex flex-col items-end gap-1 text-right">
                  <span
                    v-if="o.user_id"
                    class="inline-flex rounded-full bg-success/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-success"
                  >linked</span>
                  <span
                    v-else-if="invitationsByOwner[o.id]"
                    :class="['inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase', inviteStatusClass(invitationsByOwner[o.id]!.status)]"
                  >{{ invitationsByOwner[o.id]!.status }}</span>
                  <span
                    :class="['inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase', statementPolicyBadgeClass(statementPolicyByOwner[o.id])]"
                  >{{ statementPolicyBadge(statementPolicyByOwner[o.id]) }}</span>
                </div>
              </div>
              <div class="mt-3 flex flex-wrap gap-x-3 gap-y-1.5">
                <button
                  v-if="!o.user_id && (!invitationsByOwner[o.id] || invitationsByOwner[o.id]!.status !== 'active')"
                  type="button"
                  class="text-xs text-primary hover:underline"
                  @click="openInvite(o)"
                >
                  {{ invitationsByOwner[o.id] ? 'Re-invite' : 'Invite' }}
                </button>
                <button
                  v-if="!o.user_id && invitationsByOwner[o.id] && invitationsByOwner[o.id]!.status === 'active'"
                  type="button"
                  class="text-xs text-destructive hover:underline"
                  @click="openRevoke(invitationsByOwner[o.id]!)"
                >
                  Revoke
                </button>
                <button
                  type="button"
                  class="text-xs text-primary hover:underline"
                  @click="openStatementPolicyEditor(o)"
                >
                  {{ statementPolicyByOwner[o.id] ? 'Edit schedule' : 'Schedule' }}
                </button>
                <button
                  v-if="statementPolicyByOwner[o.id]"
                  type="button"
                  :disabled="optingOutOfStatements"
                  class="text-xs text-destructive hover:underline disabled:opacity-60"
                  @click="optOutOfStatementsFor(o)"
                >
                  Stop
                </button>
                <button
                  type="button"
                  class="ml-auto text-xs text-primary hover:underline"
                  @click="editingId === o.id ? (editingId = null) : startEdit(o)"
                >
                  {{ editingId === o.id ? 'Cancel' : 'Edit' }}
                </button>
              </div>

              <!-- Inline edit (mobile) -->
              <div v-if="editingId === o.id" class="mt-3 rounded-lg bg-primary/5 p-3">
                <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label class="block">
                    <span class="block text-xs font-medium text-muted-foreground">Display name</span>
                    <input v-model="editForm.external_name" type="text" maxlength="200" class="mt-1 block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground" />
                  </label>
                  <label class="block">
                    <span class="block text-xs font-medium text-muted-foreground">Email</span>
                    <input v-model="editForm.external_email" type="email" maxlength="254" class="mt-1 block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground" />
                  </label>
                  <label class="block">
                    <span class="block text-xs font-medium text-muted-foreground">BIR TIN</span>
                    <input v-model="editForm.tax_id" type="text" maxlength="40" class="mt-1 block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground" />
                  </label>
                  <label class="block">
                    <span class="block text-xs font-medium text-muted-foreground">Notes</span>
                    <input v-model="editForm.notes" type="text" maxlength="2000" class="mt-1 block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground" />
                  </label>
                </div>
                <div class="mt-3 flex justify-end gap-2">
                  <button type="button" class="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground" @click="editingId = null">Cancel</button>
                  <button type="button" :disabled="saving" class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 focus-ring disabled:opacity-60" @click="save">
                    <span v-if="saving">Saving…</span><span v-else>Save</span>
                  </button>
                </div>
              </div>
            </li>
          </ul>

          <!-- Desktop table (md+) -->
          <div class="hidden overflow-x-auto md:block">
          <table class="min-w-full divide-y divide-border text-sm">
            <thead class="bg-muted/40">
              <tr>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Owner</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Kind</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Email</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">BIR TIN</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Portal</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Statements</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Created</th>
                <th class="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              <template v-for="o in filtered" :key="o.id">
                <tr class="hover:bg-accent hover:text-accent-foreground">
                  <td class="px-3 py-2 font-medium text-foreground">
                    <NuxtLink
                      :to="`/admin/owners/${o.id}`"
                      class="hover:underline"
                    >
                      {{ ownerLabel(o) }}
                    </NuxtLink>
                  </td>
                  <td class="px-3 py-2 text-xs text-muted-foreground">
                    {{ ownerKind(o) }}
                  </td>
                  <td class="px-3 py-2 text-xs text-foreground">
                    {{ o.external_email || '—' }}
                  </td>
                  <td class="px-3 py-2 text-xs font-mono text-foreground">
                    {{ o.tax_id || '—' }}
                  </td>
                  <td class="px-3 py-2 text-xs">
                    <span
                      v-if="o.user_id"
                      class="inline-flex rounded-full bg-success/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-success"
                    >linked</span>
                    <span
                      v-else-if="invitationsByOwner[o.id]"
                      :class="['inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase', inviteStatusClass(invitationsByOwner[o.id]!.status)]"
                    >{{ invitationsByOwner[o.id]!.status }}</span>
                    <span v-else class="text-muted-foreground">—</span>
                  </td>
                  <td class="px-3 py-2 text-xs">
                    <span
                      :class="['inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase', statementPolicyBadgeClass(statementPolicyByOwner[o.id])]"
                      :title="statementPolicyByOwner[o.id] ? `next run ${new Date(statementPolicyByOwner[o.id]!.next_run_at).toLocaleDateString()}` : 'no auto-statement schedule'"
                    >{{ statementPolicyBadge(statementPolicyByOwner[o.id]) }}</span>
                  </td>
                  <td class="px-3 py-2 text-xs text-muted-foreground">
                    {{ new Date(o.created_at).toLocaleDateString() }}
                  </td>
                  <td class="px-3 py-2 text-right">
                    <div class="flex items-center justify-end gap-3">
                      <button
                        v-if="!o.user_id && (!invitationsByOwner[o.id] || invitationsByOwner[o.id]!.status !== 'active')"
                        type="button"
                        class="text-xs text-primary hover:underline"
                        @click="openInvite(o)"
                      >
                        {{ invitationsByOwner[o.id] ? 'Re-invite' : 'Invite' }}
                      </button>
                      <button
                        v-if="!o.user_id && invitationsByOwner[o.id] && invitationsByOwner[o.id]!.status === 'active'"
                        type="button"
                        class="text-xs text-destructive hover:underline"
                        @click="openRevoke(invitationsByOwner[o.id]!)"
                      >
                        Revoke
                      </button>
                      <button
                        type="button"
                        class="text-xs text-primary hover:underline"
                        @click="openStatementPolicyEditor(o)"
                      >
                        {{ statementPolicyByOwner[o.id] ? 'Edit schedule' : 'Schedule' }}
                      </button>
                      <button
                        v-if="statementPolicyByOwner[o.id]"
                        type="button"
                        :disabled="optingOutOfStatements"
                        class="text-xs text-destructive hover:underline disabled:opacity-60"
                        @click="optOutOfStatementsFor(o)"
                      >
                        Stop
                      </button>
                      <button
                        type="button"
                        class="text-xs text-primary hover:underline"
                        @click="editingId === o.id ? (editingId = null) : startEdit(o)"
                      >
                        {{ editingId === o.id ? 'Cancel' : 'Edit' }}
                      </button>
                    </div>
                  </td>
                </tr>
                <tr v-if="editingId === o.id" class="bg-primary/5">
                  <td colspan="8" class="px-3 py-3">
                    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      <label class="block">
                        <span class="block text-xs font-medium text-muted-foreground">Display name</span>
                        <input
                          v-model="editForm.external_name"
                          type="text"
                          maxlength="200"
                          class="mt-1 block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                        />
                      </label>
                      <label class="block">
                        <span class="block text-xs font-medium text-muted-foreground">Email</span>
                        <input
                          v-model="editForm.external_email"
                          type="email"
                          maxlength="254"
                          class="mt-1 block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                        />
                      </label>
                      <label class="block">
                        <span class="block text-xs font-medium text-muted-foreground">BIR TIN</span>
                        <input
                          v-model="editForm.tax_id"
                          type="text"
                          maxlength="40"
                          class="mt-1 block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                        />
                      </label>
                      <label class="block">
                        <span class="block text-xs font-medium text-muted-foreground">Notes</span>
                        <input
                          v-model="editForm.notes"
                          type="text"
                          maxlength="2000"
                          class="mt-1 block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                        />
                      </label>
                    </div>
                    <div class="mt-3 flex justify-end gap-2">
                      <button
                        type="button"
                        class="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground"
                        @click="editingId = null"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        :disabled="saving"
                        class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 focus-ring disabled:opacity-60"
                        @click="save"
                      >
                        <span v-if="saving">Saving…</span>
                        <span v-else>Save</span>
                      </button>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
          </div>
        </div>
      </section>

      <!-- Invite owner to portal — Phase 4 Operations primitive -->
      <UiModal
        :open="inviteModal"
        title="Invite owner to portal"
        subtitle="Sends a one-time link. Once accepted, the owner gets read access to their units, monthly statements, dues, and disbursements via the public site. The link is single-use and expires."
        width="md"
        @update:open="inviteModal = $event"
      >
        <template v-if="!issuedInvite">
          <div class="space-y-3">
            <div class="rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-muted-foreground">
              Inviting <strong class="text-foreground">{{ inviteOwner ? (inviteOwner.external_name || 'this owner') : '' }}</strong>
              <span v-if="inviteOwner?.external_email"> · {{ inviteOwner.external_email }}</span>
            </div>
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">Send to email</span>
              <input
                v-model="inviteForm.invite_email"
                type="email"
                maxlength="254"
                placeholder="owner@example.com"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
              <span class="mt-1 block text-[11px] text-muted-foreground">
                Defaults to the owner's recorded email.
              </span>
            </label>
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">Expires in (days)</span>
              <input
                v-model.number="inviteForm.expires_in_days"
                type="number"
                min="1"
                max="90"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>
          </div>
        </template>

        <template v-else>
          <div class="space-y-3">
            <div
              :class="[
                'rounded-md border px-3 py-2 text-xs',
                issuedInvite.email_delivered
                  ? 'border-success/30 bg-success/10 text-success'
                  : 'border-warning/30 bg-warning/10 text-warning',
              ]"
            >
              <strong class="font-semibold">
                {{ issuedInvite.email_delivered ? 'Email sent.' : 'Email NOT sent.' }}
              </strong>
              <span class="block">
                {{
                  issuedInvite.email_delivered
                    ? `An invitation went to ${issuedInvite.invite_email}.`
                    : `Resend isn't configured (or rejected the message). Copy the link below and deliver it manually.`
                }}
              </span>
            </div>
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">
                Single-use accept link (expires
                {{ new Date(issuedInvite.expires_at).toLocaleDateString() }})
              </span>
              <div class="mt-1 flex items-stretch gap-2">
                <input
                  :value="issuedInvite.accept_url"
                  readonly
                  class="block w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-xs text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
                  @focus="(e) => (e.target as HTMLInputElement).select()"
                />
                <button
                  type="button"
                  class="btn-secondary"
                  @click="copyInviteLink"
                >
                  {{ copyConfirm ? 'Copied ✓' : 'Copy' }}
                </button>
              </div>
              <span class="mt-1 block text-[11px] text-muted-foreground">
                This link is shown once. Closing this dialog discards it — issue a new invitation if you lose it.
              </span>
            </label>
          </div>
        </template>

        <template #footer>
          <div v-if="!issuedInvite" class="flex justify-end gap-2">
            <button
              type="button"
              class="btn-secondary"
              @click="inviteModal = false"
            >
              Cancel
            </button>
            <button
              type="button"
              :disabled="issuingInvite"
              class="btn-primary disabled:opacity-60"
              @click="issueInvite"
            >
              <span v-if="issuingInvite">Issuing…</span>
              <span v-else>Send invitation</span>
            </button>
          </div>
          <div v-else class="flex justify-end">
            <button
              type="button"
              class="btn-primary"
              @click="inviteModal = false"
            >
              Done
            </button>
          </div>
        </template>
      </UiModal>

      <!-- Owner statement schedule editor — Phase 4 Operations primitive -->
      <UiModal
        :open="statementPolicyModal"
        :title="`${statementPolicyOwner && statementPolicyByOwner[statementPolicyOwner.id] ? 'Edit' : 'Set up'} statement schedule`"
        subtitle="The daily cron at 05:30 UTC aggregates rent collected, dues collected, and vendor expenses across all units this owner holds, and creates an owner statement for the prior period. Saving atomically pauses any prior schedule."
        width="md"
        @update:open="statementPolicyModal = $event"
      >
        <div v-if="statementPolicyOwner" class="mb-3 rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-muted-foreground">
          For <strong class="text-foreground">{{ statementPolicyOwner.external_name || `Owner #${statementPolicyOwner.id.slice(0, 8)}…` }}</strong>
          <span v-if="statementPolicyOwner.external_email"> · {{ statementPolicyOwner.external_email }}</span>
        </div>
        <div class="space-y-3">
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">Cadence</span>
            <select
              v-model="statementPolicyForm.cadence"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            >
              <option value="monthly">Monthly (covers the prior month)</option>
              <option value="quarterly">Quarterly (covers the prior quarter)</option>
            </select>
          </label>
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">
              Fire day of period (1 - 28)
            </span>
            <input
              v-model.number="statementPolicyForm.fire_day_of_period"
              type="number"
              min="1"
              max="28"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
            <span class="mt-1 block text-[11px] text-muted-foreground">
              e.g., 1 = generate on the first day of each new period covering the period that just ended.
            </span>
          </label>
          <label class="flex items-start gap-2 text-sm text-foreground">
            <input
              v-model="statementPolicyForm.auto_issue"
              type="checkbox"
              class="mt-0.5 h-4 w-4 rounded border-border"
            />
            <span>
              Auto-issue. When off, statements stay in <code>draft</code>
              so an operator can review and adjust before issuing.
            </span>
          </label>
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">Notes (optional, audited)</span>
            <textarea
              v-model="statementPolicyForm.notes"
              rows="2"
              maxlength="500"
              placeholder="e.g., per management agreement, statements due on the 5th"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
          </label>
        </div>
        <template #footer>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="btn-secondary"
              @click="statementPolicyModal = false"
            >
              Cancel
            </button>
            <button
              type="button"
              :disabled="savingStatementPolicy"
              class="btn-primary disabled:opacity-60"
              @click="saveStatementPolicy"
            >
              <span v-if="savingStatementPolicy">Saving…</span>
              <span v-else>Save schedule</span>
            </button>
          </div>
        </template>
      </UiModal>

      <!-- Revoke invitation — Phase 4 Operations primitive (destructive tone) -->
      <UiModal
        :open="revokeModal"
        title="Revoke portal invitation"
        subtitle="The invitation link will stop working immediately. Use this if the email was sent to the wrong recipient."
        width="md"
        tone="destructive"
        @update:open="revokeModal = $event"
      >
        <label class="block">
          <span class="block text-xs font-medium text-muted-foreground">
            Reason (audited)
          </span>
          <textarea
            v-model="revokeReason"
            rows="3"
            maxlength="500"
            required
            placeholder="e.g., wrong email · duplicate · owner requested cancellation"
            class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-destructive focus:ring-2 focus:ring-destructive/30"
          />
        </label>
        <template #footer>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="btn-secondary"
              @click="revokeModal = false"
            >
              Cancel
            </button>
            <button
              type="button"
              :disabled="revoking"
              class="btn-destructive disabled:opacity-60"
              @click="revokeInvite"
            >
              <span v-if="revoking">Revoking…</span>
              <span v-else>Confirm revoke</span>
            </button>
          </div>
        </template>
      </UiModal>
    </template>
  </div>
</template>
