<script setup lang="ts">
/**
 * /admin/leases/:id — lease detail + lifecycle actions.
 *
 * Sections:
 *   - Header card: status, rent, term, unit
 *   - Parties: landlord(s), tenant(s), guarantor(s)
 *   - Charges feed (recent, from /api/leases/:id/charges)
 *   - Maintenance feed (recent, from /api/leases/:id/maintenance)
 *
 * Lifecycle actions in the header:
 *   - Activate (draft / pending_signature → active)
 *   - Terminate (any non-terminal → terminated)
 *   - Renew (active → creates child lease)
 *
 * RPC validation lives server-side; this page surfaces failures via toast.
 */

import { ref, computed, onMounted, reactive } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showToast } from '~/helpers/helpers'
import UiDrawer from '~/components/ui/UiDrawer.vue'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiCard from '~/components/ui/UiCard.vue'

definePageMeta({ layout: 'default' })
useHead({ title: 'Lease | Admin' })

type LeaseStatus =
  | 'draft'
  | 'pending_signature'
  | 'active'
  | 'expired'
  | 'terminated'
  | 'cancelled'

type Lease = {
  id: string
  unit_id: string
  listing_id: number | null
  deal_id: string | null
  source_document_draft_id: string | null
  signed_envelope_id: string | null
  parent_lease_id: string | null
  lease_type: string
  currency: string
  rent_minor: number
  rent_period: 'monthly' | 'quarterly' | 'annual'
  security_deposit_minor: number
  advance_rent_minor: number
  effective_at: string
  expires_at: string
  move_in_date: string | null
  move_out_date: string | null
  billing_day: number | null
  utilities_included: string[]
  house_rules: string | null
  status: LeaseStatus
  activated_at: string | null
  terminated_at: string | null
  termination_reason: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

type Party = {
  id: string
  role: 'landlord' | 'tenant' | 'guarantor' | 'co_signer' | 'agent'
  user_id: string | null
  contact_id: number | null
  external_name: string | null
  external_email: string | null
  share_pct: number | null
  is_primary: boolean
}

type Charge = {
  id: string
  charge_no: string
  kind: string
  total_minor: number
  currency: string
  status: 'draft' | 'open' | 'paid' | 'past_due' | 'void' | 'forgiven'
  due_at: string | null
  paid_at: string | null
  period_start: string | null
  period_end: string | null
  created_at: string
}

type MaintenanceRequest = {
  id: string
  request_no: string
  title: string
  category: string
  urgency: 'emergency' | 'high' | 'normal' | 'low'
  status: string
  reported_at: string
}

type PortalInvitationStatus = 'active' | 'accepted' | 'revoked' | 'expired'

type PortalInvitation = {
  id: string
  lease_party_id: string
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
  lease_party_id: string
  invite_email: string
  expires_at: string
  accept_url: string
  email_delivered: boolean
}

type TenantStatementPolicy = {
  id: string
  lease_id: string
  cadence: 'monthly' | 'quarterly'
  fire_day_of_period: number
  auto_issue: boolean
  status: 'active' | 'paused'
  next_run_at: string
  last_generated_period_start: string | null
  effective_at: string
  ended_at: string | null
  notes: string | null
  created_at: string
}

type TenantStatement = {
  id: string
  statement_no: string
  period_start: string
  period_end: string
  rent_billed_minor: number
  other_charges_minor: number
  payments_received_minor: number
  balance_due_minor: number
  status: 'draft' | 'issued' | 'paid' | 'overdue' | 'void'
  issued_at: string | null
  due_at: string | null
  paid_at: string | null
  currency: string
}

type InspectionKind = 'move_in' | 'move_out' | 'mid_tenancy' | 'maintenance' | 'annual'
type InspectionStatus = 'scheduled' | 'in_progress' | 'completed' | 'tenant_signed' | 'cancelled'

type Inspection = {
  id: string
  inspection_no: string
  inspection_kind: InspectionKind
  status: InspectionStatus
  inspector_user_id: string | null
  inspector_external_name: string | null
  scheduled_at: string | null
  conducted_at: string | null
  overall_condition: 'excellent' | 'good' | 'fair' | 'poor' | 'unhabitable' | null
  total_damage_estimate_minor: number
  tenant_signed_at: string | null
  summary_notes: string | null
  created_at: string
}

type LateFeePolicy = {
  id: string
  lease_id: string
  currency: string
  grace_days: number
  fee_kind: 'flat' | 'percent_of_balance' | 'escalating'
  flat_amount_minor: number | null
  percent_value: number | null
  cap_minor: number | null
  recurrence_kind: 'once' | 'recurring'
  recurrence_days: number | null
  status: 'active' | 'paused'
  effective_at: string
  ended_at: string | null
  notes: string | null
  created_at: string
}

const route = useRoute()
const router = useRouter() // still used by renew() for router.push
const id = computed(() => String(route.params.id ?? ''))

// Access check is handled by AdminPageShell via the `permission` prop;
// no inline isChecking / allowed needed.

const lease = ref<Lease | null>(null)
const parties = ref<Party[]>([])
const charges = ref<Charge[]>([])
const maintenance = ref<MaintenanceRequest[]>([])
const loading = ref(true)

// Lifecycle action state
const acting = ref<'activate' | 'terminate' | 'renew' | null>(null)
const terminateReason = ref('')
const terminateModal = ref(false)
const renewModal = ref(false)
const renewForm = ref({
  effective_at: '',
  expires_at: '',
  rent_minor: 0,
})

// Add-party modal
const addPartyModal = ref(false)
const partyForm = reactive({
  role: 'tenant' as 'landlord' | 'tenant' | 'guarantor' | 'co_signer' | 'agent',
  external_name: '',
  external_email: '',
  is_primary: false,
})
const addingParty = ref(false)

// Tenant portal invitation state — keyed by lease_party_id, holds the
// most recent (any status) invitation. Drives the per-party badge +
// "Invite to portal" / "Revoke" actions on the Parties section.
const invitationsByParty = ref<Record<string, PortalInvitation | null>>({})
const loadingInvitations = ref(false)

// Issue / revoke modal state.
const inviteModal = ref(false)
const inviteParty = ref<Party | null>(null)
const inviteForm = reactive({
  invite_email: '',
  expires_in_days: 14,
})
const issuingInvite = ref(false)
// Result from a successful issue: holds the cleartext accept_url so the
// admin can copy if email delivery is off / failed. Cleared on modal close.
const issuedInvite = ref<IssuedInvitation | null>(null)
const copyConfirm = ref(false)

const revokeModal = ref(false)
const revokeTarget = ref<PortalInvitation | null>(null)
const revokeReason = ref('')
const revoking = ref(false)

// Tenant statement policy + recent statements state.
const statementPolicy = ref<TenantStatementPolicy | null>(null)
const loadingStatementPolicy = ref(false)
const statements = ref<TenantStatement[]>([])
const statementPolicyModal = ref(false)
const statementPolicyForm = reactive({
  cadence: 'monthly' as 'monthly' | 'quarterly',
  fire_day_of_period: 1,
  auto_issue: false,
  notes: '',
})
const savingStatementPolicy = ref(false)
const optingOutOfStatements = ref(false)
const generatingStatements = ref(false)

// Inspections list + schedule modal state.
const inspections = ref<Inspection[]>([])
const loadingInspections = ref(false)
const scheduleInspectionModal = ref(false)
// Renamed from `scheduleForm` to avoid colliding with the pre-existing
// rent-schedule modal's form (also called `scheduleForm`).
const inspectionScheduleForm = reactive({
  inspection_kind: 'move_in' as InspectionKind,
  scheduled_at: '',
  inspector_external_name: '',
  summary_notes: '',
})
const schedulingInspection = ref(false)

// Late-fee policy editor state.
const lateFeePolicy = ref<LateFeePolicy | null>(null)
const loadingPolicy = ref(false)
const policyModal = ref(false)
const policyForm = reactive({
  fee_kind: 'flat' as 'flat' | 'percent_of_balance' | 'escalating',
  flat_amount_minor: 0,
  percent_value: 5,
  cap_minor: null as number | null,
  grace_days: 5,
  recurrence_kind: 'once' as 'once' | 'recurring',
  recurrence_days: 7,
  notes: '',
})
const savingPolicy = ref(false)
const optingOut = ref(false)
const assessingNow = ref(false)

// Add-rent-schedule modal
const addScheduleModal = ref(false)
const scheduleForm = reactive({
  amount_minor: 0,
  period: 'monthly' as 'monthly' | 'quarterly' | 'annual',
  billing_day: 1,
  next_due_at: '',
  auto_generate: true,
})
const addingSchedule = ref(false)

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ lease: Lease; parties: Party[] }>(
      `/api/leases/${id.value}`,
    )
    lease.value = res.lease
    parties.value = res.parties ?? []

    // Side fetches — all fail-soft, page still renders if any fail.
    const [chargesRes, mntRes] = await Promise.allSettled([
      $fetch<{ items: Charge[] }>(`/api/leases/${id.value}/charges`),
      $fetch<{ items: MaintenanceRequest[] }>(`/api/leases/${id.value}/maintenance`),
    ])
    if (chargesRes.status === 'fulfilled') charges.value = chargesRes.value.items ?? []
    if (mntRes.status === 'fulfilled') maintenance.value = mntRes.value.items ?? []

    // Portal invitation status per tenant party — never blocks page render.
    void loadInvitations()
    void loadLateFeePolicy()
    void loadStatementPolicy()
    void loadStatements()
    void loadInspections()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Could not load lease',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}

