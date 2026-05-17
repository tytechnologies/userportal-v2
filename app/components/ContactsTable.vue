<style scoped>
.header-listing {
  width: 20vw;
}
</style>
<template>
  <div>
    <!-- Table -->
    <div class="overflow-x-auto">
      <div class="inline-block min-w-full overflow-x-auto">
        <div class="max-h-[calc(100vh-20rem)] h-[calc(100vh-20rem)] overflow-y-auto">
          <table class="w-full leading-normal table-auto" id="listingTable">
            <thead class="sticky top-0 z-[1] bg-card shadow-sm">
              <tr>
                <th v-for="(item, index) in visibleColumns" :key="index"
                  class="px-2 py-3 text-sm font-semibold leading-6 tracking-wider text-left bg-card border-b-2 border-border text-foreground min-w-[10vw] px-2"
                  :class="getClass(item) + ' header-' + index">
                  <div
                    class="flex items-center justify-between gap-2 flex-nowrap p-1 rounded-full px-2 border-1 border-border rounded-full">
                    <span class="inline-flex items-center">{{ item }}</span>
                  </div>
                </th>
              </tr>
            </thead>
            <tbody class="text-sm w-full bg-card">
              <!-- Loader -->
              <tr v-if="isLoading">
                <td :colspan="visibleColumns.length" class="text-center h-[19vw]">
                  <div
                    class="animate-spin rounded-full h-[8rem] w-[8rem] border-t-2 border-b-2 border-border mx-auto">
                  </div>
                </td>
              </tr>
              <tr v-else v-for="(columnData, index) in props.displayedContactsData" :key="index"
                class="bg-card my-4 hover:bg-accent hover:text-accent-foreground transition-colors duration-200">
                <td class="p-2 rounded-l-2xl border-solid border-border border-b-6 border-t-6">
                  <ContactRowInfoCard v-if="columnData" :index="index" :contact_data="{
                    contact_id: columnData?.id,
                    contact_name: columnData?.contact_name,
                    email: columnData?.email,
                    designation: columnData?.designation,
                    landline: columnData?.landline,
                    mobile: columnData?.mobile,
                    avatar: columnData?.avatar,
                  }" :showOnlineStatus="true" @showListingDetails="
                      () => {
                        console.log('columnData: ', columnData)
                        console.log('columnData avatar: ', columnData?.avatar)
                        emit('handleContactSelection', columnData)
                      }
                    " />
                </td>
                <!-- Email -->
                <td class="py-2 pl-2 border-solid border-border border-b-6 border-t-6 sm:table-cell">
                  <div v-if="columnData?.email"
                    class="flex items-center pr-2 h-full whitespace-no-wrap border-r-1 min-w-[11vw]">
                    <p class="cursor-pointer whitespace-no-wrap text-foreground">
                      <span class="block">
                        {{ columnData?.email }}
                      </span>
                    </p>
                  </div>
                </td>
                <!-- Designation -->
                <td class="py-2 pl-2 border-solid border-border border-b-6 border-t-6 sm:table-cell">
                  <div class="pr-2 whitespace-no-wrap border-r-1">
                    <p class="text-center cursor-pointer whitespace-no-wrap text-foreground">
                      <span class="block">
                        {{ columnData?.designation }}
                      </span>
                    </p>
                  </div>
                </td>
                <!-- Landline -->
                <td class="py-2 pl-2 border-solid border-border border-b-6 border-t-6 sm:table-cell">
                  <div class="pr-2 whitespace-no-wrap border-r-1">
                    <p class="text-center cursor-pointer whitespace-no-wrap text-foreground">
                      <span class="block">
                        {{ columnData?.landline }}
                      </span>
                    </p>
                  </div>
                </td>

                <!-- Mobile -->
                <td class="py-2 pl-2 border-solid border-border border-b-6 border-t-6 sm:table-cell">
                  <div class="pr-2 whitespace-no-wrap border-r-1">
                    <p class="text-center cursor-pointer whitespace-no-wrap text-foreground">
                      <span class="block">
                        {{ columnData?.mobile }}
                      </span>
                    </p>
                  </div>
                </td>
              </tr>
              <tr v-if="!props.displayedContactsData?.length && !isLoading">
                <td :colspan="visibleColumns.length">
                  <div class="w-full py-2 text-center">No data to display.</div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useListingColumnsAtom } from '~/store'
import { currencySuffix } from '~/helpers/helpers'

import { useContactListingDetailsStore } from '@/store/generalStore'

import { ref, computed } from 'vue'
import { library } from '@fortawesome/fontawesome-svg-core'
import {
  faArrowDownWideShort,
  faArrowUpWideShort,
  faSortDown,
  faSortUp,
} from '@fortawesome/free-solid-svg-icons'
import type { ListingColumnsSchema } from '~/types'
import type { InferType } from 'yup'

library.add(faArrowDownWideShort, faArrowUpWideShort, faSortUp, faSortDown)

const { listingColumnsData, listingColumnsArray } = useListingColumnsAtom()
type ListingColumnData = InferType<typeof ListingColumnsSchema>

const props = defineProps<{
  displayedContactsData: Array<{
    id: string
    contact_name: string
    email: string
    designation: string
    landline: string
    mobile: string
    avatar: string
  }>
  isLoading?: boolean
}>()

const emit = defineEmits(['handleContactSelection'])

const visibleColumns = ['Contact', 'Email', 'Designation', 'Landline', 'Mobile']

watch(props.displayedContactsData, (newVal) => {
  console.log('props.displayedContactsData newVal: ', newVal)
})

const getClass = (index: string) => {
  let classes = ''

  classes =
    index == 'name'
      ? 'rounded-r-2xl rounded-l-2xl sm:rounded-r-none md:rounded-r-none lg:rounded-r-none pl-6'
      : ''

  classes += index == 'notes' ? ' w-1/3' : ''

  let small = [
    'formatted_price',
    'amenities',
    'availability',
    'actions',
    'price',
    'user_name',
    'name',
    'designation',
    'email',
    'homephone',
  ]
  let responsive = [
    'city_name.keyword',
    'user_name',
    'uploader.name',
    'last_updated',
    'fblink',
    'area',
    'city',
  ]

  if (responsive.includes(index)) {
    classes += 'hidden sm:hidden md:hidden lg:table-cell'
  }

  if (small.includes(index)) {
    classes += 'hidden sm:table-cell md:table-cell lg:table-cell'
  }

  classes +=
    index == 'availability' ? ' sm:hidden md:table-cell lg:table-cell' : ''

  classes += index == 'actions' ? ' rounded-r-2xl pr-6' : ''

  return classes
}
</script>

<style scoped>
.material-design-icon svg {
  width: 17px;
  height: 17px;
}

.pagination-navs a:first-child {
  border-top-left-radius: 0.375rem;
  border-bottom-left-radius: 0.375rem;
}

.pagination-navs a:last-child {
  border-top-right-radius: 0.375rem;
  border-bottom-right-radius: 0.375rem;
}
</style>
