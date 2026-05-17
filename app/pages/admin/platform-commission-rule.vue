<script setup lang="ts">
/**
 * /admin/platform-commission-rule — tune the platform's take.
 *
 * Single-row config from platform_commission_rules. Changes take
 * effect immediately for new closed_won transitions; existing
 * projected charges keep the rate that was active at trigger time.
 *
 * Three knobs:
 *   - default_pct (0–100)
 *   - basis_kind: percent_of_commission | percent_of_deal_value | fixed
 *   - active toggle (kill switch)
 *
 * Per-stage / per-org overrides exist in the schema but are out of
 * scope here — operator edits via SQL when needed (rare).
 */

import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { hasPermission } from '~/composables/useAuth'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })
useHead({ title: 'Commission Rule | Admin' })

type Rule = {
  id: number
  default_pct: number
  basis_kind: 'percent_of_commission' | 'percent_of_deal_value' | 'fixed'
  applies_to: string[]
  by_stage: Record<string, number>
  by_org: Record<string, number>
  active: boolean
  effective_at: string
  notes: string | null
  updated_by: string | null
  updated_at: string
  created_at: string
}

const router = useRouter()
const isChecking = ref(true)
const allowed = ref(false)

const rule = ref<Rule | null>(null)
const loading = ref(false)
const saving = ref(false)

// Form state. Mirrors the rule; we never edit `rule` directly so a failed
// save doesn't leave the UI in an inconsistent state.
const form = ref({
  default_pct: 5.0 as number,
  basis_kind: 'percent_of_commission' as Rule['basis_kind'],
  active: true as boolean,
  notes: '' as string,
})

const dirty = computed(() => {
  if (!rule.value) return false
  return (
    form.value.default_pct !== Number(rule.value.default_pct) ||
    form.value.basis_kind !== rule.value.basis_kind ||
    form.value.active !== rule.value.active ||
    (form.value.notes ?? '') !== (rule.value.notes ?? '')
  )
})

const previewLine = computed(() => {
  switch (form.value.basis_kind) {
    case 'percent_of_commission':
      return `For every ₱100,000 of broker net commission, the platform takes ₱${(
        form.value.default_pct * 1000
      ).toLocaleString('en-PH', { minimumFractionDigits: 2 })}.`
    case 'percent_of_deal_value':
      return `For every ₱1,000,000 of deal value, the platform takes ₱${(
        form.value.default_pct * 10000
      ).toLocaleString('en-PH', { minimumFractionDigits: 2 })}.`
    case 'fixed':
      return `Each closed deal pays a flat ${form.value.default_pct.toLocaleString(
        'en-PH',
      )} centavos (â‰ˆ ₱${(form.value.default_pct / 100).toFixed(2)}).`
  }
})

async function load() {
  loading.value = true
  try {
    const res = await $fetch<Rule>('/api/admin/platform-commission-rule')
    rule.value = res
    form.value = {
      default_pct: Number(res.default_pct),
      basis_kind: res.basis_kind,
      active: res.active,
      notes: res.notes ?? '',
    }
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not load rule', icon: 'error' })
  } finally {
    loading.value = false
  }
}

async function save() {
  if (!dirty.value) return
  saving.value = true
  try {
    const res = await $fetch<Rule>('/api/admin/platform-commission-rule', {
      method: 'PATCH',
      body: {
        default_pct: form.value.default_pct,
        basis_kind: form.value.basis_kind,
        active: form.value.active,
        notes: form.value.notes || null,
      },
    })
    rule.value = res
    showToast({ title: 'Commission rule updated' })
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Could not save',
      icon: 'error',
    })
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  const ok = (await hasPermission('platform_fees.manage')) || (await hasPermission('admin.access'))
  isChecking.value = false
  if (!ok) {
    showToast({
      title: 'You do not have access to commission rules.',
      icon: 'warning',
    })
    router.replace('/dashboard')
    return
  }
  allowed.value = true
  await load()
})
</script>

