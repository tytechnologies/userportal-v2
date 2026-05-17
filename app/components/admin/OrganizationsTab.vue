<script setup lang="ts">
/**
 * Admin Organizations tab.
 *
 * Lists all organizations with branch + member counts. Per-org
 * drilldown opens an inline panel showing branches, members, and
 * forms for adding more. Org creation lives in a top-of-tab form.
 *
 * Service-role mutations all happen behind /api/admin/organizations
 * (admin-gated). RLS policies on the underlying tables prevent
 * non-admin authenticated clients from touching them directly.
 */
import { ref, computed, onMounted, watch } from 'vue'
import { showToast } from '~/helpers/helpers'
import UserPicker from '~/components/ui/UserPicker.vue'

type OrgRow = {
  id: string
  name: string
  slug: string
  verified: boolean
  owner_user_id: string | null
  description: string | null
  owner: { id: string; full_name: string | null; email: string | null } | null
  branch_count: number
  member_count: number
  created_at: string
}

type DetailPayload = {
  organization: {
    id: string
    name: string
    slug: string
    verified: boolean
    owner_user_id: string | null
    description: string | null
    branding: Record<string, unknown>
    owner: { id: string; full_name: string | null; email: string | null; avatar_url: string | null } | null
  }
  branches: Array<{
    id: string
    name: string
    slug: string
    address: string | null
    manager_user_id: string | null
    active: boolean
    manager: { id: string; full_name: string | null } | null
  }>
  members: Array<{
    id: string
    user_id: string
    org_role: string
    status: string
    branch_id: string | null
    joined_at: string | null
    profile: { id: string; full_name: string | null; email: string | null; avatar_url: string | null } | null
  }>
}

const orgs = ref<OrgRow[]>([])
const orgsLoading = ref(true)
const expandedId = ref<string | null>(null)
const detail = ref<DetailPayload | null>(null)
const detailLoading = ref(false)

// Create-org form
const showCreate = ref(false)
const createForm = ref({
  name: '',
  slug: '',
  owner_user_id: '',
  description: '',
  verified: false,
})
const creating = ref(false)

// Add-branch + add-member form state (per-org)
const showAddBranch = ref(false)
const branchForm = ref({ name: '', slug: '', address: '', manager_user_id: '' })
const addingBranch = ref(false)

const showAddMember = ref(false)
const memberForm = ref({
  user_id: '',
  org_role: 'senior_agent' as 'brokerage_owner' | 'branch_manager' | 'team_lead' | 'senior_agent' | 'junior_agent' | 'assistant',
  branch_id: '',
  status: 'active' as 'active' | 'pending' | 'trial',
})
const addingMember = ref(false)

async function loadOrgs() {
  orgsLoading.value = true
  try {
    const res = await $fetch<{ organizations: OrgRow[] }>('/api/admin/organizations')
    orgs.value = res.organizations ?? []
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load organizations',
      icon: 'error',
    })
  } finally {
    orgsLoading.value = false
  }
}

async function loadDetail(orgId: string) {
  detailLoading.value = true
  detail.value = null
  try {
    const res = await $fetch<DetailPayload>(`/api/admin/organizations/${orgId}`)
    detail.value = res
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load organization',
      icon: 'error',
    })
  } finally {
    detailLoading.value = false
  }
}

function toggleExpanded(orgId: string) {
  if (expandedId.value === orgId) {
    expandedId.value = null
    detail.value = null
    return
  }
  expandedId.value = orgId
  showAddBranch.value = false
  showAddMember.value = false
  loadDetail(orgId)
}

async function submitCreate() {
  if (!createForm.value.name || !createForm.value.slug || !createForm.value.owner_user_id) {
    showToast({ title: 'Name, slug, and owner are required', icon: 'warning' })
    return
  }
  creating.value = true
  try {
    await $fetch('/api/admin/organizations', {
      method: 'POST',
      body: {
        name: createForm.value.name.trim(),
        slug: createForm.value.slug.trim(),
        owner_user_id: createForm.value.owner_user_id.trim(),
        description: createForm.value.description.trim() || null,
        verified: createForm.value.verified,
      },
    })
    showToast({ title: `Created "${createForm.value.name}"`, icon: 'success' })
    showCreate.value = false
    createForm.value = { name: '', slug: '', owner_user_id: '', description: '', verified: false }
    await loadOrgs()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to create',
      icon: 'error',
    })
  } finally {
    creating.value = false
  }
}

