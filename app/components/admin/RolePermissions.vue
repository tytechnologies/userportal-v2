<script setup lang="ts">
// Role × Permission matrix. Three rows (admin / manager / agent), one
// column per permission grouped by category.
//
// Toggle semantics: an unchecked → checked transition INSERTs into
// role_permissions; checked → unchecked DELETEs. Both are RLS-gated
// (only admins can write — policy `role_permissions_admin_write`).
//
// Optimistic updates: we flip the local state first, then await the
// network. On failure we roll back AND show a toast. This keeps the UI
// crisp on a high-latency connection without lying to the user.

import { computed, onMounted, ref } from 'vue'
import {
  useAdmin,
  type Permission,
  type RolePermission,
} from '~/composables/useAdmin'
import type { Role } from '~/composables/useAuth'
import { clearPermissionCache } from '~/composables/useAuth'
import { showToast } from '~/helpers/helpers'

const ROLES: Role[] = ['admin', 'manager', 'agent']
const ROLE_LABEL: Record<Role, string> = {
  admin: 'Admin',
  manager: 'Manager',
  agent: 'Agent',
}

const { listPermissions, listRolePermissions, addRolePermission, removeRolePermission } =
  useAdmin()

const permissions = ref<Permission[]>([])
const bindings = ref<Set<string>>(new Set())
const isLoading = ref(true)
const errorMessage = ref<string | null>(null)
const pendingKeys = ref<Set<string>>(new Set())

// Cache key: `${role}::${permission}`. Set membership = "this role has
// this permission". Single set keeps `has()` checks O(1) regardless of
// how many roles / permissions exist.
const key = (role: Role, perm: string) => `${role}::${perm}`

async function load() {
  isLoading.value = true
  errorMessage.value = null
  try {
    const [perms, links] = await Promise.all([listPermissions(), listRolePermissions()])
    permissions.value = perms
    bindings.value = new Set(links.map((l: RolePermission) => key(l.role, l.permission)))
  } catch (err: any) {
    errorMessage.value = err?.message ?? 'Failed to load permissions.'
  } finally {
    isLoading.value = false
  }
}

onMounted(load)

// Group permissions by `category` for the matrix headings.
const grouped = computed(() => {
  const map = new Map<string, Permission[]>()
  for (const p of permissions.value) {
    const cat = p.category || 'general'
    if (!map.has(cat)) map.set(cat, [])
    map.get(cat)!.push(p)
  }
  return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))
})

const totalPerRole = computed<Record<Role, number>>(() => {
  const counts: Record<Role, number> = { admin: 0, manager: 0, agent: 0 }
  for (const k of bindings.value) {
    const role = k.split('::')[0] as Role
    if (counts[role] !== undefined) counts[role] += 1
  }
  return counts
})

function isOn(role: Role, perm: string): boolean {
  return bindings.value.has(key(role, perm))
}

function isPending(role: Role, perm: string): boolean {
  return pendingKeys.value.has(key(role, perm))
}

async function toggle(role: Role, perm: string) {
  const k = key(role, perm)
  if (pendingKeys.value.has(k)) return
  const wasOn = bindings.value.has(k)

  // Optimistic flip.
  const next = new Set(bindings.value)
  if (wasOn) next.delete(k)
  else next.add(k)
  bindings.value = next
  pendingKeys.value.add(k)

  try {
    if (wasOn) {
      await removeRolePermission(role, perm)
    } else {
      await addRolePermission(role, perm)
    }
    // The /admin caller (and possibly other tabs) cached has_permission()
    // results — invalidate so the next check reflects the new binding.
    clearPermissionCache()
  } catch (err: any) {
    // Roll back the optimistic flip.
    const rolled = new Set(bindings.value)
    if (wasOn) rolled.add(k)
    else rolled.delete(k)
    bindings.value = rolled
    showToast({
      title: err?.message ?? 'Could not update permission.',
      icon: 'error',
    })
  } finally {
    pendingKeys.value.delete(k)
  }
}
</script>

