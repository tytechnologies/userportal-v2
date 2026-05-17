<script setup lang="ts">
// Single form used by both create and edit flows. Edit mode is implied
// by the presence of `initial` — we never pass an explicit mode boolean
// because that creates two sources of truth (mode + initial.id) that
// can disagree.
//
// Validation is intentionally minimal: full_name is required; email
// shape is sniff-checked client-side. The DB has a stricter constraint
// via the existing contactCreateSchema (server-side endpoints), and RLS
// makes sure the row lands on the right owner regardless. Don't replicate
// the schema's full ruleset here; it's a UX hint, not the gate.

import { computed, reactive, watch } from 'vue'
import type { Contact, ContactInput } from '~/composables/useContacts'

const props = defineProps<{
  /** Pre-fill the form when editing. Omit to render in create mode. */
  initial?: Contact | null
  /** True while the parent is awaiting a submit. Disables every input. */
  busy?: boolean
}>()

const emit = defineEmits<{
  (e: 'submit', payload: ContactInput): void
  (e: 'cancel'): void
}>()

const form = reactive<ContactInput>({
  full_name: '',
  email: '',
  mobile_phone: '',
  notes: '',
})

// Re-prefill whenever `initial` changes (e.g. opening the edit modal for
// a different row without unmounting the component).
watch(
  () => props.initial?.id,
  () => {
    form.full_name = props.initial?.full_name ?? ''
    form.email = props.initial?.email ?? ''
    form.mobile_phone = props.initial?.mobile_phone ?? ''
    form.notes = props.initial?.notes ?? ''
  },
  { immediate: true },
)

const errors = reactive({
  full_name: '',
  email: '',
})

const isEdit = computed(() => Boolean(props.initial?.id))

function validate(): boolean {
  errors.full_name = ''
  errors.email = ''
  let ok = true
  if (!form.full_name?.trim()) {
    errors.full_name = 'Full name is required.'
    ok = false
  }
  // Naive email check — a stricter regex would reject perfectly valid
  // addresses; the server-side zod validator catches the rest.
  if (form.email && !/^\S+@\S+\.\S+$/.test(form.email.trim())) {
    errors.email = 'That email address looks off.'
    ok = false
  }
  return ok
}

function onSubmit() {
  if (!validate()) return
  emit('submit', {
    full_name: form.full_name.trim(),
    email: form.email?.trim() || null,
    mobile_phone: form.mobile_phone?.trim() || null,
    notes: form.notes?.trim() || null,
  })
}
</script>

<template>
  <form class="space-y-4" novalidate @submit.prevent="onSubmit">
    <div>
      <label class="mb-1 block text-xs font-semibold text-foreground" for="contact-full-name">
        Full name <span class="text-destructive">*</span>
      </label>
      <input
        id="contact-full-name"
        v-model="form.full_name"
        type="text"
        autocomplete="name"
        :disabled="busy"
        class="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30 disabled:opacity-60"
        :class="{ 'border-destructive': errors.full_name }"
      />
      <p v-if="errors.full_name" class="mt-1 text-xs text-destructive">
        {{ errors.full_name }}
      </p>
    </div>

    <div>
      <label class="mb-1 block text-xs font-semibold text-foreground" for="contact-email">
        Email
      </label>
      <input
        id="contact-email"
        v-model="form.email"
        type="email"
        autocomplete="email"
        :disabled="busy"
        class="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30 disabled:opacity-60"
        :class="{ 'border-destructive': errors.email }"
      />
      <p v-if="errors.email" class="mt-1 text-xs text-destructive">
        {{ errors.email }}
      </p>
    </div>

    <div>
      <label class="mb-1 block text-xs font-semibold text-foreground" for="contact-mobile">
        Mobile phone
      </label>
      <input
        id="contact-mobile"
        v-model="form.mobile_phone"
        type="tel"
        autocomplete="tel"
        :disabled="busy"
        class="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30 disabled:opacity-60"
      />
    </div>

    <div>
      <label class="mb-1 block text-xs font-semibold text-foreground" for="contact-notes">
        Notes
      </label>
      <textarea
        id="contact-notes"
        v-model="form.notes"
        rows="3"
        :disabled="busy"
        class="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30 disabled:opacity-60"
      />
    </div>

    <div class="flex items-center justify-end gap-2 pt-2">
      <button
        type="button"
        class="rounded-md px-3 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted"
        :disabled="busy"
        @click="emit('cancel')"
      >
        Cancel
      </button>
      <button
        type="submit"
        class="rounded-md bg-primary px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="busy"
      >
        <span v-if="busy">Saving…</span>
        <span v-else>{{ isEdit ? 'Save changes' : 'Create contact' }}</span>
      </button>
    </div>
  </form>
</template>
