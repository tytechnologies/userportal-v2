<script setup lang="ts">
/**
 * New-Document wizard.
 *
 * Three-step flow:
 *
 *   Step 1 — Mode:
 *     Library  — bundled Philippine legal-template catalog
 *       (legal-templates/ph/, ~60 markdown docs across Sales/Transfer,
 *       Lease/Rental, Brokerage, Property Management, Corporate,
 *       Financing, Compliance). With listing/contact context the AI
 *       fills {{placeholders}}; without, the body is cloned verbatim
 *       for manual entry. Backed by /api/document-drafts/from-legal-template.
 *     Generate — free-text prompt → AI drafts a body. Backed by
 *       /api/document-drafts/generate-ai.
 *     Org Template — pick from the firm's published template library
 *       (document_template_definitions). Same legacy path as before.
 *     Upload Existing — broker has a PDF on hand (notarized, scanned,
 *       received from elsewhere). Attached as the draft's finalized
 *       document; draft transitions to 'signed' status.
 *
 *   Step 2:
 *     Library      → Category picker drawn from the catalog's
 *                    distinct categories.
 *     Other modes  → Lease | Rental | Sale type picker.
 *
 *   Step 3:
 *     Library      → list templates in the chosen category, with an
 *                    "AI fill" toggle. Click → POST from-legal-template.
 *     Generate     → prompt textarea → POST generate-ai.
 *     Org Template → list keyword-matching templates → POST document-drafts.
 *     Upload       → file picker → POST document-drafts then upload-signed.
 *
 * Why categorize by mode first: the action a broker takes (use a
 * standard form vs. ask AI to draft vs. attach an existing PDF) is a
 * bigger decision than the document type. Library mode then drills by
 * category because that's how PH legal forms are organized in real
 * practice (deeds vs. leases vs. brokerage agreements).
 */
import { computed, ref, watch } from 'vue'
import { useTemplates } from '~/composables/useTemplateDefinitions'
import { useDocumentDrafts } from '~/composables/useDocumentDrafts'
import { showToast } from '~/helpers/helpers'

type DocType = 'lease' | 'rental' | 'sale'
type Mode = 'upload' | 'generate' | 'template' | 'library'

type LegalTemplateSummary = {
  slug: string
  category: string
  title: string
  document_type: string
  jurisdiction: string
  required_fields: string[]
  optional_fields: string[]
  version: string
}

const props = defineProps<{
  open: boolean
  /** At least one of listingId / contactId must be set when opening
   *  the wizard — that's the entity the new draft pre-links to. The
   *  deal-detail surface passes both (drafts on a deal want to be
   *  visible on the listing AND the buyer contact page); the listing
   *  drawer passes only listingId. */
  listingId?: number | null
  contactId?: number | null
  /** Optional label for context in the modal subtitle. */
  listingLabel?: string
}>()

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  /** Fires when a draft is created/uploaded so the parent can refresh
   *  its draft list. */
  (e: 'created', payload: { draftId: string; mode: Mode; docType: DocType }): void
}>()

// Wizard state — reset on open. Step is 1, 2, or 3.
const step = ref<1 | 2 | 3>(1)
const mode = ref<Mode | null>(null)
const docType = ref<DocType | null>(null)
// Library-mode state: when mode === 'library' we use libraryCategory in
// place of docType for step 2, and library templates in place of the
// admin/static template list for step 3.
const libraryCategory = ref<string | null>(null)
const libraryTemplates = ref<LegalTemplateSummary[]>([])
const libraryCategories = ref<string[]>([])
const libraryLoading = ref(false)
const libraryFillWithAi = ref(true)
const submittingLibrary = ref<string | null>(null)

// Upload-step state.
const file = ref<File | null>(null)
const uploading = ref(false)
const fileError = ref<string | null>(null)

// Template-step state — id of the template currently mid-create.
const submittingTemplate = ref<string | null>(null)

// AI-Generate-step state.
const aiPrompt = ref<string>('')
const aiGenerating = ref(false)
/** Set to a structured payload when the server returns 503
 *  ai_not_configured — the wizard then renders an admin CTA instead
 *  of the prompt form. */
const aiNotConfigured = ref<{ admin_path: string; missing?: string | null } | null>(null)

const { templates, isLoading: templatesLoading } = useTemplates()
const { createDraft } = useDocumentDrafts()

