<template>
  <div
    v-if="props.selectedContact"
    class="flex flex-col gap-4 overflow-y-auto max-h-[42vw]"
  >
    <!-- Sidebar Header -->
    <div
      class="flex justify-between items-center border-b border-border pb-2 my-2"
    >
      <span class="text-[1.2em] text-foreground font-bold">Contact Details</span>
      <div
        class="cursor-pointer group flex items-center justify-center bg-muted rounded-full p-2 h-[2vw] w-[2vw] hover:bg-primary/10 mr-2"
        @click="emit('toggleSidebar')"
      >
        <font-awesome-icon
          icon="close"
          class="text-gray-350 group-hover:text-primary"
          :class="{
            'text-primary':
              contactListingDetailsStore.contactDetailsSidebarOpen,
          }"
          size="lg"
        />
      </div>
    </div>
    <!-- Image, id, name, status -->
    <div class="flex flex-col relative">
      <!-- profile picture -->
      <div
        class="w-full mt-2 flex justify-center items-center h-[10vw] relative"
      >
        <div
          class="absolute w-full h-1/2 bg-muted rounded-xl z-[-1] top-0"
        ></div>
        <img
          :src="
            props.selectedContact.avatar
              ? props.selectedContact.avatar
              : '/img/hi_logo.svg'
          "
          class="max-w-[8vw] rounded-full"
        />
      </div>
      <div class="relative" v-if="editButtonEnabled || deleteButtonEnabled">
        <div
          class="absolute right-0 top-[50%] cursor-pointer group flex items-center justify-center bg-muted rounded-full p-2 h-[2vw] w-[2vw] hover:bg-primary/10 mr-2"
          :class="{ 'bg-primary/10': optionsMenuOpen }"
          @click="toggleOptionsMenu"
        >
          <font-awesome-icon
            :icon="faEllipsisVertical"
            class="text-gray-350 group-hover:text-primary"
            :class="{ 'text-primary': optionsMenuOpen }"
            size="lg"
          />
        </div>
        <!-- options menu -->
        <div
          id="options-menu"
          class="absolute right-[2vw] top-[2vw] w-[5vw] bg-card rounded-md shadow-md p-2"
          :class="{ hidden: !optionsMenuOpen }"
        >
          <div class="flex flex-col gap-2">
            <span
              v-if="editButtonEnabled"
              @click="editContactFunction(props.selectedContact.id)"
              class="text-black text-[.9em] cursor-pointer hover:text-primary"
              >Edit</span
            >
            <span
              v-if="deleteButtonEnabled"
              @click="deleteContactFunction(props.selectedContact.id)"
              class="text-black text-[.9em] cursor-pointer hover:text-primary"
              >Delete</span
            >
          </div>
        </div>
      </div>
      <div
        class="text-muted-foreground/70 text-md flex flex-col items-center justify-center gap-2"
      >
        <span class="text-foreground font-bold text-lg">{{
          contactDetails.name
        }}</span>
        <div class="flex items-center gap-2">
          <div class="text-md text-black">
            ID {{ contactDetails.id ? contactDetails.id : 'N/A' }}
          </div>
          <div class="bg-success w-4 h-4 rounded-md"></div>
        </div>
      </div>
    </div>
    <!-- Contact Details -->
    <div
      v-if="contactDetails.details.length > 0"
      v-for="detail in contactDetails.details"
      class="w-full flex flex-col gap-2"
    >
      <div
        class="w-full flex flex-col justify-center gap-2 bg-muted h-[3vw] rounded-xl"
      >
        <span class="ml-2 font-bold text-lg">{{ detail.label }}</span>
      </div>
      <span class="h-[3vw] flex items-center">{{ detail.value }}</span>
    </div>
  </div>
  <div
    v-else
    class="flex flex-col gap-4 overflow-y-auto max-h-[42vw] items-center justify-center"
  >
    <span class="text-muted-foreground/70">No contact selected</span>
  </div>
</template>

<script lang="ts" setup>
import { library } from '@fortawesome/fontawesome-svg-core'
import { faEllipsisVertical } from '@fortawesome/free-solid-svg-icons'
import Swal from 'sweetalert2'
import {
  deleteContact as deleteContactService,
  editContact as editContactService,
} from '@/services/contact.services'
import { dismissLoading, showLoading, showToast } from '@/helpers/helpers'
import { can } from '~/composables/useAuth'
library.add(faEllipsisVertical)

import { useContactListingDetailsStore } from '@/store/generalStore'

const contactListingDetailsStore = useContactListingDetailsStore()

const props = defineProps(['selectedContact'])

const emit = defineEmits(['toggleSidebar', 'openEditContact'])
const optionsMenuOpen = ref(false)

const toggleOptionsMenu = () => {
  optionsMenuOpen.value = !optionsMenuOpen.value
}

const editContactFunction = async (contact: any) => {
  console.log('editContact: ', contact)
  emit('openEditContact', props.selectedContact)
}

const deleteContactFunction = async (id: number) => {
  console.log('deleteContact: ', id)

  Swal.fire({
    title: 'Delete Contact',
    html: `Are you sure you want to delete <b>${props.selectedContact.contact_name}</b>?`,
    confirmButtonColor: '#E73F31',
    confirmButtonText: 'Confirm',
    showCancelButton: true,
  }).then(async (result) => {
    if (result.isConfirmed) {
      showLoading()
      await deleteContactService(id)
      showToast({
        title: 'Contact deleted successfully',
        icon: 'success',
      })
      dismissLoading()

      window.location.reload()
    }
  })
}

// "view_all_contacts" implies the user is admin (sees others' contacts);
// in that case we further gate edit / delete on the matching action.
// Non-admins only see their own contacts (RLS), so they can always edit /
// delete what they see.
const editButtonEnabled = computed(() => {
  if (can('view_all_contacts')) return can('edit_any_contact')
  return true
})

const deleteButtonEnabled = computed(() => {
  if (can('view_all_contacts')) return can('delete_any_contact')
  return true
})

const contactDetails = computed(() => {
  if (!props.selectedContact) {
    return {
      name: '',
      id: '',
      status: '',
      details: [],
    }
  }

  return {
    name: props.selectedContact.contact_name,
    id: props.selectedContact.id,
    status: props.selectedContact.status,
    details: [
      {
        label: 'Email',
        value: props.selectedContact.email,
      },
      {
        label: 'Designation',
        value: props.selectedContact.designation,
      },
      {
        label: 'Landline',
        value: props.selectedContact.landline,
      },
      {
        label: 'Mobile',
        value: props.selectedContact.mobile,
      },
      {
        label: 'Note',
        value: props.selectedContact.notes,
      },
    ],
  }
})
// const contactDetails = {
//   name: 'Graham Weavershield',
//   id: '1234567890',
//   status: 'Active',
//   details: [
//     {
//       label: 'Email',
//       value: 'Graham.Weavershield@company.com',
//     },
//     {
//       label: 'Designation',
//       value: 'Broker',
//     },
//     {
//       label: 'Landline',
//       value: '-',
//     },
//     {
//       label: 'Mobile',
//       value: '09307317413',
//     },
//   ],
// }
</script>

<style></style>
