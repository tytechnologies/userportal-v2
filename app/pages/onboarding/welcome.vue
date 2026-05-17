<script setup lang="ts">
/**
 * Post-signup onboarding wizard.
 *
 * 4-step flow brokers land on after their first login (auto-redirected
 * from /dashboard.vue when onboarding is incomplete + not skipped).
 *
 *   1. Welcome           — explains what's about to happen.
 *   2. Brokerage         — links to /onboarding/setup-brokerage if no
 *                          org yet; auto-marked done once has_org is true.
 *   3. Invite a colleague — inline form posts to
 *                          /api/organizations/:id/invitations.
 *                          Skippable.
 *   4. First listing     — link to /listings/new; skippable.
 *
 * Skip on any step writes a localStorage stamp so the auto-redirect
 * leaves the user alone for 14 days. The existing OnboardingChecklist
 * widget on the dashboard continues to track these milestones inline
 * for users who skipped the wizard.
 *
 * The wizard polls /api/dashboard/onboarding-progress when it gains
 * focus so users who pop out to /onboarding/setup-brokerage or
 * /listings/new and come back see step state update without a manual
 * refresh.
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from '~/helpers/helpers'

definePageMeta({
  // Full-bleed look — render outside the standard sidebar chrome so
  // the wizard feels like a first-run experience, not "more app." If
  // there's no app-shell layout token, the wrapper styles below carry
  // the full-height pattern themselves.
  layout: false,
})

const router = useRouter()

type Progress = {
  has_org: boolean
  team_size: number
  listings_count: number
  primary_org_id: string | null
  primary_org_role: string | null
  is_complete: boolean
}

const SNOOZE_KEY = 'hi.onboarding_wizard.skipped_at'

const progress = ref<Progress | null>(null)
const loading = ref(true)
const step = ref<1 | 2 | 3 | 4>(1)

async function loadProgress() {
  try {
    progress.value = await $fetch<Progress>('/api/dashboard/onboarding-progress')
  } catch {
    progress.value = null
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  loadProgress()
  // Re-fetch when the user comes back from setup-brokerage / listings/new
  // so step completion lights up without a manual refresh.
  window.addEventListener('focus', loadProgress)
})

function skipForever() {
  try {
    window.localStorage.setItem(SNOOZE_KEY, String(Date.now()))
  } catch {
    // localStorage full / disabled — fall through. The user can dismiss
    // again next time; UX-wise this is acceptable for a "remind me later".
  }
  router.push('/dashboard')
}

// Step completion derived from server progress. Step 1 (welcome) is
// always "done" once the user clicks Get Started.
const hasOrg = computed(() => progress.value?.has_org === true)
const hasTeam = computed(() => (progress.value?.team_size ?? 0) >= 1)
const hasListing = computed(() => (progress.value?.listings_count ?? 0) >= 1)

const steps = [
  { id: 1, label: 'Welcome' },
  { id: 2, label: 'Brokerage' },
  { id: 3, label: 'Invite' },
  { id: 4, label: 'Listing' },
] as const

function stepDone(id: 1 | 2 | 3 | 4): boolean {
  if (id === 1) return step.value > 1
  if (id === 2) return hasOrg.value
  if (id === 3) return hasTeam.value
  if (id === 4) return hasListing.value
  return false
}

function nextStep() {
  if (step.value < 4) step.value = (step.value + 1) as 1 | 2 | 3 | 4
  else router.push('/dashboard')
}

function prevStep() {
  if (step.value > 1) step.value = (step.value - 1) as 1 | 2 | 3 | 4
}

// ----- Invite form (step 3) ----------------------------------------
const inviteEmail = ref('')
const inviteName = ref('')
const inviteRole = ref<'junior_agent' | 'senior_agent' | 'branch_manager'>('junior_agent')
const inviteSending = ref(false)

async function sendInvite() {
  const email = inviteEmail.value.trim()
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    showToast({ title: 'Enter a valid email address', icon: 'error' })
    return
  }
  if (!progress.value?.primary_org_id) {
    showToast({ title: 'Set up your brokerage first', icon: 'warning' })
    step.value = 2
    return
  }
  inviteSending.value = true
  try {
    await $fetch(`/api/organizations/${progress.value.primary_org_id}/invitations`, {
      method: 'POST',
      body: {
        email,
        full_name: inviteName.value.trim() || null,
        org_role: inviteRole.value,
      },
    })
    showToast({ title: `Invite sent to ${email}`, icon: 'success' })
    inviteEmail.value = ''
    inviteName.value = ''
    // Reload progress so team_size bumps from 0 → 1 (the invite is
    // pending, not active, so this won't actually flip team_size yet
    // — but the user has done their part).
    await loadProgress()
    nextStep()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Could not send invite',
      icon: 'error',
    })
  } finally {
    inviteSending.value = false
  }
}
</script>

<template>
  <div class="min-h-screen bg-background">
    <div class="mx-auto flex min-h-screen w-full max-w-2xl flex-col px-4 py-8 sm:px-6">
      <!-- Header + step indicator -->
      <header class="mb-6">
        <p class="text-eyebrow">Welcome aboard</p>
        <h1 class="mt-1 text-page-title">Let's get you set up</h1>
        <ol class="mt-4 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <li
            v-for="(s, idx) in steps"
            :key="s.id"
            class="flex items-center gap-1.5"
            :class="{ 'text-foreground': step === s.id, 'text-success': stepDone(s.id) && step !== s.id }"
          >
            <span
              class="flex h-5 w-5 items-center justify-center rounded-full border"
              :class="
                stepDone(s.id) ? 'border-success bg-success text-success-foreground'
                : step === s.id ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border'
              "
            >
              <span v-if="stepDone(s.id)" aria-hidden="true">✓</span>
              <span v-else>{{ s.id }}</span>
            </span>
            <span class="hidden sm:inline">{{ s.label }}</span>
            <span
              v-if="idx < steps.length - 1"
              aria-hidden="true"
              class="h-px w-4 bg-border"
            />
          </li>
        </ol>
      </header>

      <!-- Step content -->
      <main class="flex-1 rounded-xl border border-border bg-card p-6 shadow-sm sm:p-8">
        <!-- 1. Welcome -->
        <div v-if="step === 1" class="space-y-3">
          <h2 class="text-section-title">Welcome to Housing Interactive</h2>
          <p class="text-sm text-muted-foreground">
            The platform is a free workspace for Philippine real-estate brokers — listings,
            inquiries, deals, documents, and reporting in one place. We'll walk you through
            three quick steps to get your brokerage running:
          </p>
          <ol class="ml-4 mt-2 list-decimal space-y-1 text-sm text-foreground">
            <li>Create your brokerage workspace.</li>
            <li>Invite a colleague (optional).</li>
            <li>Add your first listing (optional).</li>
          </ol>
          <p class="text-xs text-muted-foreground">
            Takes about three minutes. You can skip any step and finish later.
          </p>
        </div>

        <!-- 2. Brokerage -->
        <div v-else-if="step === 2" class="space-y-4">
          <h2 class="text-section-title">Set up your brokerage</h2>
          <p v-if="!hasOrg" class="text-sm text-muted-foreground">
            A brokerage is your workspace — listings, agents, inquiries, and deals all roll up
            to it. Takes about a minute; branding can be changed later.
          </p>
          <div
            v-if="hasOrg"
            class="flex items-center gap-3 rounded-md border border-success/30 bg-success/5 p-3 text-sm"
          >
            <span class="inline-flex h-6 w-6 items-center justify-center rounded-full bg-success text-success-foreground">✓</span>
            <span class="text-foreground">Brokerage is ready. You can move on.</span>
          </div>
          <div v-else class="flex flex-wrap gap-2">
            <NuxtLink
              to="/onboarding/setup-brokerage"
              class="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-ring"
            >
              Create brokerage →
            </NuxtLink>
            <a
              href="mailto:info@housinginteractive.com.ph?subject=Help%20setting%20up%20my%20brokerage"
              class="rounded-md border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-ring"
            >
              Talk to us
            </a>
          </div>
        </div>

        <!-- 3. Invite -->
        <div v-else-if="step === 3" class="space-y-4">
          <h2 class="text-section-title">Invite your first colleague</h2>
          <p class="text-sm text-muted-foreground">
            Brokerages with two or more agents close 3× more deals on the platform. You can
            invite anyone with an email address — they'll get a link to claim their seat.
            Skip this if you're flying solo for now.
          </p>
          <div
            v-if="hasTeam"
            class="flex items-center gap-3 rounded-md border border-success/30 bg-success/5 p-3 text-sm"
          >
            <span class="inline-flex h-6 w-6 items-center justify-center rounded-full bg-success text-success-foreground">✓</span>
            <span class="text-foreground">{{ progress?.team_size }} teammate{{ progress?.team_size === 1 ? '' : 's' }} joined.</span>
          </div>
          <div v-else class="space-y-3">
            <label class="block">
              <span class="block text-sm font-medium text-foreground">Email</span>
              <input
                v-model="inviteEmail"
                type="email"
                placeholder="agent@example.com"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/25"
                :disabled="!hasOrg || inviteSending"
              />
            </label>
            <label class="block">
              <span class="block text-sm font-medium text-foreground">Full name (optional)</span>
              <input
                v-model="inviteName"
                type="text"
                placeholder="Maria Santos"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/25"
                :disabled="!hasOrg || inviteSending"
              />
            </label>
            <label class="block">
              <span class="block text-sm font-medium text-foreground">Role</span>
              <select
                v-model="inviteRole"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/25"
                :disabled="!hasOrg || inviteSending"
              >
                <option value="junior_agent">Junior agent</option>
                <option value="senior_agent">Senior agent</option>
                <option value="branch_manager">Branch manager</option>
              </select>
            </label>
            <p v-if="!hasOrg" class="text-xs text-warning">
              Set up your brokerage first — invites need a workspace to land in.
            </p>
            <button
              type="button"
              class="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-ring disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="!hasOrg || inviteSending || !inviteEmail.trim()"
              @click="sendInvite"
            >
              {{ inviteSending ? 'Sending…' : 'Send invite' }}
            </button>
          </div>
        </div>

        <!-- 4. First listing -->
        <div v-else-if="step === 4" class="space-y-4">
          <h2 class="text-section-title">Add your first listing</h2>
          <p class="text-sm text-muted-foreground">
            Get a listing online so inquiries can start coming in. The wizard takes about
            two minutes — photos can be added later. Once published, your listing appears on
            the public site and in your brokerage's pipeline.
          </p>
          <div
            v-if="hasListing"
            class="flex items-center gap-3 rounded-md border border-success/30 bg-success/5 p-3 text-sm"
          >
            <span class="inline-flex h-6 w-6 items-center justify-center rounded-full bg-success text-success-foreground">✓</span>
            <span class="text-foreground">Your first listing is live.</span>
          </div>
          <div v-else class="flex flex-wrap gap-2">
            <NuxtLink
              to="/listings/new"
              class="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-ring"
            >
              Open listing wizard →
            </NuxtLink>
          </div>
        </div>
      </main>

      <!-- Footer: skip / nav -->
      <footer class="mt-6 flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          class="text-sm text-muted-foreground transition-colors hover:text-foreground focus-ring rounded"
          title="Remind me again in two weeks"
          @click="skipForever"
        >
          Skip — remind me later
        </button>
        <div class="flex gap-2">
          <button
            v-if="step > 1"
            type="button"
            class="rounded-md border border-border bg-card px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-ring"
            @click="prevStep"
          >
            Back
          </button>
          <button
            type="button"
            class="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-ring"
            @click="nextStep"
          >
            {{ step === 4 ? 'Finish' : step === 1 ? 'Get started' : 'Next' }}
          </button>
        </div>
      </footer>
    </div>
  </div>
</template>
