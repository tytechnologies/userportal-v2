<script setup lang="ts">
// Visual designer for document_template_definitions.
//
// Interaction model:
//   - Click on the canvas (no field selected, no drag) → spawn a new
//     field at click position, auto-select it, open the property panel.
//   - Click on a field → select it, open the property panel.
//   - Mousedown + drag a selected field → reposition (with snap-to-grid
//     when Shift held).
//   - Side panel edits the selected field's properties; Delete button
//     removes it.
//   - Save button PATCHes the whole row (fields + width + height + meta).
//
// Coordinates are pure pixels relative to the background image's
// top-left, mirroring the runtime DocumentEditor exactly so positions
// authored here render at the same place at fill-in time.

import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import {
  useTemplateDefinitions,
  type TemplateDefinition,
} from '~/composables/useTemplateDefinitions'
import {
  humanizeFieldKey,
  type DocumentTemplateField,
  type FieldType,
} from '~/utils/documentTemplates'
import { showToast } from '~/helpers/helpers'

const props = defineProps<{
  template: TemplateDefinition
}>()

const emit = defineEmits<{
  (e: 'saved', template: TemplateDefinition): void
}>()

const { saveTemplate, uploadBackground } = useTemplateDefinitions()

// Local working copy. Reactive so the designer can mutate freely
// without touching the parent's state until Save.
const fields = ref<DocumentTemplateField[]>(
  Array.isArray(props.template.fields) ? JSON.parse(JSON.stringify(props.template.fields)) : [],
)
const name = ref(props.template.name)
const description = ref(props.template.description ?? '')
const status = ref(props.template.status)
const width = ref(props.template.width)
const height = ref(props.template.height)
const backgroundUrl = ref(props.template.background_url ?? props.template.background_path ?? '')

const selectedIndex = ref<number | null>(null)
const selected = computed<DocumentTemplateField | null>(() =>
  selectedIndex.value !== null ? fields.value[selectedIndex.value] ?? null : null,
)

const isSaving = ref(false)
const isUploadingBg = ref(false)
const dirty = ref(false)
function markDirty() { dirty.value = true }

// =====================================================================
// Field key helpers
// =====================================================================
//
// Field keys must be unique within a template — they're the JSONB keys
// for document_drafts.data. Generate "field_1", "field_2", … on add;
// the property panel lets the user rename to something stable.

function nextAvailableKey(): string {
  const existing = new Set(fields.value.map((f) => f.key))
  let i = 1
  while (existing.has(`field_${i}`)) i++
  return `field_${i}`
}

function isKeyUnique(key: string, ignoreIndex: number | null = null): boolean {
  for (let i = 0; i < fields.value.length; i++) {
    if (i === ignoreIndex) continue
    if (fields.value[i]!.key === key) return false
  }
  return true
}

// =====================================================================
// Canvas geometry
// =====================================================================
//
// The background image renders at its NATURAL size (template width/
// height in pixels). We capture the canvas's bounding rect on each
// pointer event to translate from page coordinates to template
// coordinates. No scaling: 1 page-pixel = 1 template-pixel.

const canvas = ref<HTMLDivElement | null>(null)

function pageToTemplate(e: PointerEvent | MouseEvent): { x: number; y: number } {
  const rect = canvas.value?.getBoundingClientRect()
  if (!rect) return { x: 0, y: 0 }
  return { x: Math.max(0, Math.round(e.clientX - rect.left)), y: Math.max(0, Math.round(e.clientY - rect.top)) }
}

// Empty-canvas click → add a field there.
function onCanvasMouseDown(e: MouseEvent) {
  // Ignore clicks that originated on a field (e.target is a child).
  const target = e.target as HTMLElement
  if (target.closest('[data-field-index]')) return
  const { x, y } = pageToTemplate(e)
  const f: DocumentTemplateField = {
    key: nextAvailableKey(),
    type: 'text',
    x,
    y,
    width: 200,
    height: 28,
    label: undefined,
  }
  fields.value.push(f)
  selectedIndex.value = fields.value.length - 1
  markDirty()
}

// =====================================================================
// Drag-to-reposition
// =====================================================================

let dragState: {
  index: number
  offsetX: number
  offsetY: number
  pointerId: number
} | null = null

function onFieldPointerDown(e: PointerEvent, index: number) {
  e.preventDefault()
  e.stopPropagation()
  const f = fields.value[index]
  if (!f) return
  selectedIndex.value = index
  const { x, y } = pageToTemplate(e)
  dragState = {
    index,
    offsetX: x - f.x,
    offsetY: y - f.y,
    pointerId: e.pointerId,
  }
  // Capture so we keep getting events even if the cursor exits the
  // field bounds during the drag.
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  window.addEventListener('pointermove', onWindowPointerMove)
  window.addEventListener('pointerup', onWindowPointerUp, { once: true })
}

