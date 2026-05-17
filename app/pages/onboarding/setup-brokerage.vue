<script setup lang="ts">
/**
 * First-run brokerage setup. Reachable from the dashboard hero CTA
 * shown when a logged-in user has zero org memberships, OR directly
 * via /onboarding/setup-brokerage. Calls /api/organizations (POST)
 * which wraps the SECURITY DEFINER create_organization_as_owner()
 * RPC: org row + brokerage_owner membership in one transaction.
 *
 * Slug auto-derived from name (slugify) but editable. We pre-check
 * uniqueness on blur for a clean inline error before submit; the DB
 * UNIQUE index is the real guard.
 */
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import UiCard from '~/components/ui/UiCard.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import { showToast } from '~/helpers/helpers'

definePageMeta({
  // Default layout — same chrome as the rest of the authenticated app.
})

const router = useRouter()

const form = ref({
  name: '',
  slug: '',
  description: '',
})

const slugTouched = ref(false)
const submitting = ref(false)
const slugError = ref<string | null>(null)

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

// Auto-fill slug while user hasn't touched it. Once they edit it,
// stop auto-syncing — they own it.
watch(
  () => form.value.name,
  (n) => {
    if (!slugTouched.value) form.value.slug = slugify(n)
  },
)

const slugValid = computed(() => {
  if (!form.value.slug) return false
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(form.value.slug)
})

const canSubmit = computed(() =>
  form.value.name.trim().length >= 2 && slugValid.value && !submitting.value,
)

async function checkSlugAvailable() {
  if (!slugValid.value) return
  slugError.value = null
  // Best-effort uniqueness preview. The endpoint will re-check
  // server-side and return 409 if there's a race.
  try {
    const res = await $fetch<{ available: boolean }>('/api/organizations/slug-available', {
      query: { slug: form.value.slug },
    }).catch(() => null)
    if (res && !res.available) {
      slugError.value = `"${form.value.slug}" is taken — try another.`
    }
  } catch {
    // Endpoint optional — if it doesn't exist yet, just defer to
    // server-side validation on submit. No UX impact.
  }
}

async function submit() {
  if (!canSubmit.value) return
  submitting.value = true
  slugError.value = null
  try {
    const res = await $fetch<{ organization: { id: string; slug: string } }>('/api/organizations', {
      method: 'POST',
      body: {
        name: form.value.name.trim(),
        slug: form.value.slug.trim(),
        description: form.value.description.trim() || null,
      },
    })
    showToast({
      title: `${form.value.name} is live. Now invite your team.`,
      icon: 'success',
    })
    // Land on the org dashboard. The team-invite CTA there is the
    // next step.
    await router.push('/organization')
    // Best-effort refresh in case the new membership hasn't propagated
    // to /api/organizations yet.
    if (typeof window !== 'undefined') {
      window.setTimeout(() => location.reload(), 250)
    }
  } catch (err: any) {
    const status = err?.statusCode ?? err?.response?.status
    const msg    = err?.statusMessage ?? err?.data?.statusMessage ?? err?.message ?? 'Could not create the brokerage.'
    if (status === 409) {
      slugError.value = msg
    } else if (status === 429) {
      showToast({ title: msg, icon: 'warning' })
    } else {
      showToast({ title: msg, icon: 'error' })
    }
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-2xl px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
    <UiPageHeader
      title="Set up your brokerage"
      description="A brokerage is the workspace your agents share — listings, inquiries, deals, and reporting all roll up to it. You can rename or change branding later."
    />

    <UiCard variant="surface" padding="lg" class="mt-6">
      <form class="space-y-5" @submit.prevent="submit">
        <div>
          <label for="org-name" class="block text-sm font-medium text-foreground">
            Brokerage name
          </label>
          <input
            id="org-name"
            v-model="form.name"
            type="text"
            required
            maxlength="120"
            placeholder="e.g. Acme Realty Manila"
            class="mt-1.5 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <p class="mt-1 text-xs text-muted-foreground">
            Visible to your team and on documents you generate.
          </p>
        </div>

        <div>
          <label for="org-slug" class="block text-sm font-medium text-foreground">
            URL slug
          </label>
          <div class="mt-1.5 flex items-stretch overflow-hidden rounded-lg border border-border bg-background focus-within:ring-2 focus-within:ring-ring">
            <span class="flex select-none items-center bg-muted/50 px-3 text-xs text-muted-foreground">
              housinginteractive.com.ph/org/
            </span>
            <input
              id="org-slug"
              v-model="form.slug"
              type="text"
              required
              maxlength="64"
              placeholder="acme-realty"
              pattern="^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$"
              class="block w-full bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
              @input="slugTouched = true"
              @blur="checkSlugAvailable"
            />
          </div>
          <p
            v-if="slugError"
            class="mt-1 text-xs text-destructive"
          >
            {{ slugError }}
          </p>
          <p
            v-else-if="form.slug && !slugValid"
            class="mt-1 text-xs text-destructive"
          >
            2–64 lowercase letters, numbers, or hyphens. No leading/trailing hyphen.
          </p>
          <p
            v-else
            class="mt-1 text-xs text-muted-foreground"
          >
            Lowercase letters, numbers, hyphens. Used in URLs and exports.
          </p>
        </div>

        <div>
          <label for="org-description" class="block text-sm font-medium text-foreground">
            Description <span class="text-muted-foreground">(optional)</span>
          </label>
          <textarea
            id="org-description"
            v-model="form.description"
            rows="3"
            maxlength="2000"
            placeholder="What kind of brokerage is this? (e.g., Residential sales + leasing across Metro Manila)"
            class="mt-1.5 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div class="flex items-center justify-between gap-3 pt-2">
          <NuxtLink
            to="/dashboard"
            class="text-sm text-muted-foreground hover:text-foreground"
          >
            ← Skip for now
          </NuxtLink>
          <button
            type="submit"
            :disabled="!canSubmit"
            class="inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span v-if="submitting">Creating…</span>
            <span v-else>Create brokerage</span>
          </button>
        </div>
      </form>
    </UiCard>

    <p class="mt-6 text-center text-xs text-muted-foreground">
      Already part of a brokerage? Ask the owner to invite you — they can do it from their organization page.
    </p>
  </div>
</template>