async function toggleVerified(org: OrgRow) {
  try {
    await $fetch(`/api/admin/organizations/${org.id}`, {
      method: 'PATCH',
      body: { verified: !org.verified },
    })
    showToast({
      title: org.verified ? 'Marked unverified' : 'Marked verified',
      icon: 'success',
    })
    await loadOrgs()
    if (expandedId.value === org.id) await loadDetail(org.id)
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to update',
      icon: 'error',
    })
  }
}

async function submitAddBranch() {
  if (!detail.value || !branchForm.value.name || !branchForm.value.slug) {
    showToast({ title: 'Name and slug are required', icon: 'warning' })
    return
  }
  addingBranch.value = true
  try {
    await $fetch(`/api/admin/organizations/${detail.value.organization.id}/branches`, {
      method: 'POST',
      body: {
        name:            branchForm.value.name.trim(),
        slug:            branchForm.value.slug.trim(),
        address:         branchForm.value.address.trim() || null,
        manager_user_id: branchForm.value.manager_user_id.trim() || null,
      },
    })
    showToast({ title: 'Branch added', icon: 'success' })
    showAddBranch.value = false
    branchForm.value = { name: '', slug: '', address: '', manager_user_id: '' }
    await loadDetail(detail.value.organization.id)
    await loadOrgs()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to add branch',
      icon: 'error',
    })
  } finally {
    addingBranch.value = false
  }
}

async function submitAddMember() {
  if (!detail.value || !memberForm.value.user_id) {
    showToast({ title: 'User id is required', icon: 'warning' })
    return
  }
  addingMember.value = true
  try {
    await $fetch(`/api/admin/organizations/${detail.value.organization.id}/members`, {
      method: 'POST',
      body: {
        user_id:   memberForm.value.user_id.trim(),
        org_role:  memberForm.value.org_role,
        branch_id: memberForm.value.branch_id || null,
        status:    memberForm.value.status,
      },
    })
    showToast({ title: 'Member added', icon: 'success' })
    showAddMember.value = false
    memberForm.value = { user_id: '', org_role: 'senior_agent', branch_id: '', status: 'active' }
    await loadDetail(detail.value.organization.id)
    await loadOrgs()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to add member',
      icon: 'error',
    })
  } finally {
    addingMember.value = false
  }
}

onMounted(loadOrgs)
</script>