<template>
  <div class="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
    <div
      v-if="isChecking"
      class="rounded-lg border border-border bg-card p-5 text-center text-sm text-muted-foreground"
    >
      Checking access…
    </div>

    <template v-else-if="allowed">
      <div>
        <NuxtLink
          to="/admin/platform-fees"
          class="text-sm text-primary hover:underline"
        >
          ← Back to Platform Fees
        </NuxtLink>
        <h1 class="mt-2 text-2xl font-semibold text-foreground">
          Commission Rule
        </h1>
        <p class="mt-1 text-sm text-muted-foreground">
          Sets the platform's take on every closed deal. Single-row config — changes
          apply to new closures, not retroactive to projected charges already created.
        </p>
      </div>

      <div
        v-if="loading"
        class="rounded-lg border border-border bg-card p-5 text-center text-sm text-muted-foreground"
      >
        Loading…
      </div>

      <form
        v-else-if="rule"
        class="space-y-6"
        @submit.prevent="save"
      >
        <!-- Active kill switch -->
        <section
          class="rounded-lg border border-border bg-card p-5 text-card-foreground"
          :class="form.active ? 'border-success/30' : 'border-warning/40'"
        >
          <label class="flex items-start gap-3">
            <input
              v-model="form.active"
              type="checkbox"
              class="mt-1 h-5 w-5 rounded border-border"
            />
            <div>
              <p class="font-medium text-foreground">
                Rule is active
              </p>
              <p class="text-sm text-muted-foreground">
                When inactive, the deal-close trigger creates no projected charges.
                Existing charges are unaffected.
              </p>
            </div>
          </label>
        </section>

        <!-- Basis kind -->
        <section class="rounded-lg border border-border bg-card p-5 text-card-foreground">
          <p class="text-sm font-medium text-foreground">
            Basis
          </p>
          <p class="mt-1 text-sm text-muted-foreground">
            What the percentage applies to.
          </p>
          <div class="mt-3 space-y-2">
            <label class="flex items-start gap-3 rounded-lg border border-border p-3 hover:bg-accent hover:text-accent-foreground">
              <input
                v-model="form.basis_kind"
                type="radio"
                value="percent_of_commission"
                class="mt-1 h-4 w-4"
              />
              <div>
                <p class="text-sm font-medium text-foreground">
                  % of broker net commission
                  <span class="ml-1 text-xs text-muted-foreground">(recommended)</span>
                </p>
                <p class="text-xs text-muted-foreground">
                  Most aligned with the broker — they only pay when they earn.
                </p>
              </div>
            </label>
            <label class="flex items-start gap-3 rounded-lg border border-border p-3 hover:bg-accent hover:text-accent-foreground">
              <input
                v-model="form.basis_kind"
                type="radio"
                value="percent_of_deal_value"
                class="mt-1 h-4 w-4"
              />
              <div>
                <p class="text-sm font-medium text-foreground">
                  % of deal value
                </p>
                <p class="text-xs text-muted-foreground">
                  Larger absolute take. Used in some PH jurisdictions.
                </p>
              </div>
            </label>
            <label class="flex items-start gap-3 rounded-lg border border-border p-3 hover:bg-accent hover:text-accent-foreground">
              <input
                v-model="form.basis_kind"
                type="radio"
                value="fixed"
                class="mt-1 h-4 w-4"
              />
              <div>
                <p class="text-sm font-medium text-foreground">
                  Fixed amount per deal (centavos)
                </p>
                <p class="text-xs text-muted-foreground">
                  Default value below is interpreted as PHP centavos.
                </p>
              </div>
            </label>
          </div>
        </section>

        <!-- Default value -->
        <section class="rounded-lg border border-border bg-card p-5 text-card-foreground">
          <label class="block">
            <span class="block text-sm font-medium text-foreground">
              Default
              <template v-if="form.basis_kind !== 'fixed'">percentage</template>
              <template v-else>amount (centavos)</template>
            </span>
            <div class="mt-2 flex items-center gap-2">
              <input
                v-model.number="form.default_pct"
                type="number"
                step="0.01"
                min="0"
                :max="form.basis_kind === 'fixed' ? 99999999 : 100"
                required
                class="w-40 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground shadow-sm focus:border-ring focus:ring-1 focus:ring-ring"
              />
              <span class="text-sm text-muted-foreground">
                <template v-if="form.basis_kind !== 'fixed'">%</template>
                <template v-else>centavos</template>
              </span>
            </div>
          </label>
          <p class="mt-3 rounded-md bg-primary/10 px-3 py-2 text-xs text-primary ">
            Preview: {{ previewLine }}
          </p>
        </section>

        <!-- Notes -->
        <section class="rounded-lg border border-border bg-card p-5 text-card-foreground">
          <label class="block">
            <span class="block text-sm font-medium text-foreground">
              Notes
            </span>
            <textarea
              v-model="form.notes"
              rows="3"
              maxlength="2000"
              placeholder="Why this rate? Audit trail."
              class="mt-2 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
          </label>
        </section>

        <!-- Read-only metadata -->
        <section class="rounded-lg border border-border bg-muted/40 p-4">
          <dl class="grid grid-cols-2 gap-3 text-xs text-muted-foreground">
            <div>
              <dt class="text-muted-foreground">Last updated</dt>
              <dd class="text-foreground">
                {{ new Date(rule.updated_at).toLocaleString() }}
              </dd>
            </div>
            <div>
              <dt class="text-muted-foreground">Per-stage overrides</dt>
              <dd class="text-foreground">
                {{ Object.keys(rule.by_stage).length || 'none' }}
              </dd>
            </div>
            <div>
              <dt class="text-muted-foreground">Per-org overrides</dt>
              <dd class="text-foreground">
                {{ Object.keys(rule.by_org).length || 'none' }}
              </dd>
            </div>
            <div>
              <dt class="text-muted-foreground">Effective since</dt>
              <dd class="text-foreground">
                {{ new Date(rule.effective_at).toLocaleDateString() }}
              </dd>
            </div>
          </dl>
        </section>

        <!-- Save bar -->
        <div class="sticky bottom-0 -mx-4 flex items-center justify-end gap-3 border-t border-border bg-card px-4 py-3 sm:-mx-6 lg:-mx-8">
          <span
            v-if="dirty"
            class="text-xs text-warning"
          >
            Unsaved changes
          </span>
          <button
            type="submit"
            :disabled="!dirty || saving"
            class="inline-flex items-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow hover:bg-primary/90 focus-ring disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span v-if="saving">Saving…</span>
            <span v-else>Save changes</span>
          </button>
        </div>
      </form>
    </template>
  </div>
</template>
