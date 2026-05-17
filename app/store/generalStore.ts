import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useContactListingDetailsStore = defineStore('contactListingDetails', () => {
  const contactDetailsSidebarOpen = ref(false)
  
  function toggleContactDetailsSidebar() {
    contactDetailsSidebarOpen.value = !contactDetailsSidebarOpen.value
  }

  return {
    contactDetailsSidebarOpen,
    toggleContactDetailsSidebar
  }
})

export const useContactFormStore = defineStore('contactForm', () => {
  const contactFormOpen = ref(true)

  function toggleContactForm() {
    contactFormOpen.value = !contactFormOpen.value
  }

  return {
    contactFormOpen,
    toggleContactForm
  }
})

export const useGeneralStore = defineStore('general', () => {
  const listingShowingType = ref('personal')

  return {
    listingShowingType
  }
})