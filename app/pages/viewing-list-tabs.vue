<template>
  <div class="w-full flex">
    <!-- we are commiting just to build the system again -->
    <div class="flex-1 flex-col w-full mb-8">
      <Tabs :overrideIndex="documentTabsIndex">
        <Tab :title="tabs[0].title">
          <DocumentViewingList :division="`residential`" />
        </Tab>
        <Tab :title="tabs[1].title">
          <DocumentViewingList :division="`commercial`" />
        </Tab>
      </Tabs>
    </div>
  </div>
</template>
<script>
import Tab from '~/components/Tab.vue'
import Tabs from '~/components/Tabs.vue'
import DocumentViewingList from '~/pages/document-viewing-list.vue'
import Generator from '~/components/pages/documents/Generator'

export default {
  middleware: ['auth'],
  components: {
    Tab,
    Tabs,
    DocumentViewingList,
    Generator,
  },
  props: {
    division: String,
  },
  data() {
    return {
      activeTab: 0,
      tabs: [
        {
          title: 'Residential List',
          isActive: false,
          division: 'residential',
        },
        {
          title: 'Commercial List',
          isActive: false,
          division: 'commercial',
        },
      ],
      documentTabsIndex: 0,
    }
  },
  methods: {
    setDefaultTab() {
      const index = this.tabs.findIndex(
        (item) => item.division == this.division
      )
      this.documentTabsIndex = index > -1 ? index : 0
    },
    /*
    toggleDocumentTabs(index) {
      this.documentTabsIndex = index
    },
    togglePageTab(index) {
      if (this.tabs[index].isActive) {
        return false
      }
      this.tabs[this.activeTab].isActive = !this.tabs[this.activeTab].isActive
      this.title = this.tabs[index].title
      this.tabs[index].isActive = !this.tabs[index].isActive
      this.activeTab = index
      const params = this.tabs[index].params
      if (params) {
        //this.fetch('viewing-list-tabs')
      }
    },
    */
  },
  mounted() {
    this.setDefaultTab()
  },
}
</script>
