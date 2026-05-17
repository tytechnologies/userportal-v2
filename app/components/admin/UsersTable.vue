<script setup lang="ts">
/**
 * Users management table — Phase 2 admin redesign.
 *
 * Real <table> with sticky header. Each row shows avatar + name + email
 * + role badge + joined date + actions menu. Role editing happens
 * inline: click the row's "..." menu (or the role badge directly) to
 * enter edit mode; commits on Save with the same self-lockout guard
 * as before.
 *
 * Reads/writes go through useAdmin(); RLS enforces actual mutation
 * permissions via the `profiles_admin_update` policy.
 *
 * Phase 2B columns (organization, verified, last active) come from
 * /api/admin/users/list-enriched which joins organization_memberships,
 * profile_verifications, and the activities table server-side. The
 * legacy listProfiles() composable is kept as a fallback so the table
 * still renders when the enriched endpoint is unavailable.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useAdmin, type AdminProfile } from '~/composables/useAdmin'
import type { Role } from '~/composables/useAuth'
import { useDisplayUser } from '~/composables/useDisplayUser'
import { showToast } from '~/helpers/helpers'
import DotsHorizontal from 'vue-material-design-icons/DotsHorizontal.vue'
import CheckDecagram from 'vue-material-design-icons/CheckDecagram.vue'

// Phase 2B: enriched user shape returned by /api/admin/users/list-enriched.
// Falls back gracefully when the endpoint isn't reachable — base profile
// columns still render via listProfiles.
type EnrichedUser = AdminProfile & {
  organization: { id: string; name: string; slug: string; role: string } | null
  verified: boolean
  last_active_at: string | null
}

const { listProfiles, updateProfileRole } = useAdmin()
const display = useDisplayUser()

const users = ref<EnrichedUser[]>([])
const isLoading = ref(true)
const errorMessage = ref<string | null>(null)

const search = ref('')
const roleFilter = ref<'' | Role>('')

// Per-row edit-mode state. Only one row can be in edit mode at a
// time — multi-row editing would require a separate "save all" UX
// affordance and isn't requested.
const editingId = ref<string | null>(null)
const pendingRole = ref<Record<string, Role>>({})
const savingId = ref<string | null>(null)

// Bulk-selection state. The set carries user ids; using a Set keeps
// toggle/has checks O(1) regardless of how many rows are loaded.
const selected = ref<Set<string>>(new Set())
const bulkRole = ref<Role | ''>('')
const bulkSubmitting = ref(false)
const bulkProgress = ref<{ done: number; total: number; failed: number } | null>(null)

async function load() {
  isLoading.value = true
  errorMessage.value = null
  try {
    // Try the enriched endpoint first (Phase 2B). Falls back to
    // listProfiles() if it 404s — that way the table keeps working
    // even on environments that haven't deployed the new endpoint.
    let rows: EnrichedUser[]
    try {
      const params: Record<string, string> = {}
      if (search.value) params.search = search.value
      if (roleFilter.value) params.role = roleFilter.value
      const res = await $fetch<{ users: EnrichedUser[] }>(
        '/api/admin/users/list-enriched',
        { query: params },
      )
      rows = res.users ?? []
    } catch {
      // Fallback: base shape, no enriched columns.
      const base = await listProfiles({
        search: search.value || undefined,
        role: roleFilter.value || null,
      })
      rows = base.map((u) => ({
        ...u,
        organization: null,
        verified: false,
        last_active_at: null,
      }))
    }
    users.value = rows
    // Reset pending state to current persisted values.
    pendingRole.value = Object.fromEntries(rows.map((u) => [u.id, u.role]))
    // Clear any in-progress edit if the row no longer exists in the
    // result set (e.g. operator filtered).
    if (editingId.value && !rows.find((r) => r.id === editingId.value)) {
      editingId.value = null
    }
    // Drop selections that didn't survive the new result set.
    const visible = new Set(rows.map((r) => r.id))
    for (const id of [...selected.value]) {
      if (!visible.has(id)) selected.value.delete(id)
    }
  } catch (err: any) {
    errorMessage.value = err?.message ?? 'Failed to load users.'
  } finally {
    isLoading.value = false
  }
}

onMounted(load)

// Re-fetch on filter/search change with a small debounce so typing
// doesn't fire a request per keystroke.
let searchTimer: ReturnType<typeof setTimeout> | null = null
watch([search, roleFilter], () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(load, 250)
})

// Lockout guard — true when the current user is the SOLE admin in the
// loaded set. Disable their dropdown so they cannot demote themselves
// and lock the org out of the admin panel.
const adminCount = computed(() => users.value.filter((u) => u.role === 'admin').length)
function isLocked(user: EnrichedUser): boolean {
  return user.id === display.value.id && user.role === 'admin' && adminCount.value <= 1
}

const isDirty = (user: EnrichedUser) => pendingRole.value[user.id] !== user.role

function startEdit(user: EnrichedUser) {
  if (isLocked(user)) {
    showToast({
      title: 'You can\'t demote the only remaining admin from your own account.',
      icon: 'warning',
    })
    return
  }
  editingId.value = user.id
  // Reset pending to current so an aborted edit doesn't carry over.
  pendingRole.value[user.id] = user.role
}

function cancelEdit(user: EnrichedUser) {
  pendingRole.value[user.id] = user.role
  editingId.value = null
}

async function save(user: EnrichedUser) {
  const next = pendingRole.value[user.id]
  if (!next || next === user.role) {
    editingId.value = null
    return
  }
  savingId.value = user.id
  try {
    const updated = await updateProfileRole(user.id, next)
    const idx = users.value.findIndex((u) => u.id === user.id)
    // Merge so enriched fields (organization, verified, last_active_at)
    // survive the role-update PATCH which returns the base profile shape.
    if (idx >= 0) users.value[idx] = { ...users.value[idx], ...updated } as typeof users.value[number]
    pendingRole.value[user.id] = updated.role
    editingId.value = null
    showToast({ title: `Role updated to ${updated.role}.`, icon: 'success' })
  } catch (err: any) {
    showToast({ title: err?.message ?? 'Could not save.', icon: 'error' })
    pendingRole.value[user.id] = user.role
  } finally {
    savingId.value = null
  }
}

function initial(user: EnrichedUser): string {
  const s = user.full_name || user.email || '?'
  return s.trim().charAt(0).toUpperCase() || '?'
}

function formatLastActive(iso: string | null): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// Role badge palette — three semantically meaningful tones.
//   admin   = elevated trust + write-everything → red
//   manager = operational lead → blue
//   agent   = baseline / default → muted neutral
function roleBadgeClass(role: Role): string {
  switch (role) {
    case 'admin':   return 'bg-destructive/10 text-destructive ring-destructive/30'
    case 'manager': return 'bg-primary/10 text-primary ring-primary/30'
    case 'agent':   return 'bg-muted-foreground/10 text-foreground/80 ring-muted-foreground/15'
  }
}

function formatJoined(iso: string | null): { label: string; title: string } {
  if (!iso) return { label: '—', title: '' }
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { label: '—', title: '' }
  const diff = Date.now() - d.getTime()
  const days = Math.floor(diff / 86_400_000)
  const title = d.toLocaleString()
  if (days < 1) return { label: 'today', title }
  if (days < 7) return { label: `${days}d ago`, title }
  if (days < 30) return { label: `${Math.floor(days / 7)}w ago`, title }
  return { label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }), title }
}

// ---- Bulk selection ------------------------------------------------
const allOnPageSelected = computed(
  () =>
    users.value.length > 0 &&
    users.value.every((u) => selected.value.has(u.id)),
)

function toggleRowSelection(id: string) {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = next
}

function toggleAllOnPage() {
  const next = new Set(selected.value)
  if (allOnPageSelected.value) {
    for (const u of users.value) next.delete(u.id)
  } else {
    for (const u of users.value) next.add(u.id)
  }
  selected.value = next
}

function clearSelection() {
  selected.value = new Set()
  bulkRole.value = ''
  bulkProgress.value = null
}

/**
 * Bulk role update. Loops the existing per-user updateProfileRole call
 * sequentially so each PATCH respects RLS. Slower than a single-shot
 * UPDATE but avoids needing a new admin-only bulk endpoint + keeps
 * the self-lockout / audit semantics already proven on the per-row
 * path. Bounded count means latency stays acceptable (<50 typical).
 */