async function loadInvitations() {
  // Tenant parties only — landlords / agents / etc. don't get portal invites.
  const tenantParties = parties.value.filter((p) => p.role === 'tenant')
  if (tenantParties.length === 0) {
    invitationsByParty.value = {}
    return
  }
  loadingInvitations.value = true
  // Parallel fetches by lease_party_id. Small N (1-3 typically), so this
  // is fine; if a future lease ever has many tenant parties we can swap
  // to a single batch endpoint.
  try {
    const results = await Promise.all(
      tenantParties.map(async (p) => {
        try {
          const res = await $fetch<{ rows: PortalInvitation[] }>(
            `/api/admin/tenant-portal-invitations`,
            { query: { lease_party_id: p.id, limit: 1 } },
          )
          return [p.id, res.rows?.[0] ?? null] as const
        } catch {
          return [p.id, null] as const
        }
      }),
    )
    const next: Record<string, PortalInvitation | null> = {}
    for (const [partyId, row] of results) next[partyId] = row
    invitationsByParty.value = next
  } finally {
    loadingInvitations.value = false
  }
}

function openInvite(party: Party) {
  inviteParty.value = party
  inviteForm.invite_email = party.external_email ?? ''
  inviteForm.expires_in_days = 14
  issuedInvite.value = null
  copyConfirm.value = false
  inviteModal.value = true
}

async function issueInvite() {
  if (!inviteParty.value) return
  const email = inviteForm.invite_email.trim()
  if (!email) {
    showToast({ title: 'Email is required', icon: 'warning' })
    return
  }
  issuingInvite.value = true
  try {
    const res = await $fetch<IssuedInvitation>(
      '/api/admin/tenant-portal-invitations',
      {
        method: 'POST',
        body: {
          lease_party_id: inviteParty.value.id,
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
    // Refresh the per-party badge in the background. Don't await — the
    // post-issue panel is already showing the cleartext accept_url which
    // is what the operator needs right now.
    void loadInvitations()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Could not issue invitation',
      icon: 'error',
    })
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
    showToast({
      title: 'Could not copy — select the link and copy manually',
      icon: 'warning',
    })
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
      `/api/admin/tenant-portal-invitations/${revokeTarget.value.id}/revoke`,
      { method: 'POST', body: { reason } },
    )
    showToast({ title: 'Invitation revoked' })
    revokeModal.value = false
    void loadInvitations()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Could not revoke invitation',
      icon: 'error',
    })
  } finally {
    revoking.value = false
  }
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

async function loadLateFeePolicy() {
  loadingPolicy.value = true
  try {
    const res = await $fetch<{ policy: LateFeePolicy | null }>(
      `/api/admin/leases/${id.value}/late-fee-policy`,
    )
    lateFeePolicy.value = res.policy
  } catch {
    // Fail silent — section just shows empty state.
    lateFeePolicy.value = null
  } finally {
    loadingPolicy.value = false
  }
}

function openPolicyEditor() {
  // Pre-fill from current policy or sensible defaults.
  const p = lateFeePolicy.value
  policyForm.fee_kind = p?.fee_kind ?? 'flat'
  policyForm.flat_amount_minor = p?.flat_amount_minor ?? 50000 // ₱500 default
  policyForm.percent_value = Number(p?.percent_value ?? 5)
  policyForm.cap_minor = p?.cap_minor ?? null
  policyForm.grace_days = p?.grace_days ?? 5
  policyForm.recurrence_kind = p?.recurrence_kind ?? 'once'
  policyForm.recurrence_days = p?.recurrence_days ?? 7
  policyForm.notes = p?.notes ?? ''
  policyModal.value = true
}

async function savePolicy() {
  savingPolicy.value = true
  try {
    // Strip irrelevant fields per fee_kind so the server-side refine()
    // sees a coherent shape instead of redundant nulls.
    const payload: Record<string, unknown> = {
      fee_kind: policyForm.fee_kind,
      cap_minor: policyForm.cap_minor || null,
      grace_days: policyForm.grace_days,
      recurrence_kind: policyForm.recurrence_kind,
      notes: policyForm.notes.trim() || null,
    }
    if (policyForm.fee_kind === 'percent_of_balance') {
      payload.percent_value = policyForm.percent_value
    } else {
      payload.flat_amount_minor = policyForm.flat_amount_minor
    }
    if (policyForm.recurrence_kind === 'recurring') {
      payload.recurrence_days = policyForm.recurrence_days
    }

    const res = await $fetch<{ policy: LateFeePolicy }>(
      `/api/admin/leases/${id.value}/late-fee-policy`,
      { method: 'PUT', body: payload },
    )
    lateFeePolicy.value = res.policy
    showToast({ title: 'Late-fee policy saved' })
    policyModal.value = false
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Could not save policy',
      icon: 'error',
    })
  } finally {
    savingPolicy.value = false
  }
}

async function optOutOfLateFees() {
  if (!lateFeePolicy.value) return
  if (!confirm('Pause the active late-fee policy on this lease? Past assessments are kept; new assessments stop until you re-enable.')) return
  optingOut.value = true
  try {
    await $fetch(`/api/admin/leases/${id.value}/late-fee-policy`, {
      method: 'DELETE',
    })
    lateFeePolicy.value = null
    showToast({ title: 'Late-fee policy ended' })
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Could not end policy',
      icon: 'error',
    })
  } finally {
    optingOut.value = false
  }
}

