<template>
  <div class="flex flex-col h-full gap-4 pt-4 lg:flex-row">
    <aside
      class="flex flex-col w-full px-6 py-8 bg-card generator-aside lg:w-90"
    >
      <h3 class="mb-4 text-2xl font-black">Generate Document</h3>

      <div class="mb-8">
        <span class="block mb-3 text-sm font-medium">Document</span>
        <div
          class="relative inline-block w-full text-left dropdown"
          v-on-clickaway="closeDropdown"
        >
          <button
            type="button"
            class="w-full h-14 flex px-6 pt-2.5 pr-10 leading-8 font-bold text-primary bg-primary/10 focus:outline-none rounded-lg whitespace-nowrap"
            aria-expanded="true"
            aria-haspopup="true"
            @click="showDocumentDropdown = !showDocumentDropdown"
          >
            <span class="relative top-0.5">{{ selectedDocument }}</span>
            <MenuDown
              v-if="!showDocumentDropdown"
              class="w-6 h-6 absolute right-4 top-3.5"
            />
            <MenuUp v-else class="w-6 h-6 absolute right-4 top-3.5" />
          </button>
          <transition
            enter-active-class="transition duration-100 ease-out"
            enter-from-class="transform scale-95 opacity-0"
            enter-to-class="transform scale-100 opacity-100"
            leave-active-class="transition duration-75 ease-in"
            leave-from-class="transform scale-100 opacity-100"
            leave-to-class="transform scale-95 opacity-0"
          >
            <div
              class="absolute right-0 z-10 w-full mt-2 origin-top-right bg-card rounded-md shadow-lg focus:outline-none"
              role="menu"
              aria-orientation="vertical"
              aria-labelledby="menu-button"
              tabindex="-1"
              v-show="showDocumentDropdown"
            >
              <ul class="py-1" role="none">
                <li
                  v-for="(document, documentsIndex) in documents"
                  :key="documentsIndex"
                  class="pt-1.5 pb-0.5 hover:bg-muted"
                >
                  <button
                    type="button"
                    class="w-full h-6 px-3 text-sm font-medium text-left"
                    @click=";(selectedDocument = document), closeDropdown()"
                  >
                    {{ document }}
                  </button>
                </li>
              </ul>
            </div>
          </transition>
        </div>
      </div>
      <div v-show="documentTypes.length > 0">
        <span class="block mb-3 text-sm font-medium">Type</span>
        <ul>
          <li
            v-for="(document, documentsIndex) in documentTypes"
            :key="documentsIndex"
            @click="selectedDocumentType = document"
            class="min-h-12 flex font-medium mb-2 px-6 py-2.5 rounded-lg cursor-pointer"
            :class="
              selectedDocumentType === document
                ? 'text-primary bg-primary/10'
                : 'text-foreground bg-muted/50 hover:bg-muted'
            "
          >
            <span class="inline-block my-auto leading-5">{{ document }}</span>
          </li>
        </ul>
      </div>
    </aside>
    <div class="flex-1 p-6 bg-card lg:p-12">
      <LetterOfIntent
        v-if="showLetterOfIntent"
        :constants="constants"
        :divisions="divisions"
        :rate-units="rateUnits"
        :genders="genders"
        :nationalities="nationalities"
        :civil-statuses="civilStatuses"
        :leasing-periods="leasingPeriods"
      />
      <ResidentialViewingList v-else-if="showResidentialViewingList" />
      <ResidentialContractOfLease
        v-else-if="showResidentialContractOfLease"
        :rate-units="rateUnits"
        :nationalities="nationalities"
        :genders="genders"
        :civil-statuses="civilStatuses"
      />
      <DeedOfAbsoluteSale
        v-else-if="showDeedOfAbsoluteSale"
        :constants="constants"
        :nationalities="nationalities"
        :genders="genders"
        :civil-statuses="civilStatuses"
      />
      <ContractToSell
        v-else-if="showContractOfSell"
        :constants="constants"
        :nationalities="nationalities"
        :genders="genders"
        :civil-statuses="civilStatuses"
        :payment-terms="paymentTerms"
      />
      <CommercialContractOfLease
        v-else-if="showCommercialContractOfLease"
        :rate-units="rateUnits"
        :nationalities="nationalities"
        :genders="genders"
      />
      <AuthorityToSell
        v-else-if="showAuthorityToSell"
        :nationalities="nationalities"
      />
      <PropertyManagement
        v-else-if="showPropertyManagement"
        :nationalities="nationalities"
      />
      <div v-else class="flex h-full">
        <div class="m-auto">
          <DocumentChecklist class="mx-auto mb-3" />
          <span class="block mx-auto font-bold text-center text-foreground"
            >No document selected</span
          >
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import AuthorityToSell from '~/components/pages/documents/AuthorityToSell'
import CommercialContractOfLease from '~/components/pages/documents/CommercialContractOfLease'
import ContractToSell from '~/components/pages/documents/ContractToSell'
import DeedOfAbsoluteSale from '~/components/pages/documents/DeedOfAbsoluteSale'
import DocumentChecklist from '~/components/svg/DocumentChecklist'
import Dropdown from '~/components/Dropdown'
import LetterOfIntent from '~/components/pages/documents/LetterOfIntent'
import MenuDown from 'vue-material-design-icons/MenuDown.vue'
import MenuUp from 'vue-material-design-icons/MenuUp.vue'
import PropertyManagement from '~/components/pages/documents/PropertyManagement'
import ResidentialContractOfLease from '~/components/pages/documents/ResidentialContractOfLease'
import ResidentialViewingList from '~/components/pages/documents/ResidentialViewingList'
import { apiRoutes } from '~/contants'

