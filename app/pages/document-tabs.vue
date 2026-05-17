<template>
  <div class="mx-auto w-full max-w-5xl p-4">
    <header class="mb-4">
      <h1 class="text-xl font-bold text-foreground">Documents</h1>
      <p class="text-sm text-muted-foreground">
        Document Checklist (Example), viewing lists, and contracts in one
        place. Switch tabs above; deep-link with
        <code class="rounded bg-muted px-1.5 py-0.5 text-xs">?tab=&lt;name&gt;</code>.
      </p>
    </header>

    <Tabs :overrideIndex="activeTabIndex">
      <Tab title="Document Checklist">
        <!-- Government docs library — was previously the hardcoded
             documents-old.vue page; now the dynamic admin-managed
             library populated from public.government_documents. -->
        <GovernmentDocumentsList />
      </Tab>

      <Tab title="Viewing List">
        <ViewingListTabs :division="viewingListDivision" />
      </Tab>

      <Tab title="Contracts">
        <ContractsListTabs />
      </Tab>
    </Tabs>
  </div>
</template>

<script>
// /document-tabs — the documents hub.
//
// Three top-level tabs:
//   1. Document Checklist  → broker-facing government reference library
//                            (sourced from public.government_documents,
//                            admin-managed at /admin/government-documents)
//   2. Viewing List        → existing residential / commercial viewing
//                            list browser
//   3. Contracts           → existing contracts list + generator
//
// Deep links honored via ?tab=document-checklist | viewing-list | contracts
// and (for the viewing-list tab) ?division=residential | commercial.

import Tab from '~/components/Tab.vue'
import Tabs from '~/components/Tabs.vue'
import GovernmentDocumentsList from '~/components/documents/GovernmentDocumentsList.vue'
import ViewingListTabs from '~/pages/viewing-list-tabs.vue'
import ContractsListTabs from '~/pages/contracts-list-tabs.vue'

// Mapping kept in sync with the <Tab> order above. Adding a tab means
// adding an entry here AND a <Tab> in the template.
const TAB_KEY_TO_INDEX = {
  'document-checklist': 0,
  // Backwards-compat aliases for the old query strings before the
  // rename. New code should use document-checklist.
  'documents': 0,
  'government-references': 0,

  'viewing-list': 1,

  'contracts': 2,
}

export default {
  middleware: ['auth'],
  components: {
    Tab,
    Tabs,
    GovernmentDocumentsList,
    ViewingListTabs,
    ContractsListTabs,
  },

  data() {
    return {
      activeTabIndex: 0,
      viewingListDivision: 'residential',
    }
  },

  mounted() {
    const q = this.$route.query
    if (typeof q.tab === 'string' && q.tab in TAB_KEY_TO_INDEX) {
      this.activeTabIndex = TAB_KEY_TO_INDEX[q.tab]
    }
    if (typeof q.division === 'string' && (q.division === 'residential' || q.division === 'commercial')) {
      this.viewingListDivision = q.division
    }
  },

}
</script>
