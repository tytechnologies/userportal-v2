<script setup lang="ts">
/**
 * /help — in-app support entry point.
 *
 * Sections:
 *   1. Contact — email + phone + estimated response time
 *   2. What's new — capability-level overview of the major surfaces a
 *      broker now has, grouped by domain (Pipeline / Documents / AI /
 *      Closings). Helps a returning broker discover features they
 *      didn't know existed.
 *   3. Quick start — links to the most common day-1 actions.
 *   4. FAQ — answers to the questions support most often gets asked.
 *   5. System status — link to /admin/operations (visible to admins) +
 *      generic "is something down?" guidance for non-admins.
 *
 * Intentionally low-fi: this is the in-product help surface, not a
 * full knowledge base. Deeper docs live on the public marketing site.
 */
import { computed } from 'vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import { useUserRole } from '~/composables/useAuth'

definePageMeta({ layout: 'default' })
useHead({ title: 'Help & support | Housing Interactive' })

const role = useUserRole()
const isAdmin = computed(() => role.value === 'admin')

const SUPPORT_EMAIL = 'info@housinginteractive.com.ph'
const SUPPORT_PHONE = '+63 2 8567 0888'

// "What's new" — capability blocks, not changelog. Each item is a
// surface that exists in the app, so brokers can click straight in
// and see it instead of reading prose. Keep this honest with what's
// actually shipped — when a capability isn't live for a tenant
// (e.g. AI/eSign without admin config), the page itself surfaces
// the configure-now CTA.
type Capability = {
  area: string
  title: string
  description: string
  to: string
}
const CAPABILITIES: Capability[] = [
  // Pipeline
  { area: 'Pipeline',     title: 'Kanban board for deals',
    description: 'Drag cards to advance stages, or use the ⋯ menu for keyboard/mobile. Live counts + sums per column.',
    to: '/deals' },
  { area: 'Pipeline',     title: 'Pipeline search',
    description: 'Search deals by title, buyer name, or listing across both the table and the kanban — URL-synced for sharing.',
    to: '/deals' },
  { area: 'Pipeline',     title: 'Quick-create from listing',
    description: 'On any listing detail, "Start a deal" spawns a deal pre-anchored to that listing with a 3-mode buyer picker.',
    to: '/listings' },

  // CRM
  { area: 'CRM',          title: 'CRM dashboard',
    description: 'KPI strip + Today\'s tasks + Today\'s viewings + Recent contacts. Daily-driver landing page for client work.',
    to: '/crm' },
  { area: 'CRM',          title: 'Viewings overview',
    description: 'Today / Tomorrow / This week with .ics export per viewing. Add to phone calendar with one click.',
    to: '/viewings' },
  { area: 'CRM',          title: 'Per-contact deals + docs',
    description: 'Open any contact and see every deal where they\'re the buyer plus every draft attached to them.',
    to: '/contacts' },

  // Documents
  { area: 'Documents',    title: 'New Document wizard',
    description: 'Three modes: Upload Existing PDF, AI Generate, or Template. Reachable from + on the navbar and from any listing/deal/contact.',
    to: '/document-drafts' },
  { area: 'Documents',    title: 'Versions + diff viewer',
    description: 'Snapshot a draft before each meaningful edit, then compare any two versions inline (added words green, removed red).',
    to: '/document-drafts' },
  { area: 'Documents',    title: 'Approval workflow',
    description: 'Request approval from any reviewer — "Approvals waiting on you" surfaces on the docs page until decided.',
    to: '/document-drafts' },
  { area: 'Documents',    title: 'DOCX + PDF export',
    description: 'Server-rendered DOCX (via the docx lib) and PDF (via Puppeteer) with a logged audit trail per export.',
    to: '/document-drafts' },

  // AI
  { area: 'AI',           title: 'AI Generate (drafts)',
    description: 'Type a prompt; the AI drafts a full document body using the deal/listing/contact context. Always reviewable text.',
    to: '/ai-tools' },
  { area: 'AI',           title: 'AI Assist drawer',
    description: 'Per draft: explain a clause, summarize the doc, detect missing fields, translate to Tagalog, splice an approved clause.',
    to: '/ai-tools' },
  { area: 'AI',           title: 'Approved clause library',
    description: 'Curated, versioned clause snippets the AI can splice. Approved clause bodies are immutable — revise creates a new version.',
    to: '/admin/clause-library' },

  // Closings
  { area: 'Closings',     title: 'Transaction rooms',
    description: 'Closing-stage container: participants, linked documents, files, audit trail. Tabs for Overview / Participants / Documents / Files.',
    to: '/transactions' },
  { area: 'Closings',     title: 'DocuSign eSign',
    description: 'Send any draft for e-signing. Status updates flow back via DocuSign Connect; signed status mirrors onto the placeholders.',
    to: '/document-drafts' },
  { area: 'Closings',     title: 'Validation engine',
    description: 'Deterministic checks per doc type: TIN format, witness count, spouse consent, notarial block, etc. Surfaces issues inline.',
    to: '/document-drafts' },
]