<template>
  <section class="space-y-4">
    <header class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h2 class="text-base font-semibold text-foreground">Roles &amp; Permissions</h2>
        <p class="mt-0.5 text-xs text-muted-foreground">
          Toggle which permissions each role has. Changes apply immediately
          and affect every user with that role.
        </p>
      </div>
      <!-- Per-role count chips. Color-coded to match the Users table:
           admin=red, manager=blue, agent=muted neutral. -->
      <div class="flex flex-wrap items-center gap-1.5">
        <span
          v-for="role in ROLES"
          :key="role"
          class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1"
          :class="
            role === 'admin'
              ? 'bg-destructive/10 text-destructive ring-destructive/30'
              : role === 'manager'
                ? 'bg-primary/10 text-primary ring-primary/30'
                : 'bg-muted-foreground/10 text-foreground/80 ring-muted-foreground/15'
          "
        >
          {{ ROLE_LABEL[role] }}
          <span class="tabular-nums opacity-70">·</span>
          <span class="tabular-nums">{{ totalPerRole[role] }}</span>
        </span>
      </div>
    </header>

    <!-- Loading skeleton resembles a category card with a 4-row matrix. -->
    <div
      v-if="isLoading"
      class="space-y-4"
    >
      <div
        v-for="i in 2"
        :key="i"
        class="rounded-lg border border-border bg-card"
      >
        <div class="border-b border-border px-4 py-3">
          <Skeleton class="h-3 w-24" />
        </div>
        <div class="space-y-3 p-4">
          <div v-for="n in 4" :key="n" class="grid grid-cols-[1fr_3rem_3rem_3rem] items-center gap-3">
            <div class="space-y-1">
              <Skeleton class="h-3 w-1/3" />
              <Skeleton class="h-2.5 w-2/3" />
            </div>
            <Skeleton class="mx-auto h-4 w-4 rounded" />
            <Skeleton class="mx-auto h-4 w-4 rounded" />
            <Skeleton class="mx-auto h-4 w-4 rounded" />
          </div>
        </div>
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
      v-else-if="permissions.length === 0"
      class="rounded-lg border border-border bg-card"
    >
      <EmptyState
        variant="neutral"
        size="cozy"
        title="No permissions defined"
        description="The permissions catalog is empty. Defined via the migrations under public.permissions."
      />
    </section>

    <div v-else class="space-y-4">
      <article
        v-for="[category, perms] in grouped"
        :key="category"
        class="overflow-hidden rounded-lg border border-border bg-card"
      >
        <header class="flex items-center justify-between border-b border-border px-5 py-3">
          <h3 class="text-sm font-semibold capitalize text-foreground">
            {{ category }}
          </h3>
          <span class="text-xs tabular-nums text-muted-foreground">
            {{ perms.length }} {{ perms.length === 1 ? 'permission' : 'permissions' }}
          </span>
        </header>
        <div class="overflow-x-auto">
          <table class="min-w-full text-sm">
            <thead>
              <tr class="border-b border-border bg-muted-foreground/5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                <th class="w-1/2 px-5 py-2 text-left">Permission</th>
                <th
                  v-for="role in ROLES"
                  :key="role"
                  class="px-4 py-2 text-center"
                >
                  {{ ROLE_LABEL[role] }}
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              <tr
                v-for="perm in perms"
                :key="perm.name"
                class="transition-colors hover:bg-accent/30"
              >
                <td class="px-5 py-2.5">
                  <p class="font-mono text-xs text-foreground">{{ perm.name }}</p>
                  <p class="mt-0.5 text-xs text-muted-foreground">
                    {{ perm.description }}
                  </p>
                </td>
                <td
                  v-for="role in ROLES"
                  :key="role"
                  class="px-4 py-2.5 text-center"
                >
                  <input
                    type="checkbox"
                    class="h-4 w-4 cursor-pointer rounded border-border accent-blue-600 disabled:cursor-not-allowed disabled:opacity-60"
                    :checked="isOn(role, perm.name)"
                    :disabled="isPending(role, perm.name)"
                    :aria-label="`${ROLE_LABEL[role]} has ${perm.name}`"
                    @change="toggle(role, perm.name)"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </article>
    </div>
  </section>
</template>