const documents = [
  'Residential Viewing List',
  'Letter of Intent',
  'Residential Contracts',
  'Commercial Contracts',
]

const residentialContracts = [
  'Contract of Lease',
  'Deed of Absolute Sale',
  'Contract to Sell',
  'Authority to Sell',
  'Property Management',
]
const commercialContracts = ['Contract of Lease']

export default {
  components: {
    AuthorityToSell,
    CommercialContractOfLease,
    ContractToSell,
    DeedOfAbsoluteSale,
    DocumentChecklist,
    Dropdown,
    LetterOfIntent,
    MenuDown,
    MenuUp,
    PropertyManagement,
    ResidentialContractOfLease,
    ResidentialViewingList,
  },
  data() {
    return {
      civilStatuses: [],
      constants: {},
      divisions: [],
      documents,
      genders: [],
      leasingPeriods: [],
      nationalities: [],
      paymentTerms: [],
      rateUnits: [],
      selectedDocument: documents[0],
      selectedDocumentType: residentialContracts[0],
      showDocumentDropdown: false,
    }
  },
  computed: {
    documentTypes() {
      if (this.selectedDocument === 'Residential Contracts') {
        return residentialContracts
      }
      if (this.selectedDocument === 'Commercial Contracts') {
        return commercialContracts
      }
      return []
    },
    showResidentialViewingList() {
      return this.selectedDocument === 'Residential Viewing List'
    },
    showLetterOfIntent() {
      return this.selectedDocument === 'Letter of Intent'
    },
    showResidentialContractOfLease() {
      return (
        this.selectedDocument === 'Residential Contracts' &&
        this.selectedDocumentType === 'Contract of Lease'
      )
    },
    showDeedOfAbsoluteSale() {
      return (
        this.selectedDocument === 'Residential Contracts' &&
        this.selectedDocumentType === 'Deed of Absolute Sale'
      )
    },
    showContractOfSell() {
      return (
        this.selectedDocument === 'Residential Contracts' &&
        this.selectedDocumentType === 'Contract to Sell'
      )
    },
    showAuthorityToSell() {
      return (
        this.selectedDocument === 'Residential Contracts' &&
        this.selectedDocumentType === 'Authority to Sell'
      )
    },
    showPropertyManagement() {
      return (
        this.selectedDocument === 'Residential Contracts' &&
        this.selectedDocumentType === 'Property Management'
      )
    },
    showCommercialContractOfLease() {
      return (
        this.selectedDocument === 'Commercial Contracts' &&
        this.selectedDocumentType === 'Contract of Lease'
      )
    },
  },
  watch: {
    selectedDocument() {
      this.selectedDocumentType = null
    },
  },
  mounted() {
    $fetch(apiRoutes['documents.selections']).then((data) => {
      Object.keys(data).forEach((key) => {
        this[key] = data[key]
      })
    })
  },
  methods: {
    closeDropdown() {
      this.showDocumentDropdown = false
    },
  },
}
</script>