type QuickLink = {
  to: string
  title: string
  description: string
}

const QUICK_LINKS: QuickLink[] = [
  { to: '/dashboard',                   title: 'Dashboard',
    description: 'Today\'s attention queue: needs-attention, my open tasks, recent inquiries, deals by stage, upcoming viewings.' },
  { to: '/inquiries',                   title: 'Inquiries inbox',
    description: 'Triage incoming leads, log walk-in/phone inquiries, convert to deals with the 3-mode contact wizard.' },
  { to: '/deals',                       title: 'Deals pipeline',
    description: 'Kanban board with drag-to-stage, search, and inline move menu for mobile/keyboard. Pinned to /deals.' },
  { to: '/transactions',                title: 'Closing rooms',
    description: 'Transaction rooms — one per closing — bundling documents, signatures, files, and audit trail.' },
  { to: '/document-drafts',             title: 'Documents',
    description: '+ New draft opens the 3-mode wizard (Upload / AI Generate / Template). Pending reviewer queue at the top.' },
  { to: '/listings/new',                title: 'Add a listing',
    description: 'Listings on your profile receive inquiries automatically from the public site.' },
]

type Faq = { q: string; a: string }
const FAQS: Faq[] = [
  // Pipeline
  {
    q: 'How do I move a deal to the next stage?',
    a: 'On /deals (kanban view), drag the card to the target column. On mobile or with a keyboard, click the ⋯ menu on the card and pick a stage. Both paths use the same optimistic-update + revert-on-failure flow.',
  },
  {
    q: 'How do I find a deal among hundreds in the pipeline?',
    a: 'Use the search bar on /deals — matches title, buyer name, buyer email, and listing title. Works in both kanban and table views. The search query syncs to the URL so you can share filtered links.',
  },
  {
    q: 'How do I move an inquiry into the deal pipeline?',
    a: 'Open the inquiry in /inquiries, click "Convert to deal." Pick 3-mode contact (new / existing / skip) on the wizard. The inquiry status flips to in-progress and you land on the new deal page.',
  },

  // Documents
  {
    q: 'Where do I create a new document?',
    a: 'Three places: + button on the navbar (no anchor — attach later), the listing detail drawer, or any deal/contact page. All four invoke the same wizard with three modes — Upload Existing PDF, AI Generate, or Template.',
  },
  {
    q: 'What\'s the difference between AI Generate and Template?',
    a: 'AI Generate drafts a freeform body from a prompt — broker reviews and edits the result. Template picks a structured form from the published library and fills its fields. Use template for forms that must look exactly the same; AI for narrative documents.',
  },
  {
    q: 'How do I review another broker\'s document before they finalize it?',
    a: 'They request approval from your account on the draft\'s Review tab. You\'ll see "Approvals waiting on you" at the top of /document-drafts; click through to the draft and decide Approve/Reject inline. Approval rows pin to a version snapshot so what was approved is always traceable.',
  },
  {
    q: 'How do I see what changed between two versions?',
    a: 'On the draft\'s Versions tab, snapshot the current state, then pick two versions and click Compare. The diff viewer renders inline word-level changes (green added, red strikethrough removed) and offers an AI-generated summary of meaningful changes.',
  },
  {
    q: 'How do I download a document as DOCX or PDF?',
    a: 'On the draft detail page, switch to the Export tab and click "Download .docx" or "Download .pdf." Server-rendered (DOCX via the docx library, PDF via Puppeteer with PH paper format). Every export is logged in document_exports for audit.',
  },

  // AI
  {
    q: 'AI Generate / AI Assist returns a "configure now" message — how do I set it up?',
    a: 'Admins go to /admin/ai-settings, fill in endpoint + API key + model + header style (Bearer for OpenAI-compatible, x-api-key for direct Anthropic). Save. AI features unlock immediately for all brokers.',
  },
  {
    q: 'Can the AI invent legal text?',
    a: 'No. AI is constrained to five operations: explain, summarize, detect-missing, translate-to-Tagalog, and rewrite-with-clause. The rewrite operation only splices from admin-approved clause-library entries; it cannot invent new clause text. Outputs are always shown as suggestion text the broker chooses to apply.',
  },

  // Closings
  {
    q: 'What\'s a transaction room and when do I use one?',
    a: 'A transaction room is the closing-stage container — one per deal-in-progress. It bundles participants, linked documents, supporting files, and an audit trail in one place. Spawn one from /transactions or attach a draft to an existing one from the draft\'s Linked tab.',
  },
  {
    q: 'How do I send a document for e-signing?',
    a: 'On the draft\'s Signatures section, click "Send for eSign" once you have signature placeholders defined. Pick recipients, send. DocuSign Connect webhooks update status live; "Envelopes you sent" surfaces in-flight envelopes on /document-drafts. (Requires admin setup at /admin/esign-settings.)',
  },
  {
    q: 'Why do I see validation errors on a draft?',
    a: 'The deterministic validation engine runs on every draft with structured parties. Errors block ship-readiness; warnings are reviewable. Common: missing TIN format, insufficient witness count, missing spouse consent on a Deed of Sale, no notarial block. The engine never overrides AI — both run independently.',
  },

  // Operations
  {
    q: 'My agent didn\'t receive an invitation email — what now?',
    a: 'Email delivery requires a configured Resend API key. If yours isn\'t set up yet, use the "Copy link" button on the pending invitation in /organization and send it manually via WhatsApp or email.',
  },
  {
    q: 'Can I add a listing on behalf of an agent on my team?',
    a: 'Yes — managers can create listings owned by anyone on their team. Use /listings/new and assign the listing to the agent on the form.',
  },
  {
    q: 'How do tenant statements get generated?',
    a: 'A nightly cron at 05:00 UTC aggregates rent and dues per active lease and creates a tenant statement for each policy. You can also trigger it on-demand from /admin/statements via "Generate now."',
  },
  {
    q: 'Where do I see system status / health?',
    a: 'Admins can open /admin/operations for crons, latency, and recent errors. Non-admins should email support if something appears broken.',
  },
]