// Reset wizard state when (re-)opening so a previous run's choices
// don't leak. Keeps the modal idempotent.
watch(
  () => props.open,
  (open) => {
    if (!open) return
    step.value = 1
    mode.value = null
    docType.value = null
    file.value = null
    fileError.value = null
    uploading.value = false
    submittingTemplate.value = null
    aiPrompt.value = ''
    aiGenerating.value = false
    aiNotConfigured.value = null
    libraryCategory.value = null
    libraryTemplates.value = []
    libraryCategories.value = []
    libraryLoading.value = false
    // Default the AI-fill toggle on when context exists so the typical
    // path (broker on a listing or contact) just works. Brokers without
    // a context default to manual fill since AI has nothing to draw on.
    libraryFillWithAi.value = !!(props.listingId || props.contactId)
    submittingLibrary.value = null
  },
  { immediate: true },
)

// Templates filtered to the chosen doc type. Match by keyword in
// name + description because the static registry doesn't have a
// `category` field. Brokers' real templates almost always include
// the type word verbatim ("Residential Lease Agreement",
// "Commercial Sale Contract", etc.), so substring match is good
// enough until we add a structured category.
const filteredTemplates = computed(() => {
  if (!docType.value) return []
  const needle = docType.value.toLowerCase()
  return templates.value.filter((t) => {
    const haystack = `${t.name} ${t.description ?? ''}`.toLowerCase()
    return haystack.includes(needle)
  })
})

const docTypeLabel = computed<string>(() => {
  switch (docType.value) {
    case 'lease':  return 'Lease'
    case 'rental': return 'Rental'
    case 'sale':   return 'Sale'
    default:       return ''
  }
})

async function pickMode(m: Mode) {
  mode.value = m
  step.value = 2
  // Library mode preloads the catalog now so step 2 (category) and
  // step 3 (template) render instantly. The catalog is small (60 rows)
  // and cached server-side, so re-fetches per open are cheap.
  if (m === 'library') await ensureLibraryLoaded()
}

function pickType(t: DocType) {
  docType.value = t
  step.value = 3
}

function pickLibraryCategory(cat: string) {
  libraryCategory.value = cat
  step.value = 3
}

async function ensureLibraryLoaded() {
  if (libraryTemplates.value.length > 0) return
  libraryLoading.value = true
  try {
    const res = await $fetch<{ data: LegalTemplateSummary[]; categories: string[] }>(
      '/api/legal-templates',
    )
    libraryTemplates.value = res?.data ?? []
    libraryCategories.value = res?.categories ?? []
  } catch (err: any) {
    showToast({
      title: 'Could not load template library',
      message: err?.statusMessage || err?.message || 'Unknown error',
      icon: 'error',
    })
  } finally {
    libraryLoading.value = false
  }
}

const libraryTemplatesByCategory = computed(() => {
  if (!libraryCategory.value) return [] as LegalTemplateSummary[]
  return libraryTemplates.value
    .filter((t) => t.category === libraryCategory.value)
    .sort((a, b) => a.title.localeCompare(b.title))
})

// Derive a category → count map so the picker shows "Lease/Rental (11)"
// at a glance. Brokers know how big each category is before they drill
// in.
const libraryCategoryCounts = computed<Record<string, number>>(() => {
  const out: Record<string, number> = {}
  for (const t of libraryTemplates.value) {
    out[t.category] = (out[t.category] ?? 0) + 1
  }
  return out
})