<template>
  <section class="space-y-4">
    <header class="flex flex-wrap items-baseline justify-between gap-2">
      <div>
        <h2 class="text-sm font-semibold text-foreground">Organizations</h2>
        <p class="text-xs text-muted-foreground">
          Brokerage hierarchy. Create an org, assign an owner, then add branches and members.
        </p>
      </div>
      <button
        type="button"
        class="rounded-md border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary hover:bg-primary/15"
        @click="showCreate = !showCreate"
      >
        {{ showCreate ? 'Cancel' : '+ New organization' }}
      </button>
    </header>

    <!-- Create form -->
    <div
      v-if="showCreate"
      class="rounded-xl border border-primary/30 bg-primary/10 p-4"
    >
      <h3 class="text-xs font-semibold text-primary">Create organization</h3>
      <div class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label class="text-xs">
          <span class="font-semibold text-foreground">Name</span>
          <input
            v-model="createForm.name"
            type="text"
            class="mt-1 w-full rounded-md border border-border px-2 py-1 text-sm"
            placeholder="Acme Brokerage"
          />
        </label>
        <label class="text-xs">
          <span class="font-semibold text-foreground">Slug (lowercase, hyphens)</span>
          <input
            v-model="createForm.slug"
            type="text"
            class="mt-1 w-full rounded-md border border-border px-2 py-1 text-sm font-mono"
            placeholder="acme-brokerage"
          />
        </label>
        <label class="text-xs sm:col-span-2">
          <span class="font-semibold text-foreground">Owner</span>
          <UserPicker
            v-model="createForm.owner_user_id"
            placeholder="Search by name or email…"
            class="mt-1"
          />
        </label>
        <label class="text-xs sm:col-span-2">
          <span class="font-semibold text-foreground">Description (optional)</span>
          <textarea
            v-model="createForm.description"
            rows="2"
            class="mt-1 w-full rounded-md border border-border px-2 py-1 text-sm"
          />
        </label>
        <label class="flex items-center gap-2 text-xs">
          <input v-model="createForm.verified" type="checkbox" class="h-3.5 w-3.5 cursor-pointer accent-blue-500" />
          <span>Verified (badge on public surfaces)</span>
        </label>
      </div>
      <div class="mt-3 flex gap-2">
        <button
          type="button"
          class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary/90 disabled:opacity-50"
          :disabled="creating"
          @click="submitCreate"
        >
          {{ creating ? 'Creating…' : 'Create' }}
        </button>
        <button
          type="button"
          class="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-accent hover:text-accent-foreground"
          @click="showCreate = false"
        >
          Cancel
        </button>
      </div>
    </div>

    <!-- List -->
    <div
      v-if="orgsLoading"
      class="rounded-xl border border-border bg-background p-6 text-center text-xs text-muted-foreground"
    >
      Loading organizations…
    </div>
    <div
      v-else-if="orgs.length === 0"
      class="rounded-xl border border-dashed border-border bg-muted/50 p-6 text-center text-xs text-muted-foreground"
    >
      No organizations yet. Create the first brokerage above.
    </div>
    <div v-else class="space-y-2">
      <div
        v-for="o in orgs"
        :key="o.id"
        class="rounded-xl border border-border bg-background"
      >
        <button
          type="button"
          class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent hover:text-accent-foreground"
          @click="toggleExpanded(o.id)"
        >
          <div class="flex-1">
            <div class="flex flex-wrap items-baseline gap-2">
              <p class="text-sm font-semibold text-foreground">{{ o.name }}</p>
              <p class="text-[11px] font-mono text-muted-foreground">{{ o.slug }}</p>
              <span v-if="o.verified" class="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">verified</span>
            </div>
            <p class="text-[11px] text-muted-foreground">
              {{ o.owner?.full_name || o.owner?.email || '— no owner —' }}
              · {{ o.branch_count }} branch{{ o.branch_count === 1 ? '' : 'es' }}
              · {{ o.member_count }} member{{ o.member_count === 1 ? '' : 's' }}
            </p>
          </div>
          <span class="text-xs text-muted-foreground/70">
            {{ expandedId === o.id ? '▾' : '▸' }}
          </span>
        </button>

        <div
          v-if="expandedId === o.id"
          class="border-t border-border bg-muted/40 p-4"
        >
          <div v-if="detailLoading" class="text-xs text-muted-foreground">Loading…</div>
          <div v-else-if="detail" class="space-y-4">
            <!-- Toolbar -->
            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                class="rounded-md border border-border bg-background px-2 py-1 text-[11px] font-semibold text-foreground hover:bg-accent hover:text-accent-foreground"
                @click="toggleVerified(o)"
              >
                {{ o.verified ? 'Mark unverified' : 'Mark verified' }}
              </button>
              <button
                type="button"
                class="rounded-md border border-primary/30 bg-primary/10 px-2 py-1 text-[11px] font-semibold text-primary hover:bg-primary/15"
                @click="showAddBranch = !showAddBranch; showAddMember = false"
              >
                {{ showAddBranch ? 'Cancel branch' : '+ Branch' }}
              </button>
              <button
                type="button"
                class="rounded-md border border-success/30 bg-success/10 px-2 py-1 text-[11px] font-semibold text-success hover:bg-success/15"
                @click="showAddMember = !showAddMember; showAddBranch = false"
              >
                {{ showAddMember ? 'Cancel member' : '+ Member' }}
              </button>
            </div>

            <!-- Add-branch form -->
            <div
              v-if="showAddBranch"
              class="rounded-md border border-primary/30 bg-card p-3"
            >
              <p class="text-xs font-semibold text-primary">New branch</p>
              <div class="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input v-model="branchForm.name" type="text" class="rounded-md border border-border px-2 py-1 text-sm" placeholder="Name" />
                <input v-model="branchForm.slug" type="text" class="rounded-md border border-border px-2 py-1 text-sm font-mono" placeholder="slug" />
                <input v-model="branchForm.address" type="text" class="rounded-md border border-border px-2 py-1 text-sm sm:col-span-2" placeholder="Address (optional)" />
                <div class="sm:col-span-2">
                  <UserPicker
                    v-model="branchForm.manager_user_id"
                    placeholder="Branch manager (optional, search name or email)"
                  />
                </div>
              </div>
              <button
                type="button"
                class="mt-2 rounded-md bg-primary px-3 py-1 text-xs font-semibold text-white hover:bg-primary/90 disabled:opacity-50"
                :disabled="addingBranch"
                @click="submitAddBranch"
              >
                {{ addingBranch ? 'Adding…' : 'Add branch' }}
              </button>
            </div>

            <!-- Add-member form -->
            <div
              v-if="showAddMember"
              class="rounded-md border border-success/30 bg-card p-3"
            >
              <p class="text-xs font-semibold text-success">New member</p>
              <div class="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div class="sm:col-span-2">
                  <UserPicker
                    v-model="memberForm.user_id"
                    placeholder="Search user by name or email…"
                  />
                </div>
                <select v-model="memberForm.org_role" class="rounded-md border border-border px-2 py-1 text-sm">
                  <option value="brokerage_owner">brokerage_owner</option>
                  <option value="branch_manager">branch_manager</option>
                  <option value="team_lead">team_lead</option>
                  <option value="senior_agent">senior_agent</option>
                  <option value="junior_agent">junior_agent</option>
                  <option value="assistant">assistant</option>
                </select>
                <select v-model="memberForm.branch_id" class="rounded-md border border-border px-2 py-1 text-sm">
                  <option value="">— no branch —</option>
                  <option v-for="b in detail.branches" :key="b.id" :value="b.id">{{ b.name }}</option>
                </select>
                <select v-model="memberForm.status" class="rounded-md border border-border px-2 py-1 text-sm sm:col-span-2">
                  <option value="active">active</option>
                  <option value="trial">trial (probationary)</option>
                  <option value="pending">pending (awaiting accept)</option>
                </select>
              </div>
              <button
                type="button"
                class="mt-2 rounded-md bg-success px-3 py-1 text-xs font-semibold text-success-foreground hover:bg-success/90 disabled:opacity-50"
                :disabled="addingMember"
                @click="submitAddMember"
              >
                {{ addingMember ? 'Adding…' : 'Add member' }}
              </button>
            </div>

            <!-- Branches table -->
            <div>
              <p class="mb-1 text-xs font-semibold text-foreground">
                Branches ({{ detail.branches.length }})
              </p>
              <div
                v-if="detail.branches.length === 0"
                class="rounded-md border border-border bg-muted/50 p-2 text-[11px] text-muted-foreground"
              >
                No branches yet.
              </div>
              <table v-else class="w-full text-left text-xs">
                <thead class="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th class="py-1 pr-2 font-semibold">Name</th>
                    <th class="py-1 pr-2 font-semibold">Slug</th>
                    <th class="py-1 pr-2 font-semibold">Manager</th>
                    <th class="py-1 font-semibold">Address</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-border">
                  <tr v-for="b in detail.branches" :key="b.id">
                    <td class="py-1.5 pr-2 font-medium">{{ b.name }}</td>
                    <td class="py-1.5 pr-2 font-mono text-[11px] text-muted-foreground">{{ b.slug }}</td>
                    <td class="py-1.5 pr-2">{{ b.manager?.full_name || '—' }}</td>
                    <td class="py-1.5 text-muted-foreground">{{ b.address || '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- Members table -->
            <div>
              <p class="mb-1 text-xs font-semibold text-foreground">
                Members ({{ detail.members.length }})
              </p>
              <div
                v-if="detail.members.length === 0"
                class="rounded-md border border-border bg-muted/50 p-2 text-[11px] text-muted-foreground"
              >
                No members yet.
              </div>
              <table v-else class="w-full text-left text-xs">
                <thead class="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th class="py-1 pr-2 font-semibold">Member</th>
                    <th class="py-1 pr-2 font-semibold">Role</th>
                    <th class="py-1 pr-2 font-semibold">Branch</th>
                    <th class="py-1 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-border">
                  <tr v-for="m in detail.members" :key="m.id">
                    <td class="py-1.5 pr-2">
                      <div class="flex items-center gap-2">
                        <img
                          v-if="m.profile?.avatar_url"
                          :src="m.profile.avatar_url"
                          class="h-5 w-5 rounded-full object-cover"
                          alt=""
                        />
                        <span class="font-medium">{{ m.profile?.full_name || m.profile?.email || m.user_id.slice(0, 8) }}</span>
                      </div>
                    </td>
                    <td class="py-1.5 pr-2 font-mono text-[11px] text-muted-foreground">{{ m.org_role }}</td>
                    <td class="py-1.5 pr-2 text-muted-foreground">
                      {{ detail.branches.find(b => b.id === m.branch_id)?.name || '—' }}
                    </td>
                    <td class="py-1.5">
                      <span
                        class="rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                        :class="m.status === 'active'
                          ? 'bg-success/15 text-success'
                          : m.status === 'trial'
                            ? 'bg-warning/15 text-warning'
                            : 'bg-muted text-foreground'"
                      >{{ m.status }}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