// Group capabilities by area for the rendered template — the
// authoring list above is flat for editing simplicity.
const capabilitiesByArea = computed(() => {
  const order: string[] = ['Pipeline', 'CRM', 'Documents', 'AI', 'Closings']
  const out: Record<string, Capability[]> = {}
  for (const a of order) out[a] = []
  for (const c of CAPABILITIES) {
    const bucket = out[c.area]
    if (bucket) bucket.push(c)
  }
  return order
    .map((a) => ({ area: a, items: out[a] ?? [] }))
    .filter((g) => g.items.length > 0)
})
</script>

<template>
  <div class="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6 sm:py-6 lg:px-8">
    <UiPageHeader
      title="Help &amp; support"
      description="Reach our team, browse what's new, jump to common actions, or check system status."
    />

    <!-- Contact -->
    <UiCard variant="elevated" padding="lg">
      <div class="grid gap-5 sm:grid-cols-[1fr_auto] sm:items-center">
        <div>
          <h2 class="text-section-title">Contact us</h2>
          <p class="mt-1 text-meta">
            We answer most questions within one business day. Critical issues — payments, lost data, account lockout — should go to email with the word <strong>URGENT</strong> in the subject.
          </p>
          <dl class="mt-4 space-y-2 text-sm">
            <div class="flex items-baseline gap-3">
              <dt class="w-16 text-muted-foreground">Email</dt>
              <dd>
                <a
                  :href="`mailto:${SUPPORT_EMAIL}?subject=Help%20needed`"
                  class="font-medium text-primary hover:underline"
                >
                  {{ SUPPORT_EMAIL }}
                </a>
              </dd>
            </div>
            <div class="flex items-baseline gap-3">
              <dt class="w-16 text-muted-foreground">Phone</dt>
              <dd>
                <a :href="`tel:${SUPPORT_PHONE.replace(/\s/g, '')}`" class="font-medium text-foreground hover:text-primary">
                  {{ SUPPORT_PHONE }}
                </a>
                <span class="ml-2 text-meta">Mon–Fri, 9 AM – 6 PM PHT</span>
              </dd>
            </div>
          </dl>
        </div>
        <a
          :href="`mailto:${SUPPORT_EMAIL}?subject=Help%20needed&body=Describe%20what%20you%20were%20trying%20to%20do%20and%20what%20happened%20instead%3A%0A%0A%0A%0AURL%20%2F%20page%20you%20were%20on%3A%0A%0A`"
          class="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Email support
          <span aria-hidden="true">→</span>
        </a>
      </div>
    </UiCard>

    <!-- What's new — capability overview, grouped by area -->
    <section class="space-y-3">
      <h2 class="text-section-title">What's new</h2>
      <p class="text-meta">
        Capabilities the platform now ships — click through to land on the surface.
      </p>
      <div class="space-y-5">
        <div
          v-for="group in capabilitiesByArea"
          :key="group.area"
        >
          <p class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {{ group.area }}
          </p>
          <ul class="grid gap-3 sm:grid-cols-2">
            <li v-for="c in group.items" :key="c.title">
              <NuxtLink
                :to="c.to"
                class="group flex h-full flex-col rounded-lg border border-border bg-card p-3 text-card-foreground transition-colors hover:border-primary/40 hover:bg-accent/30"
              >
                <span class="flex items-center justify-between gap-2">
                  <span class="text-sm font-semibold text-foreground">{{ c.title }}</span>
                  <span aria-hidden="true" class="text-meta transition-transform group-hover:translate-x-0.5">→</span>
                </span>
                <span class="mt-1 text-xs text-muted-foreground">{{ c.description }}</span>
              </NuxtLink>
            </li>
          </ul>
        </div>
      </div>
    </section>

    <!-- Quick start -->
    <section class="space-y-3">
      <h2 class="text-section-title">Quick start</h2>
      <p class="text-meta">Jump to the most common actions.</p>
      <ul class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <li v-for="link in QUICK_LINKS" :key="link.to">
          <NuxtLink
            :to="link.to"
            class="group flex h-full flex-col rounded-lg border border-border bg-card p-4 text-card-foreground transition-colors hover:border-primary/40 hover:bg-accent/30"
          >
            <span class="flex items-center justify-between">
              <span class="text-sm font-semibold text-foreground">{{ link.title }}</span>
              <span aria-hidden="true" class="text-meta transition-transform group-hover:translate-x-0.5">→</span>
            </span>
            <span class="mt-1 text-meta">{{ link.description }}</span>
          </NuxtLink>
        </li>
      </ul>
    </section>

    <!-- FAQ -->
    <section class="space-y-3">
      <h2 class="text-section-title">Common questions</h2>
      <UiCard variant="surface" padding="none">
        <ul class="divide-y divide-border">
          <li v-for="(faq, i) in FAQS" :key="i">
            <details class="group">
              <summary class="flex cursor-pointer items-start justify-between gap-3 px-4 py-3 text-sm font-medium text-foreground transition-colors hover:bg-accent/30">
                <span>{{ faq.q }}</span>
                <span aria-hidden="true" class="mt-0.5 text-meta transition-transform group-open:rotate-90">›</span>
              </summary>
              <p class="px-4 pb-4 text-sm text-muted-foreground whitespace-pre-line">
                {{ faq.a }}
              </p>
            </details>
          </li>
        </ul>
      </UiCard>
    </section>

    <!-- Status -->
    <section class="space-y-3">
      <h2 class="text-section-title">System status</h2>
      <UiCard variant="surface" padding="md">
        <p v-if="isAdmin" class="text-sm text-foreground">
          Open the
          <NuxtLink to="/admin/operations" class="font-medium text-primary hover:underline">Operations dashboard</NuxtLink>
          for crons, latency, recent errors, and storage health. Polls every 30 seconds.
        </p>
        <p v-else class="text-sm text-foreground">
          If something looks broken or slow, email
          <a :href="`mailto:${SUPPORT_EMAIL}?subject=System%20issue%20report`" class="font-medium text-primary hover:underline">{{ SUPPORT_EMAIL }}</a>
          with the time it happened and a screenshot if you can. We monitor system health continuously.
        </p>
      </UiCard>
    </section>
  </div>
</template>