async function applyBulkRoleChange() {
  if (!bulkRole.value) {
    showToast({ title: 'Pick a target role first', icon: 'warning' })
    return
  }
  if (selected.value.size === 0) return

  // Self-lockout guard for bulk: don't let the operator demote
  // themselves out of admin if they're the sole admin in the set.
  const ids = [...selected.value]
  const targetingSelf = ids.includes(display.value.id ?? '')
  const wouldDemoteSelf =
    targetingSelf &&
    bulkRole.value !== 'admin' &&
    adminCount.value <= 1
  if (wouldDemoteSelf) {
    showToast({
      title: "You can't demote yourself when you're the only admin.",
      icon: 'warning',
    })
    return
  }

  bulkSubmitting.value = true
  bulkProgress.value = { done: 0, total: ids.length, failed: 0 }
  try {
    for (const id of ids) {
      const row = users.value.find((u) => u.id === id)
      if (!row) {
        bulkProgress.value.done++
        continue
      }
      // Skip rows already at the target role.
      if (row.role === bulkRole.value) {
        bulkProgress.value.done++
        continue
      }
      try {
        const updated = await updateProfileRole(id, bulkRole.value as Role)
        const idx = users.value.findIndex((u) => u.id === id)
        if (idx >= 0) users.value[idx] = { ...users.value[idx], ...updated } as typeof users.value[number]
        pendingRole.value[id] = updated.role
      } catch {
        bulkProgress.value.failed++
      } finally {
        bulkProgress.value.done++
      }
    }

    const { done, total, failed } = bulkProgress.value
    showToast({
      title:
        failed > 0
          ? `Updated ${done - failed} of ${total} (${failed} failed)`
          : `Updated ${total} user${total === 1 ? '' : 's'} to ${bulkRole.value}`,
      icon: failed > 0 ? 'warning' : 'success',
    })
    if (failed === 0) clearSelection()
  } finally {
    bulkSubmitting.value = false
    // Leave bulkProgress visible briefly so the operator sees the final
    // count; clear after a short delay.
    setTimeout(() => {
      bulkProgress.value = null
    }, 2000)
  }
}

