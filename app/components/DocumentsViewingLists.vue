<template>
  <div class="flex flex-col h-full gap-4 pt-4 lg:flex-row">
    <aside
      class="flex flex-col w-full px-6 py-8 bg-card generator-aside lg:w-[30vw] rounded-xl"
    >
      <h3 class="mb-4 text-2xl font-black">Document Viewing Lists</h3>
      <!-- Search Input -->
      <div class="relative flex items-center">
        <input
          v-model="searchQuery"
          type="text"
          placeholder="Search"
          class="w-full pl-8 rounded-xl border-1 border-border h-10 lg:h-[2vw]"
          @input="filterDocuments"
        />
        <font-awesome-icon
          icon="magnifying-glass"
          class="absolute left-2 text-muted-foreground"
        />
      </div>
      <div>
        <span v-if="filteredDocuments.length === 0"
          >No viewing lists found</span
        >
        <span v-else> {{ filteredDocuments.length }} viewing lists found </span>
      </div>
      <div
        v-if="filteredDocuments.length"
        class="flex flex-col gap-2 overflow-x-hidden overflow-hidden max-h-[62vh] px-2"
      >
        <div
          @click="handleDocumentClick(document)"
          class="w-full bg-primary/15 p-4 rounded-xl font-bold cursor-pointer hover:scale-105 transition-all duration-300 text-sm"
          v-for="document in filteredDocuments"
          :key="document.id || document.key"
        >
          <span>{{ document.key }}</span>
        </div>
      </div>
    </aside>
    <div v-if="selectedDocument" class="w-full bg-card rounded-xl">
      <!-- Document Preview -->
      <!-- PDF Viewer -->
      <div class="max-h-[40vw] overflow-y-hidden">
        <div class="border-b-1 flex justify-between">
          <h1 class="text-2xl font-bold ml-6 mt-4">Document Preview</h1>
          <div class="flex justify-center gap-4 mt-4 mb-4">
            <button
              @click="downloadPdf()"
              class="bg-primary text-white px-4 py-2 rounded-md"
            >
              Download PDF
            </button>
            <button
              @click="downloadDocx()"
              class="bg-success text-success-foreground px-4 py-2 rounded-md h-[50px] transition-colors duration-150 ease-out hover:bg-success/90 focus-ring"
            >
              Download Docx
            </button>
            <button
              @click="deletePdf()"
              class="bg-destructive text-white px-4 py-2 rounded-md"
            >
              Delete
            </button>
          </div>
        </div>
        <div>
          <!-- PDF Document -->
          <VuePdfEmbed
            ref="pdfRef"
            v-if="!isLoading && selectedDocument"
            @loaded="
              () => {
                isLoading = false
                console.log('isLoading: ', isLoading)
              }
            "
            :source="selectedDocument ? selectedDocument.src : ''"
          />
          <div v-if="isLoading && !selectedDocument">
            <div class="flex justify-center m-4 h-full">
              <div
                class="animate-spin rounded-full h-12 border-t-2 border-b-2 border-border"
              ></div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div v-else class="flex justify-center items-center w-full h-[30vw]">
      <div class="m-auto w-full">
        <DocumentChecklist class="mx-auto mb-3" />
        <span class="block text-foreground font-bold mx-auto text-center"
          >No document selected</span
        >
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, onMounted } from 'vue'
import VuePdfEmbed from 'vue-pdf-embed'
import { getViewingListsCall, removeDocumentByIdCall } from '~/services/document.services'
import Swal from 'sweetalert2'
import { showToast, showLoading, dismissLoading } from '~/helpers/helpers'

const isLoading = ref(false)
const availableDocuments = ref<any[]>([])
const selectedDocument = ref<any>(null)
const searchQuery = ref('')
const filteredDocuments = ref<any[]>([])

const filterDocuments = () => {
  if (!searchQuery.value.trim()) {
    filteredDocuments.value = availableDocuments.value
    return
  }

  const query = searchQuery.value.toLowerCase().trim()
  filteredDocuments.value = availableDocuments.value.filter((doc) =>
    doc.key.toLowerCase().includes(query)
  )
}

const fetchAvailableDocuments = async () => {
  const documents = await getViewingListsCall()
  const updatedDocuments = (documents || [])
    .filter((document: any) => document.documentName?.includes('.pdf'))
    .map((document: any) => ({
      key: document.documentName.replace('.pdf', ''),
      value: document.documentUrl,
      id: document.id,
    }))

  console.log('updatedDocuments: ', updatedDocuments)
  availableDocuments.value = updatedDocuments
  filteredDocuments.value = updatedDocuments // Initialize filtered documents
}

async function handleDocumentClick(document: any) {
  showLoading()
  selectedDocument.value = null
  console.log('document: ', document)

  //donwload image from url
  const documentObject = await fetch(document.value)

  console.log('documentObject: ', documentObject)
  //convert documentObject to UInt8Array
  const uint8Array = new Uint8Array(await documentObject.arrayBuffer())

  selectedDocument.value = {
    src: uint8Array,
    name: document.key,
    url: document.value,
    id: document.id,
  }
  console.log('selectedDocument: ', selectedDocument.value)
  dismissLoading()
}

async function downloadDocx() {
  let documentName = selectedDocument.value.name
  documentName = documentName.replace('.pdf', '.docx').replace('.docx', '')

  // Server scopes to the authenticated user; client-supplied user_id
  // is ignored (IDOR fix 2026-05-08).
  const response = await fetch(
    `api/documents/download-docx?documentName=${encodeURIComponent(documentName)}`,
  )

  const document = await response.json()

  const link = window.document.createElement('a')
  link.href = document.documentUrl
  link.download = `${documentName}.docx`
  link.click()
}

async function downloadPdf() {
  showLoading()
  const documentObject = await fetch(selectedDocument.value.url)
  const documentBlob = await documentObject.blob()

  const zipUrl = URL.createObjectURL(documentBlob)
  const link = document.createElement('a')
  link.href = zipUrl
  link.download = `${selectedDocument.value.name}.pdf`
  link.click()
  dismissLoading()
}

async function deletePdf() {
  console.log('deletePdf')
  Swal.fire({
    title: 'Delete Document',
    html: `Are you sure you want to delete <b>${selectedDocument.value.name}</b>?`,
    confirmButtonColor: '#E73F31',
    confirmButtonText: 'Confirm',
    showCancelButton: true,
  }).then(async (result) => {
    if (result.isConfirmed && selectedDocument.value?.id) {
      await removeDocumentByIdCall(selectedDocument.value.id)
      showToast({
        title: 'Document deleted successfully',
        icon: 'success',
      })
      selectedDocument.value = null
      await fetchAvailableDocuments()
    }
  })
}

onMounted(() => {
  fetchAvailableDocuments()
})
</script>

<style scoped></style>
