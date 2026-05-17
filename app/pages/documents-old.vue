<template>
    <div class="w-full flex">
        <div class="flex-1 flex-col w-0 mb-8">
            <Tabs :overrideIndex="documentTabsIndex">
                <Tab title="Step 1 - PRE-DOAS (DEED OF ABSOLUTE SALE)">
                    <Checklist :documents="documentChekcklist.step1" :step="1" @next="toggleDocumentTabs(1)"
                        @prev="toggleDocumentTabs(0)" />
                </Tab>
                <Tab title="Step 2 - BIR payment of Capital Gains taxes">
                    <Checklist :documents="documentChekcklist.step2" :step="2" @next="toggleDocumentTabs(2)"
                        @prev="toggleDocumentTabs(0)" />
                </Tab>
                <Tab title="Step 3 - Transfer taxes and Registration fees">
                    <Checklist :documents="documentChekcklist.step3" :step="2" @prev="toggleDocumentTabs(1)" />
                </Tab>
            </Tabs>
        </div>
    </div>
</template>
<script>
import Checklist from '~/components/pages/documents/Checklist'
import Generator from '~/components/pages/documents/Generator'
import TaxComputationTabs from '~/components/pages/documents/TaxComputationTabs'
import Tab from '~/components/Tab.vue'
import Tabs from '~/components/Tabs.vue'
import Dropdown from '~/components/Dropdown'
import Magnify from 'vue-material-design-icons/Magnify.vue'

export default {
    middleware: ['auth'],
    components: {
        Magnify,
        Dropdown,
        Checklist,
        Generator,
        TaxComputationTabs,
        Tab,
        Tabs,
    },
    data() {
        return {
            title: 'Document Checklist',
            activeTab: 0,
            tabs: [
                {
                    title: 'Document Checklist',
                    isActive: true,
                },
                {
                    title: 'Residential List',
                    isActive: false,
                },
                {
                    title: 'Commercial List',
                    isActive: false,
                },
            ],
            documentTabsIndex: 0,
            documentChekcklist: {
                step1: [
                    {
                        title: 'Copy of Deed of Absolute Sale',
                        image: 'deed-of-absolute-sale.jpg',
                        isChecked: false,
                    },
                    {
                        title: 'Original Copy of CCT (Condominium Certificate of Title)',
                        image: 'original-copy-cct.jpg',
                        isChecked: false,
                    },
                    {
                        title:
                            'Certified True Copy of CCT (Condominium Certificate of Title)',
                        image: 'certified-copy-cct.jpg',
                        isChecked: false,
                    },
                    {
                        title:
                            'Original Copy of Declaration of Real Property (Tax Declaration)',
                        image: 'original-copy-declaration-real-property.jpg',
                        isChecked: false,
                    },
                    {
                        title:
                            'Certified True Copy of Declaration of Real Property (Tax Declaration)',
                        image: 'certified-copy-declaration-real-property.jpg',
                        isChecked: false,
                    },
                    {
                        title: 'Original Copy of Certificate of Authorizing Registration',
                        image: 'original-copy-certificate-authorizing-registration.jpg',
                        isChecked: false,
                    },
                    {
                        title:
                            'Certified True Copy of Certificate of Authorizing Registration',
                        image: 'certified-copy-certificate-authorizing-registration.jpg',
                        isChecked: false,
                    },
                    {
                        title:
                            'Certified True Copy of Certificate of Non-Delinquency on Real Property Tax (Tax Clearance)',
                        image: 'certified-copy-tax-clearance.jpg',
                        isChecked: false,
                    },
                    {
                        title: 'Original Copy of Updated Real Property Tax Receipt',
                        image: 'original-copy-real-property-tax-receipt.jpg',
                        isChecked: false,
                    },
                    {
                        title:
                            'Original Copy of Certificate of Non-Tenancy from the Building Administration Office',
                        image: 'original-copy-certificate-non-tenancy.jpg',
                        isChecked: false,
                    },
                    {
                        title:
                            'Original Copy of the Certificate of Non-Delinquency of Bill Payments from the Building Administration Office',
                        image:
                            'original-copy-certificate-non-delinquency-of-bill-payments.jpg',
                        isChecked: false,
                    },
                    {
                        title:
                            'Original Copy of the Certificate of Management from the Building Administration',
                        image: 'original-copy-certificate-management.jpg',
                        isChecked: false,
                    },
                    {
                        title: '2 Valid Government IDs',
                        image: 'government-id-passport.jpg',
                        isChecked: false,
                    },
                    {
                        title: 'Special Power of Attorney (SPA)',
                        image: 'special-power-attorney.jpg',
                        isChecked: false,
                    },
                ],
                step2: [
                    {
                        title: 'Notarized Deed of Absolute Sale',
                        image: 'doas.jpg',
                        isChecked: false,
                    },
                    {
                        title: 'Computation of Capital Gains Tax (CGT)',
                        image: 'cgt.jpg',
                        isChecked: false,
                    },
                    {
                        title: 'Computation of Documentary Stamp Tax (DST)',
                        image: 'dst.jpg',
                        isChecked: false,
                    },
                    {
                        title: 'Certificate Authorizing Registration (CAR)',
                        image: 'scar.jpg',
                        isChecked: false,
                    },
                    {
                        title: 'Transfer Tax computation & payment',
                        image: 'transfer-tax.jpg',
                        isChecked: false,
                    },
                    {
                        title: 'Transfer of Certificate of Title (TCT)',
                        image: 'tct.jpg',
                        isChecked: false,
                    },
                ],
                step3: [
                    {
                        title: 'Property Title',
                        image: 'ctc-title.jpg',
                        isChecked: false,
                    },
                    {
                        title: 'Certified True Copies of the Title',
                        image: 'ctc-title.jpg',
                        isChecked: false,
                    },
                    {
                        title:
                            'New Tax Declaration under Buyer\'s name',
                        image: 'new-tax-declaration.jpg',
                        isChecked: false,
                    },
                    {
                        title: 'Transmittal of the unit\'s Original Document to the new Unit Owner',
                        image: 'transmittal.jpg',
                        isChecked: false,
                    }
                ],
            },
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
    },
}
</script>