function onWindowPointerMove(e: PointerEvent) {
  if (!dragState) return
  const f = fields.value[dragState.index]
  if (!f) return
  const { x, y } = pageToTemplate(e)
  let nx = x - dragState.offsetX
  let ny = y - dragState.offsetY
  // Shift snap — every 10px. Useful for visually aligning columns.
  if (e.shiftKey) {
    nx = Math.round(nx / 10) * 10
    ny = Math.round(ny / 10) * 10
  }
  // Clamp to canvas bounds.
  nx = Math.max(0, Math.min(width.value - (f.width ?? 200), nx))
  ny = Math.max(0, Math.min(height.value - (f.height ?? 28), ny))
  f.x = nx
  f.y = ny
  markDirty()
}

function onWindowPointerUp() {
  window.removeEventListener('pointermove', onWindowPointerMove)
  dragState = null
}

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onWindowPointerMove)
})

// =====================================================================
// Property panel actions
// =====================================================================

function deleteSelected() {
  if (selectedIndex.value === null) return
  fields.value.splice(selectedIndex.value, 1)
  selectedIndex.value = null
  markDirty()
}

function duplicateSelected() {
  if (selectedIndex.value === null) return
  const src = fields.value[selectedIndex.value]
  if (!src) return
  const copy: DocumentTemplateField = JSON.parse(JSON.stringify(src))
  copy.key = nextAvailableKey()
  copy.x = Math.min(width.value - (copy.width ?? 200), copy.x + 16)
  copy.y = Math.min(height.value - (copy.height ?? 28), copy.y + 16)
  fields.value.push(copy)
  selectedIndex.value = fields.value.length - 1
  markDirty()
}

function moveSelectedBy(dx: number, dy: number) {
  if (!selected.value || selectedIndex.value === null) return
  const f = fields.value[selectedIndex.value]!
  f.x = Math.max(0, Math.min(width.value - (f.width ?? 200), f.x + dx))
  f.y = Math.max(0, Math.min(height.value - (f.height ?? 28), f.y + dy))
  markDirty()
}

// Field keys come in via v-model on a text input — debounce-validate
// so the user gets a clear error if they collide with another key.
const keyError = ref<string | null>(null)
function onKeyInput() {
  if (selectedIndex.value === null) return
  const f = fields.value[selectedIndex.value]
  if (!f) return
  // Sanitize: lowercase, snake_case-ish.
  f.key = (f.key || '').toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
  if (!f.key) {
    keyError.value = 'Key is required.'
  } else if (!isKeyUnique(f.key, selectedIndex.value)) {
    keyError.value = 'Another field already uses this key.'
  } else {
    keyError.value = null
  }
  markDirty()
}

// =====================================================================
// Save / publish
// =====================================================================

async function save() {
  if (keyError.value) {
    showToast({ title: keyError.value, icon: 'warning' })
    return
  }
  isSaving.value = true
  try {
    const updated = await saveTemplate(props.template.id, {
      name: name.value,
      description: description.value || null,
      width: width.value,
      height: height.value,
      fields: fields.value as any,
      status: status.value,
    })
    dirty.value = false
    emit('saved', updated)
    showToast({ title: 'Template saved.', icon: 'success' })
  } catch (err: any) {
    showToast({ title: err?.statusMessage || err?.message || 'Save failed.', icon: 'error' })
  } finally {
    isSaving.value = false
  }
}

// =====================================================================
// Background upload
// =====================================================================

const fileInput = ref<HTMLInputElement | null>(null)
function pickBackground() { fileInput.value?.click() }

async function onBackgroundChange(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  // Read intrinsic dimensions via a one-shot Image so we can update
  // the canvas size to match the background's natural pixels.
  const dims = await readImageDimensions(file).catch(() => null)
  isUploadingBg.value = true
  try {
    const updated = await uploadBackground(props.template.id, file, {
      width: dims?.width,
      height: dims?.height,
    })
    backgroundUrl.value = updated.background_url ?? updated.background_path ?? ''
    width.value = updated.width
    height.value = updated.height
    showToast({ title: 'Background uploaded.', icon: 'success' })
  } catch (err: any) {
    showToast({ title: err?.statusMessage || err?.message || 'Upload failed.', icon: 'error' })
  } finally {
    isUploadingBg.value = false
    input.value = ''
  }
}

function readImageDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve({ width: img.naturalWidth, height: img.naturalHeight })
    }
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e) }
    img.src = url
  })
}