// Pretty labels for category slugs the loader emits. Falls back to a
// title-case of the slug if a category we haven't named appears (so
// the UI never shows raw kebab-case).
function categoryLabel(slug: string): string {
  const named: Record<string, string> = {
    'sales-transfer':         'Sales / Transfer',
    'lease-rental':           'Lease / Rental',
    'brokerage-agency':       'Brokerage / Agency',
    'property-management':    'Property Management',
    'corporate-business':     'Corporate / Business',
    'financing':              'Financing',
    'compliance-government':  'Compliance / Government',
  }
  return named[slug] ?? slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function back() {
  if (step.value === 3) step.value = 2
  else if (step.value === 2) step.value = 1
}

function close() {
  if (uploading.value || submittingTemplate.value || submittingLibrary.value || aiGenerating.value) return // persistent during work
  emit('update:open', false)
}

// ----- Library path --------------------------------------------------
async function startFromLibrary(slug: string) {
  if (!slug) return
  submittingLibrary.value = slug
  try {
    const draft = await $fetch<{ id: string }>('/api/document-drafts/from-legal-template', {
      method: 'POST',
      body: {
        slug,
        listing_id: props.listingId ?? null,
        contact_id: props.contactId ?? null,
        fill_with_ai: libraryFillWithAi.value,
      },
    })
    showToast({
      title: libraryFillWithAi.value
        ? 'AI-filled draft created'
        : 'Template draft created',
      icon: 'success',
    })
    emit('created', {
      draftId: draft.id,
      mode: 'generate',
      // Library covers Lease/Rental/Sale and many other doc types — fall
      // back to 'sale' for the emit's docType field so listeners that
      // chip-color by type don't break. The actual category lives on
      // the draft via tags + data.legal_template_category.
      docType: (docType.value ?? 'sale') as DocType,
    })
    emit('update:open', false)
    if (typeof navigateTo === 'function') {
      await navigateTo(`/document-drafts/${draft.id}`)
    }
  } catch (err: any) {
    // Same 503 ai_not_configured shape as generate-ai — surface the
    // admin-CTA panel instead of a generic toast when AI fill was
    // requested but no provider is wired up.
    const data = err?.data
    if (
      libraryFillWithAi.value
      && err?.statusCode === 503
      && data?.code === 'ai_not_configured'
    ) {
      aiNotConfigured.value = {
        admin_path: data.admin_path || '/admin/ai-settings',
        missing: data.missing ?? null,
      }
    } else {
      showToast({
        title: err?.statusMessage || err?.message || 'Could not create draft',
        icon: 'error',
      })
    }
  } finally {
    submittingLibrary.value = null
  }
}

// ----- Generate path -------------------------------------------------
async function startFromTemplate(templateId: string) {
  if (!docType.value) return
  // Anchors are optional — when invoked from the navbar quick-create
  // there's no listing or contact in scope. The broker can attach
  // later from the draft's "Linked" tab. Wizard always proceeds as
  // long as a doc type is chosen.
  submittingTemplate.value = templateId
  try {
    const draft = await createDraft({
      template_id: templateId,
      listing_id: props.listingId ?? null,
      contact_id: props.contactId ?? null,
      tags: [docType.value],
    })
    emit('created', { draftId: draft.id, mode: 'generate', docType: docType.value })
    emit('update:open', false)
    if (typeof navigateTo === 'function') {
      await navigateTo(`/document-drafts/${draft.id}`)
    }
  } catch (err: any) {
    showToast({
      title: err?.message || err?.statusMessage || 'Could not create draft',
      icon: 'error',
    })
  } finally {
    submittingTemplate.value = null
  }
}

// ----- Upload path ---------------------------------------------------
const MAX_BYTES = 25_000_000

function onFilePick(ev: Event) {
  fileError.value = null
  const t = ev.target as HTMLInputElement
  const f = t.files?.[0] ?? null
  if (!f) {
    file.value = null
    return
  }
  if (f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) {
    fileError.value = 'PDF files only.'
    file.value = null
    return
  }
  if (f.size > MAX_BYTES) {
    fileError.value = `Max 25MB. This file is ${(f.size / 1_000_000).toFixed(1)}MB.`
    file.value = null
    return
  }
  file.value = f
}

function readAsDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('Read failed'))
    reader.readAsDataURL(f)
  })
}

async function submitUpload() {
  if (!docType.value || !file.value) return
  // Anchors optional — see startFromTemplate comment.
  uploading.value = true
  try {
    // 1. Create the draft. Tagged with the doc type and titled with
    //    the original filename so it's recognizable in the listing's
    //    document list before the user opens it. Anchored to whichever
    //    of listing/contact the parent provided (or both, on the deal
    //    surface which has access to both).
    const draft = await createDraft({
      listing_id: props.listingId ?? null,
      contact_id: props.contactId ?? null,
      tags: [docType.value],
      title: file.value.name.replace(/\.pdf$/i, ''),
    })
    // 2. Attach the PDF. upload-signed auto-transitions status
    //    draft → signed (we accept that default — uploaded PDFs are
    //    typically already-finalized scans, which is exactly what
    //    'signed' status communicates downstream).
    const dataUrl = await readAsDataUrl(file.value)
    await $fetch(`/api/document-drafts/${draft.id}/upload-signed`, {
      method: 'POST',
      body: {
        data_url: dataUrl,
        filename: file.value.name,
      },
    })

    showToast({
      title: 'Document uploaded and attached',
      icon: 'success',
    })
    emit('created', { draftId: draft.id, mode: 'upload', docType: docType.value })
    emit('update:open', false)
    if (typeof navigateTo === 'function') {
      await navigateTo(`/document-drafts/${draft.id}`)
    }
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Upload failed',
      icon: 'error',
    })
  } finally {
    uploading.value = false
  }
}