async function assessLateFeesNow() {
  assessingNow.value = true
  try {
    const res = await $fetch<{
      run_id: string
      charges_flipped_to_past_due: number
      late_fees_created: number
      late_fees_skipped: number
      errors: number
    }>('/api/admin/late-fee/assess', {
      method: 'POST',
      body: {},
    })
    showToast({
      title: `Assessment done: ${res.late_fees_created} fee(s) created, ${res.charges_flipped_to_past_due} charge(s) flipped past_due${res.errors ? `, ${res.errors} error(s)` : ''}`,
    })
    // Charges feed refresh — new late_fee charges may now be visible.
    await load()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Assessment failed',
      icon: 'error',
    })
  } finally {
    assessingNow.value = false
  }
}

async function loadStatementPolicy() {
  loadingStatementPolicy.value = true
  try {
    const res = await $fetch<{ policy: TenantStatementPolicy | null }>(
      `/api/admin/leases/${id.value}/tenant-statement-policy`,
    )
    statementPolicy.value = res.policy
  } catch {
    statementPolicy.value = null
  } finally {
    loadingStatementPolicy.value = false
  }
}

async function loadStatements() {
  try {
    const res = await $fetch<{ items: TenantStatement[] }>(
      `/api/leases/${id.value}/statements`,
    )
    statements.value = res.items ?? []
  } catch {
    statements.value = []
  }
}

function openStatementPolicyEditor() {
  const p = statementPolicy.value
  statementPolicyForm.cadence = p?.cadence ?? 'monthly'
  statementPolicyForm.fire_day_of_period = p?.fire_day_of_period ?? 1
  statementPolicyForm.auto_issue = p?.auto_issue ?? false
  statementPolicyForm.notes = p?.notes ?? ''
  statementPolicyModal.value = true
}

async function saveStatementPolicy() {
  savingStatementPolicy.value = true
  try {
    const res = await $fetch<{ policy: TenantStatementPolicy }>(
      `/api/admin/leases/${id.value}/tenant-statement-policy`,
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
    statementPolicy.value = res.policy
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

async function optOutOfStatements() {
  if (!statementPolicy.value) return
  if (!confirm('Pause auto-statements for this lease? Past-issued statements remain; new statements stop being generated.')) return
  optingOutOfStatements.value = true
  try {
    await $fetch(`/api/admin/leases/${id.value}/tenant-statement-policy`, {
      method: 'DELETE',
    })
    statementPolicy.value = null
    showToast({ title: 'Statement schedule ended' })
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Could not end schedule',
      icon: 'error',
    })
  } finally {
    optingOutOfStatements.value = false
  }
}

async function generateStatementsNow() {
  generatingStatements.value = true
  try {
    const res = await $fetch<{
      run_id: string
      policies_processed: number
      statements_created: number
      skipped: number
      errors: number
    }>('/api/admin/tenant-statements/generate', {
      method: 'POST',
      body: {},
    })
    showToast({
      title: `Generation done: ${res.statements_created} created, ${res.skipped} skipped${res.errors ? `, ${res.errors} error(s)` : ''}`,
    })
    await loadStatements()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Generation failed',
      icon: 'error',
    })
  } finally {
    generatingStatements.value = false
  }
}

function statementPolicySummary(p: TenantStatementPolicy): string {
  const cadenceLabel = p.cadence === 'monthly' ? 'monthly' : 'quarterly'
  const fireDay = p.fire_day_of_period === 1 ? 'first day' : `day ${p.fire_day_of_period}`
  const issuance = p.auto_issue ? 'auto-issued' : 'left as draft'
  return `${cadenceLabel} on ${fireDay} of period · ${issuance} · next run ${new Date(p.next_run_at).toLocaleDateString()}`
}

function statementStatusClass(s: TenantStatement['status']): string {
  switch (s) {
    case 'draft':
      return 'bg-muted text-muted-foreground'
    case 'issued':
      return 'bg-primary/15 text-primary'
    case 'paid':
      return 'bg-success/15 text-success'
    case 'overdue':
      return 'bg-destructive/15 text-destructive'
    case 'void':
      return 'bg-muted text-muted-foreground'
  }
}

async function loadInspections() {
  loadingInspections.value = true
  try {
    const res = await $fetch<{ items: Inspection[] }>(
      `/api/leases/${id.value}/inspections`,
    )
    inspections.value = res.items ?? []
  } catch {
    inspections.value = []
  } finally {
    loadingInspections.value = false
  }
}

function openScheduleInspection() {
  inspectionScheduleForm.inspection_kind = 'move_in'
  inspectionScheduleForm.scheduled_at = ''
  inspectionScheduleForm.inspector_external_name = ''
  inspectionScheduleForm.summary_notes = ''
  scheduleInspectionModal.value = true
}

async function scheduleInspection() {
  schedulingInspection.value = true
  try {
    const payload: Record<string, unknown> = {
      inspection_kind: inspectionScheduleForm.inspection_kind,
    }
    if (inspectionScheduleForm.scheduled_at) {
      // Convert local datetime-local string to ISO.
      payload.scheduled_at = new Date(inspectionScheduleForm.scheduled_at).toISOString()
    }
    if (inspectionScheduleForm.inspector_external_name.trim()) {
      payload.inspector_external_name = inspectionScheduleForm.inspector_external_name.trim()
    }
    if (inspectionScheduleForm.summary_notes.trim()) {
      payload.summary_notes = inspectionScheduleForm.summary_notes.trim()
    }

    await $fetch(`/api/leases/${id.value}/inspections`, {
      method: 'POST',
      body: payload,
    })
    showToast({ title: 'Inspection scheduled' })
    scheduleInspectionModal.value = false
    await loadInspections()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Could not schedule inspection',
      icon: 'error',
    })
  } finally {
    schedulingInspection.value = false
  }
}

function inspectionKindLabel(k: InspectionKind): string {
  return k.replace('_', '-')
}

function inspectionStatusClass(s: InspectionStatus): string {
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

function policySummary(p: LateFeePolicy): string {
  const parts: string[] = []
  if (p.fee_kind === 'flat') {
    parts.push(`Flat ${formatPHP(p.flat_amount_minor ?? 0, p.currency)}`)
  } else if (p.fee_kind === 'percent_of_balance') {
    parts.push(`${p.percent_value}% of unpaid balance`)
  } else {
    parts.push(`Escalating ${formatPHP(p.flat_amount_minor ?? 0, p.currency)}`)
  }
  if (p.cap_minor) parts.push(`capped at ${formatPHP(p.cap_minor, p.currency)}`)
  parts.push(`after ${p.grace_days}d grace`)
  if (p.recurrence_kind === 'recurring') {
    parts.push(`recurring every ${p.recurrence_days}d`)
  }
  return parts.join(' · ')
}

async function activate() {
  if (!lease.value) return
  acting.value = 'activate'
  try {
    await $fetch(`/api/leases/${id.value}/activate`, { method: 'POST' })
    showToast({ title: 'Lease activated' })
    await load()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Activation failed',
      icon: 'error',
    })
  } finally {
    acting.value = null
  }
}

async function terminate() {
  if (!lease.value) return
  if (terminateReason.value.trim().length < 1) {
    showToast({ title: 'Reason is required', icon: 'warning' })
    return
  }
  acting.value = 'terminate'
  try {
    await $fetch(`/api/leases/${id.value}/terminate`, {
      method: 'POST',
      body: { reason: terminateReason.value.trim() },
    })
    showToast({ title: 'Lease terminated' })
    terminateModal.value = false
    terminateReason.value = ''
    await load()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Termination failed',
      icon: 'error',
    })
  } finally {
    acting.value = null
  }
}