// Keyboard shortcuts for the selected field — arrow keys nudge,
// Delete / Backspace removes. Captured at the document so the user
// can be focused anywhere except text inputs.
function onKeyDown(e: KeyboardEvent) {
  // Don't hijack typing in form fields.
  const t = e.target as HTMLElement
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
  if (selectedIndex.value === null) return
  const step = e.shiftKey ? 10 : 1
  if (e.key === 'ArrowLeft')  { e.preventDefault(); moveSelectedBy(-step, 0) }
  if (e.key === 'ArrowRight') { e.preventDefault(); moveSelectedBy(step, 0) }
  if (e.key === 'ArrowUp')    { e.preventDefault(); moveSelectedBy(0, -step) }
  if (e.key === 'ArrowDown')  { e.preventDefault(); moveSelectedBy(0, step) }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected() }
}
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onKeyDown)
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeyDown))
}

// =====================================================================
// Display helpers
// =====================================================================

function fieldStyle(f: DocumentTemplateField, isSelected: boolean) {
  const w = f.width ?? 200
  const h = f.height ?? (f.type === 'textarea' ? 80 : 28)
  return {
    position: 'absolute' as const,
    top: `${f.y}px`,
    left: `${f.x}px`,
    width: `${w}px`,
    height: `${h}px`,
    cursor: 'grab',
    background: isSelected ? 'rgba(59, 130, 246, 0.18)' : 'rgba(59, 130, 246, 0.08)',
    border: isSelected ? '2px solid #2563eb' : '1px dashed #94a3b8',
    boxSizing: 'border-box' as const,
  }
}

const TYPES: FieldType[] = ['text', 'number', 'date', 'textarea', 'email', 'tel']
</script>