// Subtitle line. Builds incrementally as the user advances so they
// can see a breadcrumb of their choices in the modal header.
function modeLabel(m: Mode | null): string {
  switch (m) {
    case 'upload':   return 'Upload'
    case 'generate': return 'Generate'
    case 'template': return 'Template'
    case 'library':  return 'Library'
    default:         return ''
  }
}
const subtitle = computed(() => {
  const bits: string[] = []
  if (props.listingLabel) bits.push(props.listingLabel)
  if (mode.value && step.value > 1) bits.push(modeLabel(mode.value))
  if (mode.value === 'library' && libraryCategory.value && step.value > 2) {
    bits.push(categoryLabel(libraryCategory.value))
  } else if (docType.value && step.value > 2) {
    bits.push(docTypeLabel.value)
  }
  return bits.join(' · ')
})

// ----- AI Generate path ---------------------------------------------
async function submitAi() {
  if (!docType.value) return
  // Anchors optional — see startFromTemplate comment.
  const prompt = aiPrompt.value.trim()
  if (prompt.length < 10) return
  aiGenerating.value = true
  aiNotConfigured.value = null
  try {
    const draft = await $fetch<{ id: string }>('/api/document-drafts/generate-ai', {
      method: 'POST',
      body: {
        prompt,
        doc_type: docType.value,
        listing_id: props.listingId ?? null,
        contact_id: props.contactId ?? null,
      },
    })
    showToast({ title: 'AI draft generated', icon: 'success' })
    emit('created', { draftId: draft.id, mode: 'generate', docType: docType.value })
    emit('update:open', false)
    if (typeof navigateTo === 'function') {
      await navigateTo(`/document-drafts/${draft.id}`)
    }
  } catch (err: any) {
    // The endpoint emits a structured 503 with { code: 'ai_not_configured',
    // admin_path } when the platform admin hasn't set up the provider.
    // Surface a CTA instead of a generic error in that case.
    const data = err?.data
    if (err?.statusCode === 503 && data?.code === 'ai_not_configured') {
      // Two failure modes share this code:
      //   - admin hasn't filled endpoint+api_key in /admin/ai-settings
      //   - server's SUPABASE_SERVICE_KEY env var isn't set, so the
      //     endpoint can't read platform_settings (admin-only RLS) at all
      // We split the messaging in the panel so the broker knows which
      // hand to point at.
      aiNotConfigured.value = {
        admin_path: data.admin_path || '/admin/ai-settings',
        missing: data.missing ?? null,
      }
    } else {
      showToast({
        title: err?.statusMessage || err?.message || 'AI generation failed',
        icon: 'error',
      })
    }
  } finally {
    aiGenerating.value = false
  }
}

const isWorking = computed(() =>
  uploading.value || !!submittingTemplate.value || aiGenerating.value || !!submittingLibrary.value,
)
</script>

