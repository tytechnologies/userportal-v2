<template>
  <section class="flex flex-col h-full max-h-[70vh]">
    <h3 class="mb-4 text-2xl font-black">Residential Viewing List</h3>
    <div class="col-span-2">
      <div class="flex flex-col lg:flex-row gap-2 items-stretch lg:items-end">
        <Input
          id="client_name"
          type="text"
          :model-value="form.client_name"
          @input="
            (event) => {
              form.client_name = event.target.value
              checkForExistingViewingList()
            }
          "
          class="flex-1"
          placeholder="Client Name"
        >
          Client Name
        </Input>
        <div class="w-full lg:w-[8vw]">
          <label
            for="viewing_date"
            class="mb-2 text-sm font-bold text-foreground"
          >
            Date
          </label>
          <input
            id="viewing_date"
            v-model="form.viewing_date"
            type="date"
            class="flex-1 w-full h-10 leading-9 block pl-2 border bg-muted/50 border-border focus:bg-transparent rounded-lg text-sm w-full font-bold placeholder-gray-3 text-foreground border border-solid focus-within:border-blue disabled:bg-muted/500"
          />
        </div>
        <div class="w-full lg:w-[5vw]">
          <label
            for="viewing_time"
            class="mb-2 text-sm font-bold text-foreground"
          >
            Time
          </label>
          <input
            id="viewing_time"
            v-model="form.viewing_time"
            type="time"
            class="flex-1 w-full h-10 leading-9 block pl-2 border bg-muted/50 border-border focus:bg-transparent rounded-lg text-sm w-full font-bold placeholder-gray-3 text-foreground border border-solid focus-within:border-blue disabled:bg-muted/500"
          />
        </div>
      </div>
    </div>
    <div class="flex no-wrap w-full gap-2 mt-4" v-if="form.client_name">
      <span v-if="!existingViewingListRef">
        No existing viewing list found. Check your string client name if this is
        not expected.
      </span>
      <div
        class="animate-spin rounded-full h-[20px] w-[20px] border-t-2 border-b-2 border-border"
        v-if="searchingForViewingList"
      ></div>
      <span v-if="existingViewingListRef">
        <a
          class="text-primary hover:text-primary hover:underline"
          :href="existingViewingListRef.url"
          target="_blank"
        >
          <span
            >View existing viewing list: {{ existingViewingListRef.name }}</span
          >
        </a>
      </span>
    </div>
    <div class="flex gap-2 justify-between items-center my-2">
      <div class="text-lg font-bold w-full my-4 px-2">Properties</div>
      <div class="flex gap-2">
      <button
        v-if="tempProperties.length"
        type="button"
        class="text-white bg-muted/500 rounded-lg w-[10vw] h-[40px]"
        @click="resetProperties"
      >
        Reset
      </button>
      <button
        type="button"
        class="text-white bg-primary rounded-lg w-32 lg:w-[10vw] h-[40px]"
        @click="addProperty"
      >
        Add Property
      </button>
      </div>
    </div>
    <div class="grid grid-cols-2 gap-4 overflow-hidden">
      <div
        id="properties-container"
        class="overflow-y-auto h-[40vh] col-span-2 px-4 border-t border-border pt-5"
      >
        <div
          class="mb-4 items-center col-span-2"
          v-for="(property, index) in tempProperties"
          :key="property.id"
        >
          <div class="flex gap-2 items-end">
            <div class="max-w-[3vw]">
              <Input readonly type="text" :model-value="index + 1">No.</Input>
            </div>
            <VSelect
              :model-value="property.selectedProperty"
              :options="availableProperties"
              @onChange="
                (value) => {
                  aggregateProperty(value, property.id)
                  const row = tempProperties.value.find((p) => p.id === property.id)
                  if (row) row.selectedProperty = value
                }
              "
              :otherSelectOpened="activeDropdown !== property.id"
              @openSelectEvent="handleDropdownOpen(property.id)"
            >
              Property Title
            </VSelect>
            <!-- <VSelect
              id="property_id"
              v-model="property.selectedProperty"
              @search="onFetchProperties"
              :clearable="false"
              :filterable="false"
              placeholder="Select property"
              @option:selected="
                (selected) => aggregateProperty(selected, property.id)
              "
              :options="availableProperties"
              :get-option-label="
                (option) => `${option.listing_id} - ${option.title}`
              "
              :reduce="
                (item) => {
                  return {
                    id: property.id,
                    listing_id: item.listing_id,
                    title: item.title,
                    condition: item.condition,
                    address: item.address,
                    city_name: item.city_name,
                    floor_area: item.floor_area,
                    bedrooms: item.bedrooms,
                    bathrooms: item.bathrooms,
                    rent_price: item.rent_price,
                    sale_price: item.sale_price,
                    parking_spaces: item.parking_spaces,
                  }
                }
              "
              >Property Title</VSelect
            > -->
            <button
              type="button"
              class="px-4 py-2 text-white bg-destructive h-[40px] rounded-lg"
              @click="removeProperty(property.id)"
            >
              Remove
            </button>
          </div>
        </div>
      </div>
    </div>
    <div class="flex mt-auto">
      <button
        type="button"
        class="ml-auto rounded-lg w-39 h-9 bg-green"
        @click="generateViewingList"
      >
        <span class="inline-block text-white font-bold mt-0.5">Generate</span>
      </button>
    </div>
  </section>