<template>
  <ClientOnly>
    <div class="grid gap-4 lg:grid-cols-[1fr_320px]">
      <!-- ========== Canvas ========== -->
      <div class="space-y-3">
        <!-- Top row: title + status + save. -->
        <header class="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-background p-3 shadow-sm">
          <input
            v-model="name"
            type="text"
            placeholder="Template name"
            class="flex-1 rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
            @input="markDirty"
          />
          <select
            v-model="status"
            class="rounded-md border border-border px-2 py-2 text-xs"
            @change="markDirty"
          >
            <option value="draft">Draft</option>
            <option value="published">Published</option>
            <option value="archived">Archived</option>
          </select>
          <button
            type="button"
            class="rounded-md bg-muted px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted"
            @click="pickBackground"
            :disabled="isUploadingBg"
          >
            <span v-if="isUploadingBg">Uploading…</span>
            <span v-else>{{ backgroundUrl ? 'Replace background' : 'Upload background' }}</span>
          </button>
          <button
            type="button"
            class="rounded-md bg-primary px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="isSaving || !!keyError"
            @click="save"
          >
            <span v-if="isSaving">Saving…</span>
            <span v-else>Save</span>
          </button>
          <input
            ref="fileInput"
            type="file"
            accept="image/*"
            class="hidden"
            @change="onBackgroundChange"
          />
        </header>

        <p class="text-xs text-muted-foreground">
          Click an empty spot to add a field. Drag fields to reposition.
          Hold Shift while dragging or pressing arrow keys to snap to a
          10 px grid. Delete removes the selected field.
        </p>

        <!-- Canvas — natural-size template page with overlaid field
             rectangles. Inner div has the natural pixel dimensions so
             coordinates from documentTemplates.ts land 1:1. -->
        <div class="overflow-x-auto rounded-xl border border-border bg-muted/50 shadow-sm">
          <div
            ref="canvas"
            class="relative mx-auto bg-card"
            :style="{ width: `${width}px`, height: `${height}px` }"
            @mousedown="onCanvasMouseDown"
          >
            <img
              v-if="backgroundUrl"
              :src="backgroundUrl"
              :alt="template.name"
              class="absolute inset-0 h-full w-full select-none"
              draggable="false"
            />
            <div
              v-else
              class="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground/70"
            >
              Upload a background image to start placing fields.
            </div>

            <div
              v-for="(f, i) in fields"
              :key="i"
              :data-field-index="i"
              :style="fieldStyle(f, selectedIndex === i)"
              class="rounded-sm"
              role="button"
              :aria-label="`Field ${f.label || f.key}`"
              @pointerdown="onFieldPointerDown($event, i)"
            >
              <span
                class="pointer-events-none absolute -top-5 left-0 truncate whitespace-nowrap rounded bg-primary px-1 text-[10px] font-semibold text-white shadow"
                style="max-width: 100%"
              >
                {{ f.label || f.key }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- ========== Property panel ========== -->
      <aside class="rounded-xl border border-border bg-background p-4 shadow-sm">
        <header class="mb-3 flex items-center justify-between">
          <h2 class="text-sm font-semibold text-foreground">
            {{ selected ? 'Field' : 'Template' }}
          </h2>
          <span v-if="dirty" class="text-xs text-warning">Unsaved</span>
        </header>

        <!-- Template-level (no field selected) -->
        <div v-if="!selected" class="space-y-3 text-xs">
          <label class="block">
            <span class="font-semibold text-foreground">Description</span>
            <textarea
              v-model="description"
              rows="3"
              class="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
              @input="markDirty"
            />
          </label>
          <div class="grid grid-cols-2 gap-2">
            <label class="block">
              <span class="font-semibold text-foreground">Width (px)</span>
              <input
                v-model.number="width"
                type="number"
                min="100"
                max="5000"
                class="mt-1 w-full rounded-md border border-border px-2 py-1.5 text-sm"
                @input="markDirty"
              />
            </label>
            <label class="block">
              <span class="font-semibold text-foreground">Height (px)</span>
              <input
                v-model.number="height"
                type="number"
                min="100"
                max="7000"
                class="mt-1 w-full rounded-md border border-border px-2 py-1.5 text-sm"
                @input="markDirty"
              />
            </label>
          </div>
          <p class="text-muted-foreground">
            Click a field on the canvas to edit it, or click an empty
            spot to add one.
          </p>
          <p class="text-muted-foreground">
            {{ fields.length }} field{{ fields.length === 1 ? '' : 's' }} placed.
          </p>
        </div>

        <!-- Field-level (a field is selected) -->
        <div v-else class="space-y-3 text-xs">
          <label class="block">
            <span class="font-semibold text-foreground">Key</span>
            <input
              :value="selected.key"
              type="text"
              class="mt-1 w-full rounded-md border px-2 py-1.5 font-mono text-sm focus:outline-none focus:ring-1"
              :class="keyError ? 'border-destructive focus:border-destructive focus:ring-destructive/30' : 'border-border focus:border-primary focus:ring-primary/30'"
              @input="(e) => { if (selectedIndex !== null) { fields[selectedIndex]!.key = (e.target as HTMLInputElement).value; onKeyInput() } }"
            />
            <p v-if="keyError" class="mt-1 text-destructive">{{ keyError }}</p>
          </label>

          <label class="block">
            <span class="font-semibold text-foreground">Label</span>
            <input
              v-model="selected.label"
              type="text"
              :placeholder="humanizeFieldKey(selected.key)"
              class="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
              @input="markDirty"
            />
          </label>

          <label class="block">
            <span class="font-semibold text-foreground">Type</span>
            <select
              v-model="selected.type"
              class="mt-1 w-full rounded-md border border-border px-2 py-1.5 text-sm"
              @change="markDirty"
            >
              <option v-for="t in TYPES" :key="t" :value="t">{{ t }}</option>
            </select>
          </label>

          <div class="grid grid-cols-4 gap-2">
            <label class="block">
              <span class="font-semibold text-foreground">X</span>
              <input
                v-model.number="selected.x"
                type="number"
                min="0"
                class="mt-1 w-full rounded-md border border-border px-2 py-1.5 text-sm"
                @input="markDirty"
              />
            </label>
            <label class="block">
              <span class="font-semibold text-foreground">Y</span>
              <input
                v-model.number="selected.y"
                type="number"
                min="0"
                class="mt-1 w-full rounded-md border border-border px-2 py-1.5 text-sm"
                @input="markDirty"
              />
            </label>
            <label class="block">
              <span class="font-semibold text-foreground">W</span>
              <input
                v-model.number="selected.width"
                type="number"
                min="20"
                class="mt-1 w-full rounded-md border border-border px-2 py-1.5 text-sm"
                @input="markDirty"
              />
            </label>
            <label class="block">
              <span class="font-semibold text-foreground">H</span>
              <input
                v-model.number="selected.height"
                type="number"
                min="20"
                class="mt-1 w-full rounded-md border border-border px-2 py-1.5 text-sm"
                @input="markDirty"
              />
            </label>
          </div>

          <label class="flex items-center gap-2">
            <input
              :checked="!!selected.validation?.required"
              type="checkbox"
              @change="(e) => {
                if (!selected) return
                if (!selected.validation) selected.validation = {}
                selected.validation.required = (e.target as HTMLInputElement).checked
                markDirty()
              }"
            />
            <span class="font-semibold text-foreground">Required</span>
          </label>

          <div class="flex justify-between gap-2 pt-2">
            <button
              type="button"
              class="rounded-md bg-muted px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted"
              @click="duplicateSelected"
            >
              Duplicate
            </button>
            <button
              type="button"
              class="rounded-md bg-destructive/10 px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/15"
              @click="deleteSelected"
            >
              Delete
            </button>
          </div>
        </div>
      </aside>
    </div>
  </ClientOnly>
</template>
