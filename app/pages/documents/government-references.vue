<script setup lang="ts">
// Standalone government documents page. Thin wrapper around
// GovernmentDocumentsList — the same content also embeds inside
// /document-tabs (Document Checklist tab).

import GovernmentDocumentsList from '~/components/documents/GovernmentDocumentsList.vue'

definePageMeta({ layout: 'default' })
useHead({ title: 'Government documents | Housinginteractive' })
</script>

<template>
  <div class="mx-auto max-w-4xl p-4">
    <header class="mb-4">
      <h1 class="text-xl font-bold text-foreground">Government documents</h1>
      <p class="text-sm text-muted-foreground">
        Reference library for title transfer, BIR forms, registration steps, and related workflows.
        Click any document to open the PDF.
      </p>
    </header>

    <GovernmentDocumentsList />
  </div>
</template>
