<script setup lang="ts">
/**
 * Team & invitations panel for /organization.
 *
 * Three concerns in one card:
 *   1. Pending invitations list (with revoke + copy-link actions)
 *   2. "Invite agent" form (email + role + optional name + notes)
 *   3. Idempotent feedback when email isn't configured (the
 *      copy-link affordance is the manual-send fallback)
 *
 * Backend already in place:
 *   - GET    /api/organizations/:id/invitations?status=pending
 *   - POST   /api/organizations/:id/invitations
 *   - DELETE /api/organizations/:id/invitations/:invId
 *
 * Email goes out via the outbound-email worker (queued by
 * orgInvitationsRepo.create). When RESEND_API_KEY is unset, the
 * worker still runs but sendEmail() logs-and-skips — that's why we
 * always offer the manual-link copy.
 */
import { ref, computed, onMounted } from 'vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiSectionHeader from '~/components/ui/UiSectionHeader.vue'
import { showToast } from '~/helpers/helpers'

type Props = {
  organizationId: string
  /** Caller's own org_role — used to hide the panel from agents. */
  callerOrgRole: string | null
}
const props = defineProps<Props>()

type Invitation = {
  id: string
  email: string
  full_name: string | null
  org_role: string
  status: 'pending' | 'accepted' | 'declined' | 'expired'
  expires_at: string | null
  created_at: string
  token: string
}

const ORG_ROLES = [
  { key: 'junior_agent',    label: 'Junior agent' },
  { key: 'senior_agent',    label: 'Senior agent' },
  { key: 'team_lead',       label: 'Team lead' },
  { key: 'branch_manager',  label: 'Branch manager' },
  { key: 'assistant',       label: 'Assistant' },
] as const

const canManage = computed(
  () => props.callerOrgRole === 'brokerage_owner' || props.callerOrgRole === 'branch_manager',
)

const invitations = ref<Invitation[]>([])
const loading = ref(false)
const error = ref<string | null>(null)

const form = ref({
  email: '',
  full_name: '',
  org_role: 'junior_agent' as (typeof ORG_ROLES)[number]['key'],
  notes: '',
})
const submitting = ref(false)
const formError = ref<string | null>(null)

async function load() {
  loading.value = true
  error.value = null
  try {
    const res = await $fetch<{ items: Invitation[] }>(
      `/api/organizations/${props.organizationId}/invitations`,
      { query: { status: 'pending' } },
    )
    invitations.value = res.items ?? []
  } catch (err: any) {
    error.value = err?.statusMessage ?? err?.message ?? 'Failed to load invitations'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  if (canManage.value) load()
})

const validEmail = computed(() => {
  const e = form.value.email.trim()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)
})
const canSubmit = computed(() => validEmail.value && !submitting.value)

async function submit() {
  if (!canSubmit.value) return
  submitting.value = true
  formError.value = null
  try {
    await $fetch(
      `/api/organizations/${props.organizationId}/invitations`,
      {
        method: 'POST',
        body: {
          email:     form.value.email.trim().toLowerCase(),
          full_name: form.value.full_name.trim() || null,
          org_role:  form.value.org_role,
          notes:     form.value.notes.trim() || null,
        },
      },
    )
    showToast({
      title: `Invitation sent to ${form.value.email.trim()}.`,
      icon: 'success',
    })
    form.value = { email: '', full_name: '', org_role: 'junior_agent', notes: '' }
    await load()
  } catch (err: any) {
    const status = err?.statusCode ?? err?.response?.status
    const msg    = err?.statusMessage ?? err?.data?.statusMessage ?? err?.message ?? 'Could not send invitation'
    if (status === 409) {
      formError.value = msg // already invited
    } else if (status === 403) {
      formError.value = 'You don\'t have permission to invite members for this organization.'
    } else {
      formError.value = msg
    }
  } finally {
    submitting.value = false
  }
}

async function revoke(inv: Invitation) {
  const ok = typeof window !== 'undefined'
    ? window.confirm(`Revoke invitation to ${inv.email}? They won't be able to accept it.`)
    : true
  if (!ok) return
  try {
    await $fetch(
      `/api/organizations/${props.organizationId}/invitations/${inv.id}`,
      { method: 'DELETE' },
    )
    showToast({ title: `Revoked invitation to ${inv.email}.`, icon: 'success' })
    await load()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage ?? err?.message ?? 'Could not revoke',
      icon: 'error',
    })
  }
}

