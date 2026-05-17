<template>
  <div class="flex flex-col h-full gap-4 pt-4 lg:flex-row">
    <aside
      class="flex flex-col w-full px-6 py-8 bg-card generator-aside lg:w-[30vw] h-auto rounded-xl"
    >
      <h3 class="mb-4 text-2xl font-black">Document Checklist</h3>
      <span
        >Residential Contracts Lorem ipsum description, introduction lorem ipsum
        dolor addendum contracts, Residential Contracts
      </span>
      <!-- Search Input -->
      <div class="relative flex items-center">
        <input
          v-model="searchQuery"
          type="text"
          placeholder="Search"
          class="w-full pl-8 rounded-xl border-1 border-border lg:h-10 lg:my-5"
          @input="filterDocuments"
        />
        <font-awesome-icon
          icon="magnifying-glass"
          class="absolute left-2 text-muted-foreground"
        />
      </div>
      <div>
        <span v-if="filteredDocuments.length === 0">No documents found</span>
        <span v-else> {{ filteredDocuments.length }} documents found </span>
      </div>
      <div
        v-if="filteredDocuments.length"
        class="flex flex-col gap-2 overflow-x-hidden overflow-y-auto max-h-[500px] px-2"
      >
        <div
          @click="handleDocumentClick(document)"
          class="w-full bg-primary/15 p-4 rounded-xl font-bold cursor-pointer hover:scale-105 transition-all duration-300"
          v-for="document in filteredDocuments"
          :key="document.key"
        >
          <span>{{ document.key.split('/').pop() }}</span>
        </div>
      </div>
    </aside>
    <div v-if="selectedDocument" class="w-full bg-card rounded-xl">
      <!-- Document Preview -->
      <!-- PDF Viewer -->
      <div class=" lg:max-h-[40vw] overflow-y-hidden mb-5 sm:mb-0">
        <div class="border-b-1 flex justify-between">
          <h1 class="text-2xl font-bold ml-6 mt-4">Document Preview</h1>
        </div>
        <div class="overflow-y-auto lg:max-h-[35vw]">
          <!-- PDF Document -->
          <img :src="selectedDocument ? selectedDocument.url : ''" />
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
        <span class="block text-foreground font-bold mx-auto text-center"
          >No document selected</span
        >
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, onMounted } from 'vue'
import Swal from 'sweetalert2'
import { showToast, showLoading, dismissLoading } from '~/helpers/helpers'

const isLoading = ref(false)
const availableDocuments = ref<any[]>([])
const selectedDocument = ref<any>(null)
const searchQuery = ref('')
const filteredDocuments = ref<any[]>([])

function getDocumentsImages() {
  if (import.meta.client) {
    // We need to provide static glob patterns
    if (window.location.origin.includes('localhost')) {
      return import.meta.glob([
        '/public/img/documents/*.png',
        '/public/img/documents/*.jpg',
        '/public/img/documents/*.jpeg',
      ])
    } else {
      return import.meta.glob([
        '/img/documents/*.png',
        '/img/documents/*.jpg',
        '/img/documents/*.jpeg',
      ])
    }
  }
  return {}
}

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
  const documents = await getDocumentsImages()
  console.log('documents: ', documents)

  const updatedDocuments = Object.values(documents).map((document: any) => {
    return {
      key: document.name,
      value: document,
    }
  })

  console.log('updatedDocuments: ', updatedDocuments)
  availableDocuments.value = updatedDocuments
  filteredDocuments.value = updatedDocuments // Initialize filtered documents
}

async function handleDocumentClick(doc: any) {
  showLoading()
  selectedDocument.value = null
  console.log('document: ', doc)

  //donwload image from url
  const documentObject = await fetch(doc.value)

  //get current page url origin
  const urlOrigin = window.location.origin

  console.log('documentObject: ', documentObject)

  selectedDocument.value = {
    key: doc.key,
    url: `${urlOrigin}/${doc.key}`,
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

async function removeDocumentCall(documentName: string) {
  try {
    const response = await fetch(
      `/api/documents/delete?documentName=${documentName}`,
      {
        method: 'DELETE',
      }
    )
    if (!response.ok) {
      throw new Error('Failed to delete document')
    }
    return await response.json()
  } catch (error) {
    console.error('Error deleting document:', error)
    throw error
  }
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
    if (result.isConfirmed) {
      await removeDocumentCall(selectedDocument.value.name)
      showToast({
        title: 'Document deleted successfully',
        icon: 'success',
      })
    }
  })
}

onMounted(() => {
  fetchAvailableDocuments()
})
</script>

<style scoped></style>