<template>
  <UiModal
    :open="open"
    title="New document"
    :subtitle="subtitle || 'Attach or generate a document for this listing.'"
    width="md"
    :persistent="isWorking"
    @update:open="(v) => { if (!v) close() }"
  >
    <!-- Step indicator. Accessible via aria-current. -->
    <ol class="mb-4 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
      <li
        class="flex items-center gap-1.5"
        :aria-current="step === 1 ? 'step' : undefined"
        :class="{ 'text-foreground': step === 1, 'text-success': step > 1 }"
      >
        <span class="flex h-5 w-5 items-center justify-center rounded-full border" :class="step >= 1 ? 'border-primary bg-primary text-primary-foreground' : 'border-border'">1</span>
        Mode
      </li>
      <span aria-hidden="true" class="h-px w-4 bg-border" />
      <li
        class="flex items-center gap-1.5"
        :aria-current="step === 2 ? 'step' : undefined"
        :class="{ 'text-foreground': step === 2, 'text-success': step > 2 }"
      >
        <span class="flex h-5 w-5 items-center justify-center rounded-full border" :class="step >= 2 ? 'border-primary bg-primary text-primary-foreground' : 'border-border'">2</span>
        {{ mode === 'library' ? 'Category' : 'Type' }}
      </li>
      <span aria-hidden="true" class="h-px w-4 bg-border" />
      <li
        class="flex items-center gap-1.5"
        :aria-current="step === 3 ? 'step' : undefined"
        :class="{ 'text-foreground': step === 3 }"
      >
        <span class="flex h-5 w-5 items-center justify-center rounded-full border" :class="step >= 3 ? 'border-primary bg-primary text-primary-foreground' : 'border-border'">3</span>
        {{ mode === 'upload' ? 'Upload' : mode === 'generate' ? 'Generate' : mode === 'library' ? 'Pick template' : 'Pick template' }}
      </li>
    </ol>

    <!-- Step 1: Mode — four options (Library / Generate / Template / Upload).
         Library is the default front door now: 60+ Philippine legal
         templates bundled with the app (Deeds, Leases, SPAs, Affidavits,
         …) that AI can fill from listing/contact context. The legacy
         Generate (free-text → AI body) and Template (admin-published)
         flows stay below for cases the library doesn't cover. -->
    <div v-if="step === 1" class="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <!--
        NOTE: the "Legal Library" mode is intentionally hidden here.
        Its backing endpoints (/api/legal-templates/*, /api/document-drafts/
        from-legal-template) were reverted; surfacing the button would
        send users to a 404 path. The script-section state +
        startFromLibrary handler are left in place so re-enabling is a
        one-line revert of this hide block + restoring the endpoints.
      -->
      <button
        type="button"
        class="rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-primary hover:bg-accent focus-ring"
        @click="pickMode('generate')"
      >
        <p class="mb-1 text-sm font-semibold text-foreground">
          Generate from Prompt
          <span class="ml-1 rounded bg-primary/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-primary">AI</span>
        </p>
        <p class="text-xs text-muted-foreground">
          Describe the deal in plain words. AI drafts a freeform
          document you can review and edit.
        </p>
      </button>
      <button
        type="button"
        class="rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-primary hover:bg-accent focus-ring"
        @click="pickMode('template')"
      >
        <p class="mb-1 text-sm font-semibold text-foreground">Org Template</p>
        <p class="text-xs text-muted-foreground">
          Pick from your firm's published templates. Best for forms that
          must look exactly the same every time.
        </p>
      </button>
      <button
        type="button"
        class="rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-primary hover:bg-accent focus-ring"
        @click="pickMode('upload')"
      >
        <p class="mb-1 text-sm font-semibold text-foreground">Upload Existing</p>
        <p class="text-xs text-muted-foreground">
          Already have a PDF (notarized, scanned, third-party)? Attach
          it and link it to this record.
        </p>
      </button>
    </div>

    <!-- Step 2 (library mode): pick a category from the bundled
         Philippine legal-templates catalog. Counts come from the
         loaded summary list so the broker sees how many docs each
         category contains before drilling in. -->
    <div v-else-if="step === 2 && mode === 'library'" class="space-y-2">
      <p
        v-if="libraryLoading && libraryCategories.length === 0"
        class="rounded-md border border-dashed border-border bg-surface-2 px-3 py-4 text-center text-xs text-muted-foreground"
      >
        Loading Philippine legal library…
      </p>
      <div
        v-else-if="libraryCategories.length === 0"
        class="rounded-md border border-dashed border-border bg-surface-2 px-3 py-4 text-center text-xs text-muted-foreground"
      >
        Template library is empty. Confirm
        <code class="rounded bg-muted px-1">legal-templates/ph/</code>
        is checked into the deployed bundle.
      </div>
      <div v-else class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <button
          v-for="cat in libraryCategories"
          :key="cat"
          type="button"
          class="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-3 text-left transition-colors hover:border-primary hover:bg-accent focus-ring"
          @click="pickLibraryCategory(cat)"
        >
          <span class="text-sm font-semibold text-foreground">{{ categoryLabel(cat) }}</span>
          <span class="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {{ libraryCategoryCounts[cat] ?? 0 }}
          </span>
        </button>
      </div>
    </div>

    <!-- Step 2 (other modes): legacy Lease / Rental / Sale type picker -->
    <div v-else-if="step === 2" class="grid grid-cols-3 gap-3">
      <button
        type="button"
        class="rounded-lg border border-border bg-card p-3 text-center transition-colors hover:border-primary hover:bg-accent focus-ring"
        @click="pickType('lease')"
      >
        <p class="text-sm font-semibold text-foreground">Lease</p>
        <p class="mt-1 text-[11px] text-muted-foreground">Long-term tenancy contracts</p>
      </button>
      <button
        type="button"
        class="rounded-lg border border-border bg-card p-3 text-center transition-colors hover:border-primary hover:bg-accent focus-ring"
        @click="pickType('rental')"
      >
        <p class="text-sm font-semibold text-foreground">Rental</p>
        <p class="mt-1 text-[11px] text-muted-foreground">Short-term and ad-hoc rentals</p>
      </button>
      <button
        type="button"
        class="rounded-lg border border-border bg-card p-3 text-center transition-colors hover:border-primary hover:bg-accent focus-ring"
        @click="pickType('sale')"
      >
        <p class="text-sm font-semibold text-foreground">Sale</p>
        <p class="mt-1 text-[11px] text-muted-foreground">Purchase agreements and deeds</p>
      </button>
    </div>

    <!-- Step 3 (library): pick a template from the chosen category.
         The AI-fill toggle defaults to on when listing/contact context
         is present (so the AI has something to substitute) and to off
         when it isn't (no context = AI would just leave everything as
         __________ anyway, so save the round-trip). -->
    <div v-else-if="step === 3 && mode === 'library'" class="space-y-3">
      <!-- Same admin-not-configured CTA as the Generate path. Triggered
           when AI-fill was requested but no provider is wired up. -->
      <div
        v-if="aiNotConfigured"
        class="rounded-md border border-warning/40 bg-warning/5 p-3 text-xs text-foreground"
      >
        <template v-if="aiNotConfigured.missing === 'SUPABASE_SERVICE_KEY'">
          <p class="mb-1 font-semibold">Server is missing SUPABASE_SERVICE_KEY</p>
          <p class="text-muted-foreground">
            Set <code class="rounded bg-muted px-1">SUPABASE_SERVICE_KEY</code>
            in <code class="rounded bg-muted px-1">.env</code> so the
            server can read AI settings, OR turn off "AI fill" below to
            create the draft with placeholders for manual filling.
          </p>
        </template>
        <template v-else>
          <p class="mb-1 font-semibold">AI fill isn't configured</p>
          <p class="text-muted-foreground">
            Configure the AI provider, or turn off "AI fill" to create
            the draft with placeholders intact.
          </p>
        </template>
        <NuxtLink
          :to="aiNotConfigured.admin_path"
          class="mt-2 inline-block font-semibold text-primary hover:underline focus-ring rounded"
        >
          Open AI settings →
        </NuxtLink>
        <button
          type="button"
          class="ml-3 text-muted-foreground hover:text-foreground focus-ring rounded"
          @click="aiNotConfigured = null"
        >
          Dismiss
        </button>
      </div>

      <!-- AI-fill toggle. Disabled when no listing/contact context —
           AI fill with nothing to draw on is wasted tokens. -->
      <label
        class="flex items-start gap-3 rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-muted-foreground"
      >
        <input
          v-model="libraryFillWithAi"
          type="checkbox"
          class="mt-0.5 h-4 w-4 rounded border-border accent-primary"
          :disabled="!props.listingId && !props.contactId"
        />
        <span>
          <span class="block text-sm font-semibold text-foreground">
            AI fill from listing + client context
          </span>
          <span v-if="props.listingId || props.contactId">
            AI replaces <code class="rounded bg-muted px-1">&#123;&#123;placeholders&#125;&#125;</code>
            with values from this {{ props.listingId ? 'listing' : '' }}{{ props.listingId && props.contactId ? ' + ' : '' }}{{ props.contactId ? 'client' : '' }}.
            Anything it can't confirm is left as <code class="rounded bg-muted px-1">__________</code> for you to fill.
          </span>
          <span v-else>
            (Disabled — open from a listing or contact for AI fill. The draft will be created with placeholders intact for manual entry.)
          </span>
        </span>
      </label>

      <p
        v-if="libraryLoading && libraryTemplatesByCategory.length === 0"
        class="rounded-md border border-dashed border-border bg-surface-2 px-3 py-4 text-center text-xs text-muted-foreground"
      >
        Loading templates…
      </p>
      <div
        v-else-if="libraryTemplatesByCategory.length === 0"
        class="rounded-md border border-dashed border-border bg-surface-2 px-3 py-4 text-center text-xs text-muted-foreground"
      >
        No templates in this category.
      </div>
      <ul v-else class="max-h-[420px] space-y-2 overflow-y-auto pr-1">
        <li
          v-for="t in libraryTemplatesByCategory"
          :key="t.slug"
          class="flex items-start justify-between gap-3 rounded-md border border-border bg-card p-3"
        >
          <div class="min-w-0 flex-1">
            <p class="text-sm font-semibold text-foreground">{{ t.title }}</p>
            <p class="mt-0.5 text-[11px] text-muted-foreground">
              {{ t.required_fields.length }} required
              <span v-if="t.optional_fields.length">
                · {{ t.optional_fields.length }} optional
              </span>
              · v{{ t.version }}
            </p>
          </div>
          <button
            type="button"
            class="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-ring disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="isWorking"
            @click="startFromLibrary(t.slug)"
          >
            <template v-if="submittingLibrary === t.slug">
              {{ libraryFillWithAi ? 'Filling…' : 'Creating…' }}
            </template>
            <template v-else>
              {{ libraryFillWithAi ? 'AI fill →' : 'Use template' }}
            </template>
          </button>
        </li>
      </ul>
    </div>

    <!-- Step 3 — Template: pick a published template -->
    <div v-else-if="step === 3 && mode === 'template'" class="space-y-2">
      <p class="text-xs text-muted-foreground">
        {{ docTypeLabel }} templates available on this account:
      </p>

      <p
        v-if="templatesLoading && filteredTemplates.length === 0"
        class="rounded-md border border-dashed border-border bg-surface-2 px-3 py-4 text-center text-xs text-muted-foreground"
      >
        Loading templates…
      </p>

      <div
        v-else-if="filteredTemplates.length === 0"
        class="rounded-md border border-dashed border-border bg-surface-2 px-3 py-4 text-center text-xs text-muted-foreground"
      >
        No {{ docTypeLabel.toLowerCase() }} templates published yet.
        Ask an admin to publish one in
        <NuxtLink to="/admin/document-templates" class="text-primary hover:underline">
          /admin/document-templates
        </NuxtLink>
        — or switch to Upload to attach an existing PDF.
      </div>

      <ul v-else class="space-y-2">
        <li
          v-for="t in filteredTemplates"
          :key="t.id"
          class="flex items-start justify-between gap-3 rounded-md border border-border bg-card p-3"
        >
          <div class="min-w-0 flex-1">
            <p class="text-sm font-semibold text-foreground">{{ t.name }}</p>
            <p
              v-if="t.description"
              class="mt-0.5 line-clamp-2 text-xs text-muted-foreground"
            >
              {{ t.description }}
            </p>
            <p class="mt-1 text-[11px] text-muted-foreground">
              {{ t.fields.length }} {{ t.fields.length === 1 ? 'field' : 'fields' }}
            </p>
          </div>
          <button
            type="button"
            class="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-ring disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="!!submittingTemplate"
            @click="startFromTemplate(t.id)"
          >
            {{ submittingTemplate === t.id ? 'Creating…' : 'Use this' }}
          </button>
        </li>
      </ul>
    </div>

    <!-- Step 3 — Generate: AI-assisted prompt -->
    <div v-else-if="step === 3 && mode === 'generate'" class="space-y-3">
      <!-- Admin-not-configured CTA. The 503 ai_not_configured response
           from the server lands here. Two failure modes — split the
           message so the broker doesn't waste time editing the AI
           settings page when the actual gap is the server env. -->
      <div
        v-if="aiNotConfigured"
        class="rounded-md border border-warning/40 bg-warning/5 p-3 text-xs text-foreground"
      >
        <template v-if="aiNotConfigured.missing === 'SUPABASE_SERVICE_KEY'">
          <p class="mb-1 font-semibold">Server environment is missing SUPABASE_SERVICE_KEY</p>
          <p class="text-muted-foreground">
            Even though the AI endpoint and API key are set in admin,
            the server can't read those settings without the Supabase
            <code class="rounded bg-muted px-1">service_role</code> key.
            Set <code class="rounded bg-muted px-1">SUPABASE_SERVICE_KEY</code>
            in your <code class="rounded bg-muted px-1">.env</code>
            (Supabase dashboard → Project Settings → API → service_role)
            and restart the server. AI generation will work after that.
          </p>
        </template>
        <template v-else>
          <p class="mb-1 font-semibold">AI generation isn't configured yet</p>
          <p class="text-muted-foreground">
            A platform admin needs to set the AI endpoint and API key before brokers can use this option.
          </p>
        </template>
        <NuxtLink
          :to="aiNotConfigured.admin_path"
          class="mt-2 inline-block font-semibold text-primary hover:underline focus-ring rounded"
        >
          Open AI settings →
        </NuxtLink>
        <button
          type="button"
          class="ml-3 text-muted-foreground hover:text-foreground focus-ring rounded"
          @click="aiNotConfigured = null"
        >
          Try again anyway
        </button>
      </div>

      <template v-else>
        <label class="block">
          <span class="block text-xs font-medium text-muted-foreground">
            Describe the document you need
          </span>
          <textarea
            v-model="aiPrompt"
            rows="6"
            maxlength="4000"
            placeholder="e.g. 12-month residential lease with two months security deposit, monthly rent ₱45,000, parking included, no pets. Tenant is Maria Santos, landlord is the listing owner. Start date 2026-06-01."
            class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
          />
        </label>
        <p class="rounded-md border border-border bg-surface-2 px-3 py-2 text-[11px] text-muted-foreground">
          The AI sees the chosen type ({{ docTypeLabel }}) plus the
          listing and client details on file. It drafts a full document
          you can review and edit before finalizing — nothing is sent
          to a counterparty until you say so.
        </p>
      </template>
    </div>

    <!-- Step 3 — Upload: file picker -->
    <div v-else-if="step === 3 && mode === 'upload'" class="space-y-3">
      <label
        class="block cursor-pointer rounded-lg border border-dashed border-border bg-surface-2 px-4 py-6 text-center transition-colors hover:border-primary"
      >
        <input
          type="file"
          accept="application/pdf,.pdf"
          class="hidden"
          @change="onFilePick"
        />
        <p v-if="!file" class="text-sm font-medium text-foreground">
          Click to choose a PDF
        </p>
        <p v-else class="text-sm font-medium text-foreground">
          {{ file.name }}
          <span class="text-muted-foreground">
            ({{ (file.size / 1_000_000).toFixed(1) }}MB)
          </span>
        </p>
        <p class="mt-1 text-xs text-muted-foreground">PDF only · max 25MB</p>
      </label>

      <p
        v-if="fileError"
        class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
      >
        {{ fileError }}
      </p>

      <p class="rounded-md border border-border bg-surface-2 px-3 py-2 text-[11px] text-muted-foreground">
        Uploaded files are stored as the draft's finalized PDF and
        the draft moves to <span class="font-semibold">Signed</span>
        status. You can replace the file later from the draft page.
      </p>
    </div>

    <template #footer>
      <button
        v-if="step > 1"
        type="button"
        class="rounded-md border border-border bg-card px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-ring"
        :disabled="isWorking"
        @click="back"
      >
        Back
      </button>
      <button
        type="button"
        class="rounded-md border border-border bg-card px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-ring"
        :disabled="isWorking"
        @click="close"
      >
        Cancel
      </button>
      <!-- Upload-step submit button. -->
      <button
        v-if="step === 3 && mode === 'upload'"
        type="button"
        class="rounded-md bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-ring disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="!file || uploading"
        @click="submitUpload"
      >
        {{ uploading ? 'Uploading…' : 'Upload + attach' }}
      </button>
      <!-- AI-generate submit button. Hidden when the not-configured
           CTA is showing — the admin-link is the only action then. -->
      <button
        v-if="step === 3 && mode === 'generate' && !aiNotConfigured"
        type="button"
        class="rounded-md bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-ring disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="aiPrompt.trim().length < 10 || aiGenerating"
        @click="submitAi"
      >
        {{ aiGenerating ? 'Generating…' : 'Generate draft' }}
      </button>
      <!-- Template-step submits inline per card, so no global submit
           button. -->
    </template>
  </UiModal>
</template>