function acceptUrl(inv: Invitation): string {
  if (typeof window === 'undefined') return `/invite/${inv.token}`
  return `${window.location.origin}/invite/${inv.token}`
}

async function copyLink(inv: Invitation) {
  const url = acceptUrl(inv)
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(url)
      showToast({ title: 'Invite link copied.', icon: 'success' })
    } else {
      window.prompt('Copy this invite link:', url)
    }
  } catch {
    window.prompt('Copy this invite link:', url)
  }
}

function fmtRole(r: string): string {
  return r.replace(/_/g, ' ')
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  } catch { return '—' }
}

function isExpiringSoon(iso: string | null): boolean {
  if (!iso) return false
  const ms = new Date(iso).getTime() - Date.now()
  return ms > 0 && ms < 7 * 24 * 60 * 60 * 1000 // < 7 days
}
</script>

<template>
  <UiCard v-if="canManage" variant="surface" padding="lg">
    <UiSectionHeader
      title="Team"
      eyebrow="Invitations"
      description="Invite your agents by email. They'll receive a link to accept and join your brokerage."
    />

    <!-- Invite form -->
    <form class="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto]" @submit.prevent="submit">
      <div>
        <label for="invite-email" class="sr-only">Email address</label>
        <input
          id="invite-email"
          v-model="form.email"
          type="email"
          required
          maxlength="254"
          placeholder="agent@example.com"
          class="block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
      <div>
        <label for="invite-role" class="sr-only">Role</label>
        <select
          id="invite-role"
          v-model="form.org_role"
          class="block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option v-for="r in ORG_ROLES" :key="r.key" :value="r.key">{{ r.label }}</option>
        </select>
      </div>
      <div>
        <button
          type="submit"
          :disabled="!canSubmit"
          class="inline-flex w-full items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
        >
          <span v-if="submitting">Sending…</span>
          <span v-else>Send invite</span>
        </button>
      </div>
    </form>

    <!-- Optional fields, collapsed by default visually but always present -->
    <div class="mt-3 grid gap-3 sm:grid-cols-2">
      <input
        v-model="form.full_name"
        type="text"
        maxlength="200"
        placeholder="Full name (optional)"
        class="block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      />
      <input
        v-model="form.notes"
        type="text"
        maxlength="2000"
        placeholder="Personal note (optional, included in email)"
        class="block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      />
    </div>

    <p
      v-if="formError"
      class="mt-2 text-xs text-destructive"
    >
      {{ formError }}
    </p>

    <!-- Pending list -->
    <div class="mt-6">
      <header class="mb-2 flex items-center justify-between">
        <h3 class="text-sm font-semibold text-foreground">Pending invitations</h3>
        <button
          v-if="!loading"
          type="button"
          class="text-xs text-muted-foreground hover:text-foreground"
          @click="load"
        >
          Refresh
        </button>
      </header>

      <div v-if="loading" class="text-meta">Loading…</div>
      <div v-else-if="error" class="text-xs text-destructive">{{ error }}</div>
      <div
        v-else-if="invitations.length === 0"
        class="rounded-lg border border-dashed border-border bg-muted/30 p-4 text-meta"
      >
        No pending invitations. Use the form above to invite your first agent.
      </div>
      <ul v-else class="divide-y divide-border rounded-lg border border-border">
        <li
          v-for="inv in invitations"
          :key="inv.id"
          class="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div class="min-w-0">
            <p class="truncate text-sm font-medium text-foreground">
              {{ inv.full_name || inv.email }}
              <span v-if="inv.full_name" class="ml-1 text-meta">{{ inv.email }}</span>
            </p>
            <p class="mt-0.5 flex flex-wrap items-center gap-2 text-meta">
              <UiBadge variant="neutral" size="xs">{{ fmtRole(inv.org_role) }}</UiBadge>
              <span>Sent {{ fmtDate(inv.created_at) }}</span>
              <span v-if="inv.expires_at">
                ·
                <span :class="isExpiringSoon(inv.expires_at) ? 'text-warning font-medium' : ''">
                  Expires {{ fmtDate(inv.expires_at) }}
                </span>
              </span>
            </p>
          </div>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent/40"
              @click="copyLink(inv)"
            >
              Copy link
            </button>
            <button
              type="button"
              class="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
              @click="revoke(inv)"
            >
              Revoke
            </button>
          </div>
        </li>
      </ul>
    </div>

    <p class="mt-3 text-meta">
      Tip: if your agent doesn't receive the email, copy the link and send it manually. The link is unique to them and works once.
    </p>
  </UiCard>
</template>