async function renew() {
  if (!lease.value) return
  if (
    !renewForm.value.effective_at ||
    !renewForm.value.expires_at ||
    renewForm.value.rent_minor <= 0
  ) {
    showToast({ title: 'All renewal fields are required', icon: 'warning' })
    return
  }
  acting.value = 'renew'
  try {
    const res = await $fetch<{ new_lease_id: string }>(
      `/api/leases/${id.value}/renew`,
      {
        method: 'POST',
        body: {
          effective_at: new Date(renewForm.value.effective_at).toISOString(),
          expires_at: new Date(renewForm.value.expires_at).toISOString(),
          rent_minor: renewForm.value.rent_minor,
        },
      },
    )
    showToast({ title: 'Lease renewed — child lease created in draft' })
    renewModal.value = false
    if (res?.new_lease_id) {
      router.push(`/admin/leases/${res.new_lease_id}`)
    } else {
      await load()
    }
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Renewal failed',
      icon: 'error',
    })
  } finally {
    acting.value = null
  }
}

const canActivate = computed(
  () => lease.value?.status === 'draft' || lease.value?.status === 'pending_signature',
)
const canTerminate = computed(
  () =>
    lease.value &&
    !['terminated', 'expired', 'cancelled', 'void'].includes(lease.value.status),
)
const canRenew = computed(() => lease.value?.status === 'active')

// Parties + rent schedules can be added while the lease is mutable.
// Server enforces this strictly via lease_parties RLS (draft only)
// and via rent_schedules manage policy.
const canAddParty = computed(
  () => lease.value?.status === 'draft' || lease.value?.status === 'pending_signature',
)
const canAddSchedule = computed(
  () => lease.value?.status === 'draft' ||
       lease.value?.status === 'pending_signature' ||
       lease.value?.status === 'active',
)

async function addParty() {
  if (!lease.value) return
  if (!partyForm.external_name.trim() && !partyForm.external_email.trim()) {
    showToast({ title: 'Add at least a name or email', icon: 'warning' })
    return
  }
  addingParty.value = true
  try {
    await $fetch(`/api/leases/${id.value}/parties`, {
      method: 'POST',
      body: {
        role: partyForm.role,
        external_name: partyForm.external_name.trim() || null,
        external_email: partyForm.external_email.trim() || null,
        is_primary: partyForm.is_primary,
      },
    })
    showToast({ title: 'Party added' })
    addPartyModal.value = false
    Object.assign(partyForm, {
      role: 'tenant',
      external_name: '',
      external_email: '',
      is_primary: false,
    })
    await load()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not add party', icon: 'error' })
  } finally {
    addingParty.value = false
  }
}

async function addSchedule() {
  if (!lease.value) return
  if (scheduleForm.amount_minor <= 0) {
    showToast({ title: 'Amount must be greater than zero', icon: 'warning' })
    return
  }
  if (!scheduleForm.next_due_at) {
    showToast({ title: 'Pick a first due date', icon: 'warning' })
    return
  }
  addingSchedule.value = true
  try {
    await $fetch(`/api/leases/${id.value}/rent-schedule`, {
      method: 'POST',
      body: {
        amount_minor: scheduleForm.amount_minor,
        period: scheduleForm.period,
        billing_day: scheduleForm.billing_day,
        next_due_at: scheduleForm.next_due_at,
        auto_generate: scheduleForm.auto_generate,
      },
    })
    showToast({ title: 'Rent schedule created' })
    addScheduleModal.value = false
    Object.assign(scheduleForm, {
      amount_minor: 0,
      period: 'monthly',
      billing_day: 1,
      next_due_at: '',
      auto_generate: true,
    })
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not create schedule', icon: 'error' })
  } finally {
    addingSchedule.value = false
  }
}

function formatPHP(minor: number, currency = 'PHP') {
  return (minor / 100).toLocaleString('en-PH', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  })
}

function statusClass(s: LeaseStatus) {
  switch (s) {
    case 'active':
      return 'bg-success/15 text-success'
    case 'expired':
      return 'bg-muted text-muted-foreground'
    case 'draft':
      return 'bg-primary/15 text-primary'
    case 'pending_signature':
      return 'bg-warning/15 text-warning'
    case 'terminated':
      return 'bg-destructive/15 text-destructive'
    case 'cancelled':
      return 'bg-muted text-muted-foreground'
  }
}

function chargeStatusClass(s: string) {
  if (s === 'paid') return 'text-success'
  if (s === 'past_due') return 'text-destructive'
  if (s === 'void' || s === 'forgiven') return 'text-muted-foreground'
  return 'text-foreground'
}

function urgencyClass(u: string) {
  if (u === 'emergency') return 'bg-destructive/15 text-destructive'
  if (u === 'high') return 'bg-warning/15 text-warning'
  if (u === 'normal') return 'bg-primary/15 text-primary'
  return 'bg-muted text-muted-foreground'
}

// Access check is handled by AdminPageShell via the `permission` prop.
onMounted(async () => {
  await load()
  if (lease.value) {
    renewForm.value.rent_minor = lease.value.rent_minor
    const now = new Date(lease.value.expires_at)
    renewForm.value.effective_at = now.toISOString().slice(0, 10)
    const oneYear = new Date(now)
    oneYear.setFullYear(oneYear.getFullYear() + 1)
    renewForm.value.expires_at = oneYear.toISOString().slice(0, 10)
  }
})
</script>