</template>

<script setup>
import Input from '~/components/Input.vue'
import VSelect from '~/components/NewVSelect.vue'
import { showLoading, dismissLoading, showToast } from '~/helpers/helpers'
import { generateResidentialViewingListCall } from '~/services/document.services'
import { v4 as uuidv4 } from 'uuid'
import { searchViewingLists } from '~/services/documents/viewingListsUploadAndFind'
const availableProperties = ref([])
const selectedProperty = ref(null)
const otherSelectWasOpened = ref(false)

const tempProperties = ref([])
const form = reactive({
  properties: [],
  client_name: '',
  viewing_date: '',
  viewing_time: '',
  broker_name: '',
})

const activeDropdown = ref(null)
const existingViewingListRef = ref(null)
const searchingForViewingList = ref(false)

async function checkForExistingViewingList() {
  existingViewingListRef.value = null
  const existingViewingList = await searchViewingLists(form.client_name)
  console.log('viewing list here: ', existingViewingList)
  if (existingViewingList.length) {
    console.log('Existing viewing list found')
    existingViewingListRef.value = existingViewingList[0]
    console.log('Existing viewing list: ', existingViewingListRef.value)
  } else {
    console.log('No existing viewing list found')
    existingViewingListRef.value = null
    console.log('Non-Existing viewing list: ', existingViewingListRef.value)
  }
}

function handleDropdownOpen(dropdownId) {
  activeDropdown.value = dropdownId
}

const aggregateProperty = (selected, propertyId) => {
  if (!selected) return
  const obj = { ...selected, id: propertyId }
  const existingIndex = form.properties.findIndex((p) => p.id === propertyId)
  if (existingIndex >= 0) {
    form.properties[existingIndex] = obj
  } else {
    form.properties.push(obj)
  }
}

const addProperty = () => {
  const newId = uuidv4()
  tempProperties.value.push({
    id: newId,
    selectedProperty: null,
  })

  // After adding the property, scroll to bottom
  nextTick(() => {
    const container = document.querySelector('#properties-container')
    if (container) {
      container.scrollTop = container.scrollHeight
    }
  })
}

const resetProperties = () => {
  tempProperties.value = []
  form.properties = []
}

const removeProperty = (propertyId) => {
  const index = tempProperties.value.findIndex((p) => p.id === propertyId)
  if (index > -1) {
    tempProperties.value.splice(index, 1)
    form.properties = form.properties.filter((p) => p.id !== propertyId)
  }
}

const fetchViewingList = async () => {
  const user = useSupabaseUser()

  // Reads from `listing_details` (canonical wide read source — exposes
  // city_name via the join, plus all listing-shape columns).
  const { data: listingDetails, error: listingDetailsError } =
    await useSupabaseClient()
      .from('listing_details')
      .select(
        'listing_id, title, condition, street_address, city_name, floor_area, bedrooms, bathrooms, rent_price, sale_price, parking_spaces'
      )
      .order('updated_at', { ascending: false })

  if (listingDetailsError) {
    console.error('Error fetching listing details:', listingDetailsError)
    return
  }

  // Null-safe — `data` is null on RLS / 4xx failures.
  const list = Array.isArray(listingDetails) ? listingDetails : []
  console.log('listingDetails: ', list)

  availableProperties.value = list.map((listing) => ({
    listing_id: listing.listing_id,
    value: listing.listing_id,
    label: `ID ${listing.listing_id} - ${listing.title}`,
    condition: listing.condition,
    address: listing.street_address,
    city_name: listing.city_name,
    floor_area: listing.floor_area,
    bedrooms: listing.bedrooms,
    bathrooms: listing.bathrooms,
    rent_price: listing.rent_price,
    sale_price: listing.sale_price,
    parking_spaces: listing.parking_spaces,
  }))
}

onMounted(async () => {
  const $ssupabase_user = useSupabaseUser()
  // form.broker_name = $ssupabase_user.value.user_metadata.full_name
  form.broker_name = 'Test test'

  await fetchViewingList()
})

watch(form.properties, (newVal) => {
  console.log('newVal: ', newVal)
})

async function generateViewingList() {
  if (!form.client_name?.trim()) {
    showToast({ title: 'Please enter client name', icon: 'error' })
    return
  }
  const propertiesToGenerate = form.properties.filter((p) => p?.listing_id != null)
  if (!propertiesToGenerate.length) {
    showToast({ title: 'Please add and select at least one property', icon: 'error' })
    return
  }
  showLoading()
  try {
    const payload = {
      ...form,
      properties: propertiesToGenerate,
    }
    const document = await generateResidentialViewingListCall(payload)
    if (document) {
      showToast({
        title: 'Residential Viewing List generated successfully',
        icon: 'success',
      })
    }
  } catch (err) {
    console.error('Residential viewing list generation failed:', err)
    showToast({
      title: err?.message || 'Failed to generate viewing list',
      icon: 'error',
    })
  } finally {
    dismissLoading()
  }
}
</script>
