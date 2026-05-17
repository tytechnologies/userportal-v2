<template>
    <div class="w-full flex">
        <div class="flex-1 flex-col w-0 mb-8">
            <Tabs :overrideIndex="documentTabsIndex">
                <Tab :title="tabs[0].title">
                    <Residential/>
                </Tab>
                <Tab :title="tabs[1].title">
                    <Commercial />
                </Tab>
                <Tab :title="tabs[2].title">
                    <Generator />
                </Tab>
            </Tabs>
        </div>
    </div>
</template>
<script>
import Tab from '~/components/Tab.vue'
import Tabs from '~/components/Tabs.vue'
import Residential from '~/pages/contracts-residential-viewing-list.vue'
import Commercial from '~/pages/contracts-commercial-viewing-list.vue'
import Generator from '~/components/pages/documents/Generator'

export default {
    middleware: ['auth'],
    components: {
        Tab,
        Tabs,
        Residential,
        Commercial,
        Generator,
    },
    data() {
        return {
            activeTab: 0,
            tabs: [
                {
                    title: 'Residential List',
                    isActive: false,
                },
                {
                    title: 'Commercial List',
                    isActive: false,
                },
                {
                    title: 'Generate Document',
                    isActive: false,
                },
            ],
            documentTabsIndex: 0,
        }
    },
    methods: {
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
                this.fetch()
            }
        },
        setDefaultTab(division) {
            let tabIndex = 0;
            if(division == 'commercial') {
                tabIndex = 1;
            }
            this.toggleDocumentTabs(tabIndex);            
        }
    },
    mounted() {        
        this.setDefaultTab(this.$route.query.division);
    }
}
</script>


<style>
.ellipsis {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.col-locations {
   width:250px;
}

.col-buildings {
    width:300px;
}
</style>