<template>
  <AdminPageShell :permission="['leases.manage', 'admin.access']" max-width="6xl">
    <NuxtLink
      to="/admin/leases"
      class="inline-flex items-center gap-1 text-meta hover:text-foreground"
    >
      <span aria-hidden="true">←</span>
      Back to all leases
    </NuxtLink>

    <UiCard v-if="loading" variant="surface" padding="lg">
      <div class="text-center text-meta">Loading…</div>
    </UiCard>

      <template v-else-if="lease">
        <!-- Header card -->
        <UiCard variant="surface" padding="md">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div class="mb-2 flex items-center gap-2">
                <span
                  :class="['inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium', statusClass(lease.status)]"
                >{{ lease.status.replace('_', ' ') }}</span>
                <span class="text-xs uppercase tracking-wide text-muted-foreground">{{ lease.lease_type }}</span>
              </div>
              <h1 class="text-page-title">
                {{ formatPHP(lease.rent_minor, lease.currency) }}
                <span class="text-sm font-normal text-muted-foreground">
                  / {{ lease.rent_period }}
                </span>
              </h1>
              <p class="mt-1 text-sm text-muted-foreground">
                {{ new Date(lease.effective_at).toLocaleDateString() }} →
                {{ new Date(lease.expires_at).toLocaleDateString() }}
                <span v-if="lease.billing_day" class="text-muted-foreground">
                  · billed day {{ lease.billing_day }}
                </span>
              </p>
              <p class="mt-2 font-mono text-[11px] text-muted-foreground/70">
                Unit {{ lease.unit_id.slice(0, 8) }}…
                <span v-if="lease.parent_lease_id">
                  · renewed from {{ lease.parent_lease_id.slice(0, 8) }}…
                </span>
              </p>
            </div>

            <!-- Action buttons -->
            <div class="flex flex-wrap gap-2">
              <button
                v-if="canActivate"
                type="button"
                :disabled="acting !== null"
                class="inline-flex items-center rounded-lg bg-success px-3 py-2 text-sm font-semibold text-success-foreground shadow hover:bg-success/90 disabled:opacity-60"
                @click="activate"
              >
                <span v-if="acting === 'activate'">Activating…</span>
                <span v-else>Activate</span>
              </button>
              <button
                v-if="canRenew"
                type="button"
                :disabled="acting !== null"
                class="inline-flex items-center rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground shadow hover:bg-primary/90 disabled:opacity-60"
                @click="renewModal = true"
              >
                Renew
              </button>
              <button
                v-if="canTerminate"
                type="button"
                :disabled="acting !== null"
                class="inline-flex items-center rounded-lg border border-destructive/40 bg-background px-3 py-2 text-sm font-semibold text-destructive shadow hover:bg-destructive/10 disabled:opacity-60"
                @click="terminateModal = true"
              >
                Terminate
              </button>
            </div>
          </div>

          <!-- Money breakdown -->
          <dl class="mt-5 grid grid-cols-2 gap-4 border-t border-border pt-4 sm:grid-cols-4 ">
            <div>
              <dt class="text-xs text-muted-foreground">Security deposit</dt>
              <dd class="font-medium text-foreground">
                {{ formatPHP(lease.security_deposit_minor, lease.currency) }}
              </dd>
            </div>
            <div>
              <dt class="text-xs text-muted-foreground">Advance rent</dt>
              <dd class="font-medium text-foreground">
                {{ formatPHP(lease.advance_rent_minor, lease.currency) }}
              </dd>
            </div>
            <div>
              <dt class="text-xs text-muted-foreground">Move-in</dt>
              <dd class="text-foreground">
                {{ lease.move_in_date ? new Date(lease.move_in_date).toLocaleDateString() : '—' }}
              </dd>
            </div>
            <div>
              <dt class="text-xs text-muted-foreground">Activated</dt>
              <dd class="text-foreground">
                {{ lease.activated_at ? new Date(lease.activated_at).toLocaleDateString() : '—' }}
              </dd>
            </div>
          </dl>
        </UiCard>

        <!-- Parties -->
        <UiCard variant="surface" padding="md">
          <div class="mb-3 flex items-center justify-between">
            <h2 class="text-base font-semibold text-foreground">
              Parties
              <span class="text-xs font-normal text-muted-foreground">({{ parties.length }})</span>
            </h2>
            <button
              v-if="canAddParty"
              type="button"
              class="text-xs text-primary hover:underline"
              @click="addPartyModal = true"
            >
              + Add party
            </button>
          </div>
          <div v-if="parties.length === 0" class="text-sm text-muted-foreground">
            No parties on this lease yet. Add at least one landlord and one tenant before
            activation.
          </div>
          <ul v-else class="space-y-2">
            <li
              v-for="p in parties"
              :key="p.id"
              class="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
            >
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="text-sm font-medium text-foreground">
                    {{ p.external_name || (p.user_id ? `User ${p.user_id.slice(0, 8)}…` : 'Unnamed party') }}
                  </span>
                  <span
                    v-if="p.is_primary"
                    class="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-primary"
                  >primary</span>
                  <!-- Portal binding badge (tenants only). Three states:
                       1. Already bound (lease_parties.user_id set)
                       2. An invitation exists (active / accepted / expired / revoked)
                       3. No invite yet -->
                  <template v-if="p.role === 'tenant'">
                    <span
                      v-if="p.user_id"
                      class="rounded-full bg-success/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-success"
                    >portal · linked</span>
                    <span
                      v-else-if="invitationsByParty[p.id]"
                      :class="['rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase', inviteStatusClass(invitationsByParty[p.id]!.status)]"
                    >portal · {{ invitationsByParty[p.id]!.status }}</span>
                    <span
                      v-else-if="!loadingInvitations"
                      class="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground"
                    >portal · not invited</span>
                  </template>
                </div>
                <p class="text-xs text-muted-foreground">
                  <span class="capitalize">{{ p.role.replace('_', ' ') }}</span>
                  <span v-if="p.external_email"> · {{ p.external_email }}</span>
                  <span v-if="p.share_pct"> · {{ p.share_pct }}%</span>
                  <span
                    v-if="p.role === 'tenant' && invitationsByParty[p.id]"
                    class="text-muted-foreground/70"
                  >
                    · invite expires
                    {{ new Date(invitationsByParty[p.id]!.expires_at).toLocaleDateString() }}
                  </span>
                </p>
              </div>
              <div v-if="p.role === 'tenant' && !p.user_id" class="flex flex-shrink-0 items-center gap-2">
                <button
                  v-if="!invitationsByParty[p.id] || invitationsByParty[p.id]!.status !== 'active'"
                  type="button"
                  class="rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground focus-ring"
                  @click="openInvite(p)"
                >
                  {{ invitationsByParty[p.id] ? 'Re-invite' : 'Invite to portal' }}
                </button>
                <button
                  v-if="invitationsByParty[p.id] && invitationsByParty[p.id]!.status === 'active'"
                  type="button"
                  class="rounded-lg border border-destructive/40 px-2.5 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10 focus-ring"
                  @click="openRevoke(invitationsByParty[p.id]!)"
                >
                  Revoke
                </button>
              </div>
            </li>
          </ul>
        </UiCard>

        <!-- Charges feed -->
        <UiCard variant="surface" padding="md">
          <div class="mb-3 flex items-center justify-between">
            <h2 class="text-base font-semibold text-foreground">
              Charges
              <span class="text-xs font-normal text-muted-foreground">({{ charges.length }})</span>
            </h2>
            <button
              v-if="canAddSchedule"
              type="button"
              class="text-xs text-primary hover:underline"
              @click="addScheduleModal = true"
            >
              + Set up rent schedule
            </button>
          </div>
          <div v-if="charges.length === 0" class="text-sm text-muted-foreground">
            No charges yet. Set up a rent schedule to start auto-billing.
          </div>
          <div v-else class="overflow-x-auto">
          <table class="min-w-full divide-y divide-border text-sm">
            <thead class="bg-muted/40">
              <tr>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Charge</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Kind</th>
                <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Amount</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Due</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              <tr v-for="c in charges.slice(0, 12)" :key="c.id">
                <td class="px-3 py-2 font-mono text-xs">{{ c.charge_no }}</td>
                <td class="px-3 py-2 text-xs text-muted-foreground">{{ c.kind }}</td>
                <td class="px-3 py-2 text-right tabular-nums">{{ formatPHP(c.total_minor, c.currency) }}</td>
                <td class="px-3 py-2 text-xs capitalize" :class="chargeStatusClass(c.status)">{{ c.status.replace('_', ' ') }}</td>
                <td class="px-3 py-2 text-xs text-muted-foreground">
                  {{ c.due_at ? new Date(c.due_at).toLocaleDateString() : '—' }}
                </td>
              </tr>
            </tbody>
          </table>
          </div>
        </UiCard>

        <!-- Late-fee policy -->
        <UiCard variant="surface" padding="md">
          <div class="mb-3 flex items-center justify-between gap-3">
            <h2 class="text-base font-semibold text-foreground">
              Late-fee policy
              <span
                v-if="lateFeePolicy"
                class="ml-1 rounded-full bg-success/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-success"
              >active</span>
              <span
                v-else
                class="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground"
              >off</span>
            </h2>
            <div class="flex items-center gap-2">
              <button
                v-if="lateFeePolicy"
                type="button"
                :disabled="assessingNow"
                class="rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground focus-ring disabled:opacity-60"
                @click="assessLateFeesNow"
                :title="'Run the daily assessment cron now (idempotent)'"
              >
                <span v-if="assessingNow">Running…</span>
                <span v-else>Apply now</span>
              </button>
              <button
                type="button"
                class="text-xs text-primary hover:underline"
                @click="openPolicyEditor"
              >
                {{ lateFeePolicy ? 'Edit policy' : '+ Set up late-fee policy' }}
              </button>
              <button
                v-if="lateFeePolicy"
                type="button"
                :disabled="optingOut"
                class="text-xs text-destructive hover:underline disabled:opacity-60"
                @click="optOutOfLateFees"
              >
                Opt out
              </button>
            </div>
          </div>
          <div v-if="loadingPolicy" class="text-sm text-muted-foreground">
            Loading…
          </div>
          <div v-else-if="!lateFeePolicy" class="text-sm text-muted-foreground">
            No policy attached. Tenants on this lease will not accrue late fees
            even if charges go past due. Click <em>Set up late-fee policy</em>
            to opt in.
          </div>
          <div v-else>
            <p class="text-sm text-foreground">{{ policySummary(lateFeePolicy) }}</p>
            <p v-if="lateFeePolicy.notes" class="mt-1 text-xs text-muted-foreground">
              {{ lateFeePolicy.notes }}
            </p>
            <p class="mt-2 text-[11px] text-muted-foreground/70">
              Effective {{ new Date(lateFeePolicy.effective_at).toLocaleDateString() }}
              · daily cron at 04:00 UTC
              · idempotent (safe to re-run via Apply now)
            </p>
          </div>
        </UiCard>

        <!-- Statement schedule -->
        <UiCard variant="surface" padding="md">
          <div class="mb-3 flex items-center justify-between gap-3">
            <h2 class="text-base font-semibold text-foreground">
              Statement schedule
              <span
                v-if="statementPolicy"
                class="ml-1 rounded-full bg-success/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-success"
              >active</span>
              <span
                v-else
                class="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground"
              >off</span>
            </h2>
            <div class="flex items-center gap-2">
              <button
                v-if="statementPolicy"
                type="button"
                :disabled="generatingStatements"
                class="rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground focus-ring disabled:opacity-60"
                @click="generateStatementsNow"
                :title="'Run the daily generation cron now (idempotent)'"
              >
                <span v-if="generatingStatements">Running…</span>
                <span v-else>Generate now</span>
              </button>
              <button
                type="button"
                class="text-xs text-primary hover:underline"
                @click="openStatementPolicyEditor"
              >
                {{ statementPolicy ? 'Edit schedule' : '+ Set up auto-statements' }}
              </button>
              <button
                v-if="statementPolicy"
                type="button"
                :disabled="optingOutOfStatements"
                class="text-xs text-destructive hover:underline disabled:opacity-60"
                @click="optOutOfStatements"
              >
                Opt out
              </button>
            </div>
          </div>
          <div v-if="loadingStatementPolicy" class="text-sm text-muted-foreground">
            Loading…
          </div>
          <div v-else-if="!statementPolicy" class="text-sm text-muted-foreground">
            No auto-schedule. Statements for this lease will only exist when an
            operator creates them manually.
          </div>
          <div v-else>
            <p class="text-sm text-foreground">{{ statementPolicySummary(statementPolicy) }}</p>
            <p v-if="statementPolicy.notes" class="mt-1 text-xs text-muted-foreground">
              {{ statementPolicy.notes }}
            </p>
            <p class="mt-2 text-[11px] text-muted-foreground/70">
              Daily cron at 05:00 UTC · idempotent (safe to re-run via Generate now)
              <span v-if="statementPolicy.last_generated_period_start">
                · last covered period started
                {{ new Date(statementPolicy.last_generated_period_start).toLocaleDateString() }}
              </span>
            </p>
          </div>

          <!-- Recent statements list -->
          <div v-if="statements.length > 0" class="mt-4 border-t border-border pt-4">
            <h3 class="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Recent statements
            </h3>
            <div class="overflow-x-auto">
              <table class="min-w-full divide-y divide-border text-sm">
                <thead class="bg-muted/40">
                  <tr>
                    <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Statement</th>
                    <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Period</th>
                    <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Billed</th>
                    <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Paid</th>
                    <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Balance</th>
                    <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</th>
                    <th class="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-border">
                  <tr v-for="s in statements.slice(0, 6)" :key="s.id">
                    <td class="px-3 py-2 font-mono text-xs">{{ s.statement_no }}</td>
                    <td class="px-3 py-2 text-xs text-muted-foreground">
                      {{ new Date(s.period_start).toLocaleDateString() }}
                      → {{ new Date(s.period_end).toLocaleDateString() }}
                    </td>
                    <td class="px-3 py-2 text-right tabular-nums">
                      {{ formatPHP(s.rent_billed_minor + s.other_charges_minor, s.currency) }}
                    </td>
                    <td class="px-3 py-2 text-right tabular-nums">
                      {{ formatPHP(s.payments_received_minor, s.currency) }}
                    </td>
                    <td class="px-3 py-2 text-right tabular-nums font-medium">
                      {{ formatPHP(s.balance_due_minor, s.currency) }}
                    </td>
                    <td class="px-3 py-2 text-xs">
                      <span :class="['inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase', statementStatusClass(s.status)]">
                        {{ s.status }}
                      </span>
                    </td>
                    <td class="px-3 py-2 text-right">
                      <a
                        :href="`/api/admin/tenant-statements/${s.id}/pdf`"
                        target="_blank"
                        rel="noopener"
                        class="text-xs text-primary hover:underline"
                        title="Open PDF in a new tab (right-click → Save As to download)"
                      >
                        PDF
                      </a>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </UiCard>

        <!-- Inspections -->
        <UiCard variant="surface" padding="md">
          <div class="mb-3 flex items-center justify-between gap-3">
            <h2 class="text-base font-semibold text-foreground">
              Inspections
              <span class="text-xs font-normal text-muted-foreground">({{ inspections.length }})</span>
            </h2>
            <button
              type="button"
              class="text-xs text-primary hover:underline"
              @click="openScheduleInspection"
            >
              + Schedule inspection
            </button>
          </div>
          <div v-if="loadingInspections" class="text-sm text-muted-foreground">
            Loading…
          </div>
          <div v-else-if="inspections.length === 0" class="text-sm text-muted-foreground">
            No inspections recorded for this lease. Schedule a move-in inspection
            before the tenant takes possession to capture a baseline.
          </div>
          <ul v-else class="divide-y divide-border">
            <li v-for="ins in inspections.slice(0, 8)" :key="ins.id" class="py-2.5">
              <NuxtLink
                :to="`/admin/inspections/${ins.id}`"
                class="-mx-2 block rounded px-2 py-1 hover:bg-accent hover:text-accent-foreground"
              >
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="font-mono text-xs text-foreground">{{ ins.inspection_no }}</span>
                      <span class="text-xs uppercase tracking-wide text-muted-foreground">
                        {{ inspectionKindLabel(ins.inspection_kind) }}
                      </span>
                      <span :class="['inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase', inspectionStatusClass(ins.status)]">
                        {{ ins.status.replace('_', ' ') }}
                      </span>
                      <span
                        v-if="ins.overall_condition"
                        class="text-[10px] uppercase tracking-wide text-muted-foreground"
                      >
                        · overall {{ ins.overall_condition }}
                      </span>
                    </div>
                    <p class="mt-0.5 text-xs text-muted-foreground">
                      <span v-if="ins.scheduled_at">
                        scheduled {{ new Date(ins.scheduled_at).toLocaleString() }}
                      </span>
                      <span v-if="ins.conducted_at">
                        · conducted {{ new Date(ins.conducted_at).toLocaleDateString() }}
                      </span>
                      <span v-if="ins.tenant_signed_at" class="text-success">
                        · signed {{ new Date(ins.tenant_signed_at).toLocaleDateString() }}
                      </span>
                      <span v-if="ins.total_damage_estimate_minor > 0" class="text-destructive">
                        · damage estimate {{ formatPHP(ins.total_damage_estimate_minor) }}
                      </span>
                    </p>
                  </div>
                  <span class="flex-shrink-0 text-xs text-muted-foreground">→</span>
                </div>
              </NuxtLink>
            </li>
          </ul>
        </UiCard>

        <!-- Maintenance feed -->
        <UiCard variant="surface" padding="md">
          <h2 class="mb-3 text-base font-semibold text-foreground">
            Maintenance requests
            <span class="text-xs font-normal text-muted-foreground">({{ maintenance.length }})</span>
          </h2>
          <div v-if="maintenance.length === 0" class="text-sm text-muted-foreground">
            No maintenance requests linked to this lease.
          </div>
          <ul v-else class="divide-y divide-border">
            <li v-for="m in maintenance.slice(0, 8)" :key="m.id" class="py-2.5">
              <div class="flex items-start justify-between gap-3">
                <div>
                  <div class="flex items-center gap-2">
                    <span class="text-sm font-medium text-foreground">{{ m.title }}</span>
                    <span :class="['inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase', urgencyClass(m.urgency)]">
                      {{ m.urgency }}
                    </span>
                  </div>
                  <p class="text-xs text-muted-foreground">
                    <span class="font-mono">{{ m.request_no }}</span>
                    · <span class="capitalize">{{ m.category }}</span>
                    · <span class="capitalize">{{ m.status.replace('_', ' ') }}</span>
                    · {{ new Date(m.reported_at).toLocaleDateString() }}
                  </p>
                </div>
              </div>
            </li>
          </ul>
        </UiCard>
      </template>

      <!-- Terminate drawer -->
      <UiDrawer
        :open="terminateModal"
        title="Terminate lease"
        width="md"
        @update:open="terminateModal = $event"
      >
        <p class="text-meta">
          This stamps the active occupancy with a move-out date. Reason is required for
          audit; pick a phrase you'd be comfortable explaining to the tenant.
        </p>
        <textarea
          v-model="terminateReason"
          rows="4"
          required
          maxlength="500"
          placeholder="e.g., mutual agreement, end of fixed term, breach of contract…"
          class="mt-3 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground shadow-sm focus:border-destructive focus:ring-1 focus:ring-destructive"
        />
        <template #footer>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="btn-secondary focus-ring"
              @click="terminateModal = false"
            >
              Cancel
            </button>
            <button
              type="button"
              :disabled="acting === 'terminate'"
              class="btn-destructive disabled:opacity-60 focus-ring"
              @click="terminate"
            >
              <span v-if="acting === 'terminate'">Terminating…</span>
              <span v-else>Confirm terminate</span>
            </button>
          </div>
        </template>
      </UiDrawer>

      <!-- Add party — Phase 5 Operations primitive -->
      <UiModal
        :open="addPartyModal"
        title="Add party"
        subtitle="Lease parties can be edited only while the lease is in draft or pending_signature status."
        width="md"
        @update:open="addPartyModal = $event"
      >
        <div class="space-y-3">
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">Role</span>
            <select
              v-model="partyForm.role"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            >
              <option value="tenant">tenant</option>
              <option value="landlord">landlord</option>
              <option value="guarantor">guarantor</option>
              <option value="co_signer">co-signer</option>
              <option value="agent">agent</option>
            </select>
          </label>
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">Name</span>
            <input
              v-model="partyForm.external_name"
              type="text"
              maxlength="200"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
          </label>
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">Email</span>
            <input
              v-model="partyForm.external_email"
              type="email"
              maxlength="254"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
          </label>
          <label class="flex items-start gap-2 text-sm text-foreground">
            <input
              v-model="partyForm.is_primary"
              type="checkbox"
              class="mt-0.5 h-4 w-4 rounded border-border"
            />
            <span>
              Primary {{ partyForm.role }} (one per role per lease — partial UNIQUE
              will reject if another primary exists)
            </span>
          </label>
        </div>
        <template #footer>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="btn-secondary"
              @click="addPartyModal = false"
            >
              Cancel
            </button>
            <button
              type="button"
              :disabled="addingParty"
              class="btn-primary disabled:opacity-60"
              @click="addParty"
            >
              <span v-if="addingParty">Adding…</span>
              <span v-else>Add party</span>
            </button>
          </div>
        </template>
      </UiModal>

      <!-- Add rent schedule — Phase 5 Operations primitive -->
      <UiModal
        :open="addScheduleModal"
        title="Set up rent schedule"
        subtitle="The daily cron generates a property_charges row on next_due_at when auto_generate is on. New schedules default to auto-on."
        width="md"
        @update:open="addScheduleModal = $event"
      >
        <div class="space-y-3">
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">
              Amount per period (centavos · ₱{{ (scheduleForm.amount_minor / 100).toFixed(2) }})
            </span>
            <input
              v-model.number="scheduleForm.amount_minor"
              type="number"
              min="0"
              step="100"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
          </label>
          <div class="grid grid-cols-2 gap-3">
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">Period</span>
              <select
                v-model="scheduleForm.period"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              >
                <option value="monthly">monthly</option>
                <option value="quarterly">quarterly</option>
                <option value="annual">annual</option>
              </select>
            </label>
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">Billing day (1-28)</span>
              <input
                v-model.number="scheduleForm.billing_day"
                type="number"
                min="1"
                max="28"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>
          </div>
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">First due date</span>
            <input
              v-model="scheduleForm.next_due_at"
              type="date"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
          </label>
          <label class="flex items-start gap-2 text-sm text-foreground">
            <input
              v-model="scheduleForm.auto_generate"
              type="checkbox"
              class="mt-0.5 h-4 w-4 rounded border-border"
            />
            <span>
              Auto-generate charges via the daily cron. Turn off for one-shot or
              manually-triggered billing.
            </span>
          </label>
        </div>
        <template #footer>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="btn-secondary"
              @click="addScheduleModal = false"
            >
              Cancel
            </button>
            <button
              type="button"
              :disabled="addingSchedule"
              class="btn-primary disabled:opacity-60"
              @click="addSchedule"
            >
              <span v-if="addingSchedule">Creating…</span>
              <span v-else>Create schedule</span>
            </button>
          </div>
        </template>
      </UiModal>

      <!-- Schedule inspection — Phase 5 Operations primitive -->
      <UiModal
        :open="scheduleInspectionModal"
        title="Schedule inspection"
        subtitle='Creates the inspection in "scheduled" status. Add findings (per-area condition + photos) afterwards; lock with "Complete" once all findings are recorded.'
        width="md"
        @update:open="scheduleInspectionModal = $event"
      >
        <div class="space-y-3">
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">Kind</span>
            <select
              v-model="inspectionScheduleForm.inspection_kind"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            >
              <option value="move_in">Move-in (baseline before tenant takes possession)</option>
              <option value="move_out">Move-out (compare against move-in baseline)</option>
              <option value="mid_tenancy">Mid-tenancy (periodic walk-through)</option>
              <option value="maintenance">Maintenance (pre/post a vendor work order)</option>
              <option value="annual">Annual (landlord walk-through)</option>
            </select>
          </label>
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">Scheduled at (optional)</span>
            <input
              v-model="inspectionScheduleForm.scheduled_at"
              type="datetime-local"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
          </label>
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">External inspector name (optional)</span>
            <input
              v-model="inspectionScheduleForm.inspector_external_name"
              type="text"
              maxlength="200"
              placeholder="leave blank to record yourself as inspector"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
          </label>
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">Summary notes (optional)</span>
            <textarea
              v-model="inspectionScheduleForm.summary_notes"
              rows="2"
              maxlength="2000"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
          </label>
        </div>
        <template #footer>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="btn-secondary"
              @click="scheduleInspectionModal = false"
            >
              Cancel
            </button>
            <button
              type="button"
              :disabled="schedulingInspection"
              class="btn-primary disabled:opacity-60"
              @click="scheduleInspection"
            >
              <span v-if="schedulingInspection">Scheduling…</span>
              <span v-else>Schedule</span>
            </button>
          </div>
        </template>
      </UiModal>

      <!-- Statement schedule editor — Phase 5 Operations primitive -->
      <UiModal
        :open="statementPolicyModal"
        :title="`${statementPolicy ? 'Edit' : 'Set up'} statement schedule`"
        subtitle="The daily cron at 05:00 UTC aggregates this lease's charges and payments for the prior period and creates a tenant statement. Saving atomically pauses any prior schedule."
        width="md"
        @update:open="statementPolicyModal = $event"
      >
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
              e.g., 1 = issue on the first day of each new period.
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
              so an operator can review and edit before issuing.
            </span>
          </label>
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">Notes (optional, audited)</span>
            <textarea
              v-model="statementPolicyForm.notes"
              rows="2"
              maxlength="500"
              placeholder="e.g., per the lease, statements due on the 1st"
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

      <!-- Late-fee policy editor — Phase 5 Operations primitive -->
      <UiModal
        :open="policyModal"
        :title="`${lateFeePolicy ? 'Edit' : 'Create'} late-fee policy`"
        subtitle="Applied by the daily cron at 04:00 UTC against past-due rent / dues / pass-through charges on this lease. Saving atomically pauses any prior policy."
        width="lg"
        @update:open="policyModal = $event"
      >
        <div class="space-y-3">
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">Fee shape</span>
              <select
                v-model="policyForm.fee_kind"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              >
                <option value="flat">Flat amount</option>
                <option value="percent_of_balance">Percent of unpaid balance</option>
                <option value="escalating">Escalating flat (recurring)</option>
              </select>
            </label>

            <label v-if="policyForm.fee_kind !== 'percent_of_balance'" class="block">
              <span class="block text-xs font-medium text-muted-foreground">
                Fee amount (centavos · ₱{{ (policyForm.flat_amount_minor / 100).toFixed(2) }})
              </span>
              <input
                v-model.number="policyForm.flat_amount_minor"
                type="number"
                min="0"
                step="100"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>

            <label v-else class="block">
              <span class="block text-xs font-medium text-muted-foreground">
                Percent of unpaid balance (0.001 - 100)
              </span>
              <input
                v-model.number="policyForm.percent_value"
                type="number"
                min="0.001"
                max="100"
                step="0.001"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>

            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">
                Cap per assessment (centavos · optional · {{ policyForm.cap_minor ? `₱${(policyForm.cap_minor / 100).toFixed(2)}` : 'no cap' }})
              </span>
              <input
                v-model.number="policyForm.cap_minor"
                type="number"
                min="0"
                step="100"
                placeholder="leave blank for no cap"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>

            <div class="grid grid-cols-2 gap-3">
              <label class="block">
                <span class="block text-xs font-medium text-muted-foreground">Grace days after due_at (0 - 90)</span>
                <input
                  v-model.number="policyForm.grace_days"
                  type="number"
                  min="0"
                  max="90"
                  class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
                />
              </label>
              <label class="block">
                <span class="block text-xs font-medium text-muted-foreground">Recurrence</span>
                <select
                  v-model="policyForm.recurrence_kind"
                  class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
                >
                  <option value="once">Once per past-due charge</option>
                  <option value="recurring">Recurring</option>
                </select>
              </label>
            </div>

            <label v-if="policyForm.recurrence_kind === 'recurring'" class="block">
              <span class="block text-xs font-medium text-muted-foreground">Repeat every (days, 1-90)</span>
              <input
                v-model.number="policyForm.recurrence_days"
                type="number"
                min="1"
                max="90"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>

            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">Notes (optional, audited)</span>
              <textarea
                v-model="policyForm.notes"
                rows="2"
                maxlength="500"
                placeholder="e.g., per Section 8 of the lease agreement"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>
        </div>
        <template #footer>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="btn-secondary"
              @click="policyModal = false"
            >
              Cancel
            </button>
            <button
              type="button"
              :disabled="savingPolicy"
              class="btn-primary disabled:opacity-60"
              @click="savePolicy"
            >
              <span v-if="savingPolicy">Saving…</span>
              <span v-else>Save policy</span>
            </button>
          </div>
        </template>
      </UiModal>

      <!-- Invite tenant to portal — Phase 5 Operations primitive -->
      <UiModal
        :open="inviteModal"
        title="Invite tenant to portal"
        subtitle="Sends a one-time link to the tenant. After they sign in (or create an account with this email), they get read access to their lease, statements, charges, and a maintenance request form. The link is single-use and expires."
        width="md"
        @update:open="inviteModal = $event"
      >
        <!-- Pre-issue: form -->
        <template v-if="!issuedInvite">
          <div class="space-y-3">
            <div class="rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-muted-foreground">
              Inviting <strong class="text-foreground">{{ inviteParty?.external_name || 'this tenant party' }}</strong>
              <span v-if="inviteParty?.external_email"> · {{ inviteParty.external_email }}</span>
            </div>
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">Send to email</span>
              <input
                v-model="inviteForm.invite_email"
                type="email"
                maxlength="254"
                placeholder="tenant@example.com"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
              <span class="mt-1 block text-[11px] text-muted-foreground">
                Defaults to the lease party's recorded email; override if they prefer a different inbox.
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

        <!-- Post-issue: result panel with the cleartext accept_url -->
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

      <!-- Revoke invitation — Phase 5 Operations primitive (destructive) -->
      <UiModal
        :open="revokeModal"
        title="Revoke portal invitation"
        subtitle="The invitation link will stop working immediately. Use this if the email was sent to the wrong recipient or you need to re-issue with a different address."
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
            placeholder="e.g., wrong email · duplicate · tenant requested cancellation"
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

      <!-- Renew lease — Phase 5 Operations primitive -->
      <UiModal
        :open="renewModal"
        title="Renew lease"
        subtitle='Creates a child lease (status = draft) with the same parties. The current lease transitions to "expired" atomically.'
        width="md"
        @update:open="renewModal = $event"
      >
        <div class="space-y-3">
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">New effective date</span>
            <input
              v-model="renewForm.effective_at"
              type="date"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
          </label>
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">New expires</span>
            <input
              v-model="renewForm.expires_at"
              type="date"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
          </label>
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">
              New rent (centavos · {{ formatPHP(renewForm.rent_minor) }})
            </span>
            <input
              v-model.number="renewForm.rent_minor"
              type="number"
              min="0"
              step="100"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
          </label>
        </div>
        <template #footer>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="btn-secondary"
              @click="renewModal = false"
            >
              Cancel
            </button>
            <button
              type="button"
              :disabled="acting === 'renew'"
              class="btn-primary disabled:opacity-60"
              @click="renew"
            >
              <span v-if="acting === 'renew'">Renewing…</span>
              <span v-else>Confirm renew</span>
            </button>
          </div>
        </template>
      </UiModal>
  </AdminPageShell>
</template>