// Per-row open `…` menu — single-open enforced via this ref.
const openMenuId = ref<string | null>(null)
function toggleMenu(user: EnrichedUser) {
  openMenuId.value = openMenuId.value === user.id ? null : user.id
}
function closeMenu() {
  openMenuId.value = null
}
</script>

<template>
  <section>
    <!-- Toolbar -->
    <div class="mb-4 flex flex-col gap-3 rounded-lg border border-border bg-card px-4 py-3 sm:flex-row sm:items-center">
      <div class="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center">
        <input
          v-model="search"
          type="search"
          placeholder="Search name or email…"
          class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring sm:max-w-xs"
        />
        <div class="flex items-center gap-1.5">
          <button
            v-for="opt in [
              { v: '',        label: 'All' },
              { v: 'admin',   label: 'Admin' },
              { v: 'manager', label: 'Manager' },
              { v: 'agent',   label: 'Agent' },
            ]"
            :key="opt.v"
            type="button"
            class="rounded-full px-3 py-1 text-xs font-semibold transition-colors"
            :class="
              roleFilter === opt.v
                ? 'bg-foreground text-background'
                : 'bg-muted-foreground/10 text-foreground/80 hover:bg-muted-foreground/20'
            "
            @click="roleFilter = opt.v as '' | Role"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>
      <span class="shrink-0 rounded-full bg-muted-foreground/10 px-2.5 py-1 text-xs font-semibold tabular-nums text-foreground/80">
        {{ users.length.toLocaleString() }} {{ users.length === 1 ? 'user' : 'users' }}
      </span>
    </div>

    <!-- Bulk action bar — only when selections exist. Sticky so it
         follows the operator while they scan / scroll. -->
    <div
      v-if="selected.size > 0"
      class="sticky top-2 z-20 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5 shadow-sm"
    >
      <p class="text-sm font-semibold text-foreground tabular-nums">
        {{ selected.size }} selected
      </p>
      <span class="text-xs text-muted-foreground">Set role to</span>
      <select
        v-model="bulkRole"
        :disabled="bulkSubmitting"
        class="rounded-md border border-border bg-card px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
      >
        <option value="">Pick a role…</option>
        <option value="admin">Admin</option>
        <option value="manager">Manager</option>
        <option value="agent">Agent</option>
      </select>
      <button
        type="button"
        class="rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="!bulkRole || bulkSubmitting"
        @click="applyBulkRoleChange"
      >
        {{ bulkSubmitting ? 'Updating…' : 'Apply' }}
      </button>
      <span
        v-if="bulkProgress"
        class="text-xs tabular-nums text-muted-foreground"
      >
        {{ bulkProgress.done }} / {{ bulkProgress.total }}
        <span v-if="bulkProgress.failed > 0" class="text-destructive">
          · {{ bulkProgress.failed }} failed
        </span>
      </span>
      <button
        type="button"
        class="ml-auto rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        :disabled="bulkSubmitting"
        @click="clearSelection"
      >
        Clear selection
      </button>
    </div>

    <!-- Loading skeleton matches the table column layout. -->
    <div
      v-if="isLoading"
      class="overflow-hidden rounded-lg border border-border bg-card"
    >
      <div class="border-b border-border bg-muted-foreground/5 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Users
      </div>
      <div
        v-for="n in 6"
        :key="n"
        class="grid grid-cols-[1.5rem_2.5rem_1fr_5rem_8rem_5rem_5rem_5rem_2.5rem] items-center gap-3 border-b border-border px-4 py-3 last:border-0"
      >
        <Skeleton class="h-4 w-4" />
        <Skeleton shape="circle" class="h-9 w-9" />
        <div class="space-y-1.5">
          <Skeleton class="h-3 w-3/4" />
          <Skeleton class="h-2.5 w-1/2" />
        </div>
        <Skeleton class="h-5 w-14 rounded-full" />
        <Skeleton class="h-3 w-24" />
        <Skeleton class="h-5 w-16 rounded-full" />
        <Skeleton class="h-3 w-12" />
        <Skeleton class="h-3 w-12" />
        <Skeleton class="h-5 w-5 rounded" />
      </div>
    </div>

    <section
      v-else-if="errorMessage"
      class="rounded-lg border border-destructive/30 bg-destructive/10 p-6 text-center"
    >
      <p class="text-sm text-destructive">{{ errorMessage }}</p>
      <button
        type="button"
        class="mt-3 rounded-lg bg-destructive px-3 py-1.5 text-xs font-semibold text-destructive-foreground transition-colors duration-150 ease-out hover:bg-destructive/90 focus-ring"
        @click="load"
      >
        Try again
      </button>
    </section>

    <section
      v-else-if="users.length === 0"
      class="rounded-lg border border-border bg-card"
    >
      <EmptyState
        variant="neutral"
        size="cozy"
        title="No users match this filter"
        description="Adjust the search or role filter to widen the result set."
      />
    </section>

    <div
      v-else
      class="overflow-hidden rounded-lg border border-border bg-card"
    >
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="sticky top-0 z-10 bg-card">
            <tr class="border-b border-border bg-muted-foreground/5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <th class="w-10 px-4 py-2.5 text-left" scope="col">
                <input
                  type="checkbox"
                  class="cursor-pointer accent-blue-600"
                  :checked="allOnPageSelected"
                  :aria-label="allOnPageSelected ? 'Deselect all on page' : 'Select all on page'"
                  @change="toggleAllOnPage"
                />
              </th>
              <th class="px-4 py-2.5 text-left" scope="col">User</th>
              <th class="px-4 py-2.5 text-left" scope="col">Role</th>
              <th class="px-4 py-2.5 text-left" scope="col">Organization</th>
              <th class="px-4 py-2.5 text-left" scope="col">Verified</th>
              <th class="px-4 py-2.5 text-left" scope="col">Last active</th>
              <th class="px-4 py-2.5 text-left" scope="col">Joined</th>
              <th class="w-12 px-4 py-2.5 text-right" scope="col">
                <span class="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            <tr
              v-for="user in users"
              :key="user.id"
              class="transition-colors hover:bg-accent/40"
              :class="
                editingId === user.id
                  ? 'bg-accent/60'
                  : selected.has(user.id)
                    ? 'bg-accent/40'
                    : ''
              "
            >
              <!-- Selection cell -->
              <td class="px-4 py-3">
                <input
                  type="checkbox"
                  class="cursor-pointer accent-blue-600"
                  :checked="selected.has(user.id)"
                  :aria-label="`Select ${user.full_name || user.email || user.id}`"
                  @change="toggleRowSelection(user.id)"
                />
              </td>

              <!-- User cell: avatar + name + email -->
              <td class="px-4 py-3">
                <div class="flex items-center gap-3">
                  <div
                    class="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted-foreground/10 text-sm font-semibold text-foreground/70"
                    aria-hidden="true"
                  >
                    <img
                      v-if="user.avatar_url"
                      :src="user.avatar_url"
                      :alt="user.full_name || user.email || 'User avatar'"
                      class="h-full w-full object-cover"
                      loading="lazy"
                      referrerpolicy="no-referrer"
                    />
                    <span v-else>{{ initial(user) }}</span>
                  </div>
                  <div class="min-w-0">
                    <p class="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                      <span class="truncate">{{ user.full_name || '(no name)' }}</span>
                      <span
                        v-if="user.id === display.id"
                        class="rounded bg-muted-foreground/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-foreground/70"
                      >
                        You
                      </span>
                    </p>
                    <p class="truncate text-xs text-muted-foreground">
                      {{ user.email || '—' }}
                    </p>
                  </div>
                </div>
              </td>

              <!-- Role cell: badge by default; select+save when editing. -->
              <td class="px-4 py-3">
                <div v-if="editingId === user.id" class="flex items-center gap-2">
                  <select
                    v-model="pendingRole[user.id]"
                    class="rounded-md border border-border bg-card px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    :disabled="savingId === user.id"
                  >
                    <option value="admin">Admin</option>
                    <option value="manager">Manager</option>
                    <option value="agent">Agent</option>
                  </select>
                  <button
                    type="button"
                    class="rounded-lg bg-primary px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                    :disabled="!isDirty(user) || savingId === user.id"
                    @click="save(user)"
                  >
                    {{ savingId === user.id ? 'Saving…' : 'Save' }}
                  </button>
                  <button
                    type="button"
                    class="rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-60"
                    :disabled="savingId === user.id"
                    @click="cancelEdit(user)"
                  >
                    Cancel
                  </button>
                </div>
                <button
                  v-else
                  type="button"
                  class="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 transition-opacity hover:opacity-80"
                  :class="roleBadgeClass(user.role)"
                  :disabled="isLocked(user)"
                  :title="isLocked(user) ? 'Cannot demote the only remaining admin' : 'Click to change role'"
                  @click="startEdit(user)"
                >
                  {{ user.role }}
                </button>
              </td>

              <!-- Organization cell -->
              <td class="px-4 py-3">
                <div v-if="user.organization" class="text-xs">
                  <p class="font-medium text-foreground">
                    {{ user.organization.name }}
                  </p>
                  <p class="font-mono text-[10px] capitalize text-muted-foreground">
                    {{ user.organization.role.replace(/_/g, ' ') }}
                  </p>
                </div>
                <span v-else class="text-xs text-muted-foreground">—</span>
              </td>

              <!-- Verified cell -->
              <td class="px-4 py-3">
                <span
                  v-if="user.verified"
                  class="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-success ring-1 ring-success/30"
                  title="Approved profile_verifications row"
                >
                  <CheckDecagram :size="12" />
                  Verified
                </span>
                <span v-else class="text-xs text-muted-foreground">—</span>
              </td>

              <!-- Last active cell -->
              <td class="px-4 py-3 text-xs text-muted-foreground">
                <span :title="user.last_active_at ? new Date(user.last_active_at).toLocaleString() : ''">
                  {{ formatLastActive(user.last_active_at) }}
                </span>
              </td>

              <!-- Joined cell -->
              <td class="px-4 py-3 text-xs text-muted-foreground">
                <span :title="formatJoined(user.created_at).title">
                  {{ formatJoined(user.created_at).label }}
                </span>
              </td>

              <!-- Actions cell: … menu -->
              <td class="px-4 py-3 text-right">
                <div class="relative inline-block" v-on-clickaway="closeMenu">
                  <button
                    type="button"
                    class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    aria-label="Row actions"
                    @click.stop="toggleMenu(user)"
                  >
                    <DotsHorizontal :size="16" />
                  </button>
                  <transition
                    enter-active-class="transition duration-100 ease-out"
                    enter-from-class="transform scale-95 opacity-0"
                    enter-to-class="transform scale-100 opacity-100"
                    leave-active-class="transition duration-75 ease-in"
                    leave-from-class="transform scale-100 opacity-100"
                    leave-to-class="transform scale-95 opacity-0"
                  >
                    <div
                      v-show="openMenuId === user.id"
                      class="absolute right-0 top-full z-20 mt-1 w-44 origin-top-right rounded-xl border border-border bg-card text-left shadow-lg ring-1 ring-black/5"
                      role="menu"
                    >
                      <ul class="py-1">
                        <li>
                          <button
                            type="button"
                            class="block w-full px-3 py-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                            :disabled="isLocked(user)"
                            @click="closeMenu(); startEdit(user)"
                          >
                            Change role
                          </button>
                        </li>
                      </ul>
                    </div>
                  </transition>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>
