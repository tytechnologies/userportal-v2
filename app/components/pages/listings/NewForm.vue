<script setup>
import { ref, computed, watch } from 'vue'
import HelperText from '~/components/HelperText'
import Input from '~/components/Input.vue'
import vueFilePond from 'vue-filepond'
import 'filepond/dist/filepond.min.css'
import FormTooltip from '~/components/FormTooltip'
import InputMoney from '~/components/InputMoney.vue'
import {
  jsonToFormData,
  showSwal,
  showLoading,
  dismissLoading,
  showToast,
} from '~/helpers/helpers'
import { library } from '@fortawesome/fontawesome-svg-core'
import { faPlus, faEraser } from '@fortawesome/free-solid-svg-icons'
import { validateForm } from '~/utils/formValidation'
import ListingService from '~/services/listing.services'
import hiLogo from '/img/hi_logo.svg'
import { can } from '~/composables/useAuth'
// Removed: import type { City, Barangay } from '~/types'

const router = useRouter()
const typeOptions = ref([])

library.add(faPlus, faEraser)

// Props
const props = defineProps({
  updateListingId: {
    type: Number,
    default: null,
  },
  listingData: {
    type: Object,
    default: null,
  },
  divisions: {
    type: Array,
    default: () => [],
  },
  categories: {
    type: Array,
    default: () => [],
  },
  statuses: {
    type: Array,
    default: () => [],
  },
  types: {
    type: Array,
    default: () => [],
  },
  listingActiveDivision: {
    type: Number,
    default: null,
  },
  constants: {
    type: Object,
    default: () => ({}),
  },
  toggleModal: {
    type: Function,
    default: () => {},
  },
})

const emit = defineEmits(['saved', 'toggleModal'])

function toggleModal() {
  emit('toggleModal')
}

// State
const step = ref(1)
const lastStep = ref(5)
const errors = ref({})
const hasError = ref(false)
const buildingOptions = ref([])
const selectedThumbnailId = ref(null) // Track which image is selected as thumbnail
const selectedPropertyType = ref(null) // Track selected property type
const isNewProperty = ref(false) // Track if we need to create a new property
// Suppress reactive clears while initializing existing data into the form
const isInitializing = ref(false)

// Constants
const building_categories = ref([
  { name: 'Residential', value: 'residential' },
  { name: 'Commercial', value: 'commercial' },
])

const filteredBuildingOptions = ref([])

const listing_statuses = ref([
  { name: 'Available', value: 'available' },
  { name: 'Occupied Rented', value: 'occupied-rented' },
  { name: 'On Hold', value: 'on-hold' },
  { name: 'Under Negotiation', value: 'under-negotiation' },
  { name: 'Sold', value: 'sold' },
])

const displayOptions = ref([
  { text: 'Advance Rental', value: 'advance-rental' },
  { text: 'Terms', value: 'terms' },
])

const conditionsOptions = ref([
  { value: 'fully-furnished', label: 'Fully Furnished' },
  { value: 'semi-furnished', label: 'Semi Furnished' },
  { value: 'unfurnished', label: 'Unfurnished' },
  { value: 'bare-shell', label: 'Bare Shell' },
  { value: 'warm-shell', label: 'Warm Shell' },
  { value: 'fitted-out', label: 'Fitted Out' },
  { value: 'as-is-where-is', label: 'As Is Where Is' },
])

const amenitiesOptions = ref([
  { label: 'Air Conditionering', value: 'air_conditionering' },
  { label: 'Fire Exits', value: 'fire_exits' },
  { label: 'Open fireplace', value: 'open_fireplace' },
  { label: 'Swimming Pool', value: 'swimming_pool' },
  { label: 'Attic', value: 'attic' },
  { label: 'Fire sprinkler system ', value: 'fire_sprinkler_system' },
  { label: 'Parking Space', value: 'parking_space' },
  { label: 'Utility room', value: 'utility_room' },
  { label: 'Balcony', value: 'balcony' },
  { label: 'Flex', value: 'flex' },
  { label: 'Pet Friendly', value: 'pet_friendly' },
  { label: 'Water Heater', value: 'water_heater' },
  { label: 'Basement', value: 'basement' },
  { label: 'Function Room', value: 'function_room' },
  { label: 'Powder room', value: 'powder_room' },
  { label: 'Wi-Fi', value: 'wi-fi' },
])

const contactOptions = ref([])
const selectedContact = ref(null)

const amenities = ref([])
const selectedAmenities = ref([])

// Add barangay options state
const selectedBarangay = ref(null)
const selectedCity = ref(null)

// Add unit options for the form fields
const unitOptions = ref([
  { text: 'Months', value: 'months' },
  { text: 'Years', value: 'years' },
])

// Form state
const form = ref({
  // step 1
  category: null,
  for_sale: 0,
  for_rent: 1,
  property_id: null,
  // building_id: new canonical FK to public.buildings(id). Mirrors
  // property_id during the transition; new code reads building_id,
  // legacy code keeps reading property_id. Both are stamped together
  // whenever the user picks a building.
  building_id: null,
  building_type: '',
  // property_owner: useSupabaseUser().value?.user_metadata.full_name,
  property_owner: '',
  barangay_name: '',
  barangay_id: null, // Add barangay_id field
  city_name: '',
  city_id: null, // Add city_id field
  street_address: '',

  // step 2
  unit_number: '',
  title: '',
  status: null,
  availability_date: '',

  // step 3
  rent_price: '',
  reduced_rent_price: '',
  floor_area: '',
  advance: 1,
  advance_unit: 'months',
  deposit: 2,
  deposit_unit: 'months',
  lot_area: '',
  bedrooms: 0,
  bathrooms: 0,
  parking_spaces: 0,
  minimum_lease_term: 1,
  minimum_lease_term_unit: 'months',
  association_dues: '',
  slideshare_id: '',
  youtube_id: '',
  optional_contents: [],

  // Pricing
  rent_pps: '',
  original_rent_pps: '',
  sale_price: '',
  sale_pps: '',
  original_sale_price: '',
  original_sale_pps: '',
  price_per: null,
  price_rate: null,
  discount_percentage: '',

  // Commercial specific
  escalation: '',
  telcos: '',
  commercial_aircon: '',
  commercial_aircon_operation: '',
  commercial_building_class: '',
  commercial_developer: '',
  commercial_office_floor: '',
  commercial_occupant_number: '',
  commercial_office_type: null,
  commercial_office_setup: null,

  // step 4
  condition: null,
  amenities: [],

  // step 5
  images: [],
  originalImages: [],
  remarks: '',
  fixed_image_price: 200,
  price_per_image: 0,
  watermark_agreement: 1,

  // Other fields
  description: '',
  division_id: props.listingActiveDivision,
  user_id: '',
  type_id: null,
  building_id: null,

  // Contact Information
  contact_name: '',
  contact_email: '',
  contact_home_phone: '',
  contact_mobile_phone: '',
  contact_link: '',
  contact_notes: '',

  // Online status
  is_online: false,
})

// Computed properties
const isForSale = computed(() => form.value.for_sale == 1)
const isForRent = computed(() => form.value.for_rent == 1)
const isResidential = computed(() => form.value.category === 'residential')
const isCommercial = computed(() => form.value.category === 'commercial')
const buildingTypes = computed(() => [])
const propertyOwnerOptions = computed(() => [
  {
    id: 1,
    name: 'Developer',
  },
])
const areaOptions = computed(() => [])
const cityOptions = ref([]) // Changed from computed to ref to be populated from database
const barangayOptions = ref([])

// Add function to fetch cities from database
async function fetchCities() {
  try {
    const nuxtApp = useNuxtApp()
    const { data, error } = await useSupabaseClient()
      .from('cities')
      .select('*')
      .order('name')

    if (error) {
      console.error('Error fetching cities:', error)
      return
    }

    cityOptions.value = data.map((city) => ({
      label: city.name,
      value: city.slug,
      city_id: city.id,
    }))

  } catch (error) {
    console.error('Error fetching cities:', error)
  }
}

async function handleCityChange(city) {
  selectedCity.value = city
  form.value.city_name = city.label
  form.value.city_id = city.city_id

  showLoading()
  const nuxtApp = useNuxtApp()
  const { data, error } = await useSupabaseClient()
    .from('barangays')
    .select('*')
    .eq('city_id', city.city_id)
    .order('name')

  if (error) {
    console.error('Error fetching barangays:', error)
    return
  }

  if (data) {
    barangayOptions.value = data.map((barangay) => ({
      label: barangay.name,
      value: barangay.id,
      slug: barangay.slug,
    }))
  }

  dismissLoading()
}

// Computed properties for automatic price per sqm calculation
const calculatedSalePricePerSqm = computed(() => {
  if (
    form.value.sale_price &&
    form.value.floor_area &&
    form.value.floor_area > 0
  ) {
    return (form.value.sale_price / form.value.floor_area).toFixed(2)
  }
  return null
})

const calculatedRentPricePerSqm = computed(() => {
  if (
    form.value.rent_price &&
    form.value.floor_area &&
    form.value.floor_area > 0
  ) {
    return (form.value.rent_price / form.value.floor_area).toFixed(2)
  }
  return null
})

// Price state
const price = ref({
  rent: { disable: false },
  rent_pps: { disable: false },
  orig_rent: { disable: false },
  orig_rent_pps: { disable: false },
  sale: { disable: false },
  sale_pps: { disable: false },
  orig_sale: { disable: false },
  orig_sale_pps: { disable: false },
})

// Editor options
const editorOptions = ref({
  modules: {
    toolbar: [['bold', 'italic', 'underline']],
  },
})

// Validation functions for floor_area and lot_area
function validateIntegerField(value) {
  if (value === '' || value === null || value === undefined) {
    return null // No error if empty
  }
  
  // Check if the string representation contains a decimal point
  const stringValue = String(value)
  if (stringValue.includes('.')) {
    return 'Must be a whole number (no decimals)'
  }
  
  const numValue = Number(value)
  if (!Number.isInteger(numValue)) {
    return 'Must be a whole number (no decimals)'
  }
  return null
}

function handleFloorAreaChange(value) {
  form.value.floor_area = value
  const error = validateIntegerField(value)
  if (error) {
    errors.value.floor_area = error
  } else {
    delete errors.value.floor_area
  }
}

function handleLotAreaChange(value) {
  form.value.lot_area = value
  const error = validateIntegerField(value)
  if (error) {
    errors.value.lot_area = error
  } else {
    delete errors.value.lot_area
  }
}

// Methods
function toggleTab(tab) {
  step.value = tab
}

function sanitizeNumericFields(data) {
  const numericFields = [
    'sale_price',
    'rent_price',
    'bedrooms',
    'bathrooms',
    'floor_area',
    'lot_area',
    'parking_spaces',
    'association_dues',
    'rent_advance',
    'security_deposit',
  ]

  const sanitized = { ...data }
  numericFields.forEach((field) => {
    if (sanitized[field] === '' || sanitized[field] === undefined) {
      sanitized[field] = null
    }
  })
  return sanitized
}

function validateFormData() {
  try {
    errors.value = {}

    // Create a complete form data object for validation
    const formDataForValidation = {
      ...form.value,
      contact_id:
        selectedContact.value && selectedContact.value.value
          ? selectedContact.value.value
          : null,
    }

    const validationErrors = validateForm(formDataForValidation)

    if (Object.keys(validationErrors).length > 0) {
      errors.value = validationErrors

      // Create a comprehensive error message for required fields
      const missingFields = Object.keys(validationErrors).map((field) => {
        const fieldName = field
          .replace(/_/g, ' ')
          .replace(/\b\w/g, (l) => l.toUpperCase())
        return fieldName
      })

      const errorMessage = `Please fill in all required fields marked with (*):\n\n${missingFields.join(
        '\n'
      )}`

      showToast({
        title: 'Required Fields Missing',
        message: errorMessage,
        icon: 'warning',
        duration: 5000,
      })

      return false
    }

    return true
  } catch (error) {
    console.error('Validation error:', error)
    showToast({
      title: 'An error occurred during form validation',
      icon: 'error',
    })
    return false
  }
}

watch(form.value.sale_price, (newVal) => {
})

// Watchers for automatic price per sqm calculation
watch(
  [() => form.value.sale_price, () => form.value.floor_area],
  ([salePrice, floorArea]) => {
    if (
      salePrice &&
      floorArea &&
      floorArea > 0 &&
      !form.value.sale_price_per_sqm
    ) {
      form.value.sale_price_per_sqm = calculatedSalePricePerSqm.value
    }
  }
)

watch(
  [() => form.value.rent_price, () => form.value.floor_area],
  ([rentPrice, floorArea]) => {
    if (
      rentPrice &&
      floorArea &&
      floorArea > 0 &&
      !form.value.rent_price_per_sqm
    ) {
      form.value.rent_price_per_sqm = calculatedRentPricePerSqm.value
    }
  }
)

const convertFileToBase64 = (file) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

const imagesToBase64 = async (images) => {
  const base64Images = await Promise.all(
    images.map(async (image) => {
      const base64 = await convertFileToBase64(image.file)
      return { ...image, base64 }
    })
  )
  return base64Images
}

const calculatePosition = (
  position,
  canvasWidth,
  canvasHeight,
  textWidth,
  textHeight
) => {
  const margin = 20
  switch (position) {
    case 'bottom-right':
      return {
        x: canvasWidth - textWidth / 2 - margin,
        y: canvasHeight - textHeight / 2 - margin,
      }
    case 'bottom-left':
      return {
        x: textWidth / 2 + margin,
        y: canvasHeight - textHeight / 2 - margin,
      }
    case 'top-right':
      return {
        x: canvasWidth - textWidth / 2 - margin,
        y: textHeight / 2 + margin,
      }
    case 'top-left':
      return { x: textWidth / 2 + margin, y: textHeight / 2 + margin }
    case 'center':
    default:
      return { x: canvasWidth / 2, y: canvasHeight / 2 }
  }
}

const canvas = ref(null)

// Add watermark to the image
const applyWatermark = async (image) => {
  if (!image) {
    return
  }

  try {
    const img = new Image()

    // Wait for image to load
    await new Promise((resolve, reject) => {
      img.onload = resolve
      img.onerror = reject
      img.src = URL.createObjectURL(image.file)
    })

    // Load the SVG logo
    const logo = new Image()
    await new Promise((resolve, reject) => {
      logo.onload = resolve
      logo.onerror = reject
      logo.src = hiLogo
    })

    // Set canvas dimensions
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')

    // Draw original image
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

    // Calculate logo dimensions (5% of image width)
    const logoWidth = canvas.width * 0.76
    const logoHeight = (logo.naturalHeight / logo.naturalWidth) * logoWidth
    const padding = canvas.width * 0.02 // 2% padding
    // Set opacity
    ctx.globalAlpha = 0.7 // 70% opacity

    // Position in bottom-right corner
    const x = canvas.width - logoWidth - padding
    const y = canvas.height - logoHeight - padding

    // Draw logo watermark
    ctx.drawImage(logo, x, y, logoWidth, logoHeight)

    // Reset alpha
    ctx.globalAlpha = 1.0

    // Convert to data URL
    const watermarkedUrl = canvas.toDataURL('image/jpeg', 0.9)
    URL.revokeObjectURL(img.src)

    return { watermarkedUrl, file: image.file }
  } catch (error) {
    console.error('Error applying watermark:', error)
    alert('Error applying watermark')
  }
}

const userCanEditListing = ref(false)

async function save() {
  // Set property category based on selected property type
  if (selectedPropertyType.value) {
    form.value.property_category = selectedPropertyType.value.property_category
  }

  try {
    if (!validateFormData()) {
      return
    }

    // IMPORTANT: The following code will alter table 'listings'
    if (step.value === lastStep.value) {
      showLoading()

      // Listings payload uses ONLY normalized FKs:
      //   - contact_id  (NOT contact_name / contact_email / contact_*)
      //   - city_id     (NOT city_name / city_slug)
      //   - barangay_id (NOT barangay_name)
      // The denormalized columns are being dropped in migrations
      // 20260429000003 + 20260429000004; both server- and client-side guards
      // throw if any of those names slip back in.
      const formData = {
        property_id: form.value.property_id,
        // building_id is the new canonical FK to public.buildings(id);
        // mirrors property_id during the transition (see watcher above).
        building_id: form.value.building_id ?? form.value.property_id ?? null,
        property_category: form.value.property_category,
        property_type: form.value.building_type, // Map building_type to property_type
        contact_id: selectedContact.value?.value ?? null,
        city_id: form.value.city_id ?? null,
        barangay_id: form.value.barangay_id ?? null,
        title: form.value.title,
        status: form.value.status,
        condition: form.value.condition,
        description: form.value.description,
        unit_number: form.value.unit_number,
        is_online: form.value.is_online,
        for_sale: form.value.for_sale,
        for_rent: form.value.for_rent,
        sale_price: form.value.sale_price,
        rent_price: form.value.rent_price,
        bedrooms: form.value.bedrooms,
        bathrooms: form.value.bathrooms,
        floor_area: form.value.floor_area,
        lot_area: form.value.lot_area,
        parking_spaces: form.value.parking_spaces,
        lease_term: form.value.lease_term,
        rent_advance: form.value.advance,
        security_deposit: form.value.deposit,
        association_dues: form.value.association_dues,
        availability_date: form.value.availability_date,
        remarks: form.value.remarks,
      }

      const sanitizedFormData = sanitizeNumericFields(formData)


      if (props.updateListingId) {
        const data = await ListingService._updateListing(
          props.updateListingId,
          sanitizedFormData
        )

        // Upload new images if any were added during the update
        if (form.value.images.length > 0) {
          try {

            // Filter out images that already exist in uploadedImages (these are existing images)
            const newlyAddedImages = form.value.images.filter(
              (newImg) =>
                !uploadedImages.value.some(
                  (existingImg) => existingImg.name === newImg.name
                )
            )


            if (newlyAddedImages.length > 0) {
              // Create ImagesController to handle new image uploads
              const ImagesControllerClass = (
                await import('@/services/images/imagesController')
              ).default
              const uploadImagesController = await ImagesControllerClass.create(
                props.updateListingId
              )

              // Upload only the newly added images
              const uploadResult = await uploadImagesController.uploadImages(
                newlyAddedImages,
                form.value.originalImages.filter((origImg) =>
                  newlyAddedImages.some(
                    (newImg) => newImg.name === origImg.name
                  )
                )
              )


              // Refresh the uploaded images list to get the updated file names
              await refreshUploadedImages()

              // Add a small delay to ensure S3 uploads are available
              await new Promise((resolve) => setTimeout(resolve, 2000))
            }
          } catch (uploadError) {
            console.error('Error uploading new images:', uploadError)
            // Don't fail the entire save operation for image upload issues
          }
        }

        // Delete images that were marked for deletion
        if (uploadedImagesToBeDeleted.value.length > 0) {
          try {

            // Create ImagesController to handle image deletions
            const ImagesControllerClass = (
              await import('@/services/images/imagesController')
            ).default
            const deleteImagesController = await ImagesControllerClass.create(
              props.updateListingId
            )

            // Convert the image data to the format expected by the deletion methods
            // The deletion methods expect S3 keys, so we need to construct them
            const imagesToDelete = uploadedImagesToBeDeleted.value.map(
              (image) => {
                // Construct the S3 key for the displayed image
                const displayedKey = `properties/property-${props.updateListingId}/${image.name}`
                // Construct the S3 key for the original image
                const originalKey = `properties/original/property-${props.updateListingId}/${image.name}`

                return {
                  displayedKey,
                  originalKey,
                  name: image.name,
                  extension: image.extension,
                  id: image.id,
                }
              }
            )

            // Set the images to be deleted with proper S3 keys
            deleteImagesController.imagesData = imagesToDelete

            // Delete the marked images
            const deleteResults = await deleteImagesController.deleteImages()

            if (deleteResults.success) {

              // Refresh the uploaded images list to reflect the deletions
              await refreshUploadedImages()

              showToast({
                title: `${uploadedImagesToBeDeleted.value.length} image(s) deleted successfully`,
                icon: 'success',
              })
            } else {
              console.warn('Image deletion had issues:', deleteResults)
              showToast({
                title: 'Some images could not be deleted',
                icon: 'warning',
              })
            }
          } catch (deleteError) {
            console.error('Error deleting images:', deleteError)
            showToast({
              title: 'Error deleting images',
              icon: 'error',
            })
            // Don't fail the entire save operation for image deletion issues
          }
        }

        // Apply thumbnail change if a new thumbnail was selected
        if (selectedThumbnailId.value !== null) {
          try {

            // Find the selected image in the client form array
            const selectedImage = form.value.images.find(
              (img) => img.id === selectedThumbnailId.value
            )

            let actualThumbnailId = null

            if (selectedImage) {
              // The selected image is in the form array - find it in uploaded images by name
              // This handles both new and existing images since refreshUploadedImages extracts IDs from S3 filenames
              const uploadedImage = uploadedImages.value.find(
                (img) => img.name === selectedImage.name
              )

              if (uploadedImage) {
                // Use the ID from the uploaded images list (extracted from S3 filename)
                actualThumbnailId = uploadedImage.id
              } else {
                console.warn(
                  'Selected image not found in S3 uploaded images:',
                  selectedImage.name
                )
                actualThumbnailId = selectedThumbnailId.value
              }
            } else {
              // Try to find it directly in uploadedImages by ID (for existing images)
              const existingImage = uploadedImages.value.find(
                (img) => img.id === selectedThumbnailId.value
              )
              if (existingImage) {
                actualThumbnailId = existingImage.id
              } else {
                console.warn(
                  'Selected image not found in either form images or uploaded images'
                )
              }
            }

            if (actualThumbnailId === null) {
              console.warn('Could not determine thumbnail ID, skipping thumbnail update')
            } else {
              const thumbnailResults =
                await ListingService._updateThumbnailSelection(
                  props.updateListingId,
                  actualThumbnailId
                )

              if (thumbnailResults.success) {
              } else {
                console.warn('Thumbnail update had issues:', thumbnailResults)
              }
            }
          } catch (thumbnailError) {
            console.error(
              'Error updating thumbnail during save:',
              thumbnailError
            )
            // Don't fail the entire save operation for thumbnail issues
          }
        }

        showToast({
          title: 'Listing updated successfully!',
          message: `Listing #${props.updateListingId} has been updated and changes are being processed.`,
          icon: 'success',
        })

        dismissLoading()
        toggleModal()
        
        // Redirect to listings page after a short delay
        setTimeout(() => {
          router.push('/listings')
        }, 1000)
        
        return // Exit early to prevent reload
        // emit('saved', data)
      } else {
        // New Upload Handler
        sanitizedFormData.availability_date = new Date(
          sanitizedFormData.availability_date
        )

        //create amenities
        const nuxtApp = useNuxtApp()
        const supabase = useSupabaseClient()

        const user = useSupabaseUser()

        // Create new property if this is a non-building type
        if (isNewProperty.value) {
          try {
            // Get city_id from selected city option
            const city = cityOptions.value.find(
              (c) => c.label === form.value.city_name
            )

            if (!city?.city_id) {
              throw new Error('City not found for selected city name')
            }

            const propertyData = {
              // Let the database assign the identity `id`
              name: form.value.street_address || 'New Property',
              category: form.value.property_category,
              type: selectedPropertyType.value.slug,
              street_address: form.value.street_address,
              city_id: city.city_id,
              barangay_id: form.value.barangay_id,
              created_by: user.value && user.value.id ? user.value.id : null,
              updated_by: user.value && user.value.id ? user.value.id : null,
            }

            const { data: newProperty, error: propertyError } = await supabase
              .from('properties')
              .insert(propertyData)
              .select()
              .single()

            if (propertyError) {
              console.error('Error creating property:', propertyError)
              throw new Error(
                `Failed to create property: ${propertyError.message}`
              )
            }

            // Update the form data to use the new property ID
            sanitizedFormData.property_id = newProperty.id
          } catch (error) {
            console.error('Error creating property:', error)
            showToast({
              title: 'Error creating property',
              message: error.message,
              icon: 'error',
            })
            dismissLoading()
            return
          }
        }

        // Create listing without images first for faster response
        const { data: listingData, error: listingError } =
          await ListingService._createListingOnly(
            sanitizedFormData,
            user.value && user.value.id ? user.value.id : null
          )


        const id = listingData.id
        
        // Save amenities in parallel
        if (selectedAmenities.value.length > 0) {
          const amenityPromises = selectedAmenities.value.map((amenity) =>
            supabase
              .from('listing_amenities')
              .insert({
                listing_id: listingData.id,
                amenity_id: amenity,
              })
          )
          
          try {
            await Promise.all(amenityPromises)
          } catch (amenitiesError) {
            console.error('Error creating amenities:', amenitiesError)
          }
        }
        
        // Store temporary listing data
        localStorage.setItem(
          `tempListing-${id}`,
          JSON.stringify({
            ...listingData,
            contact_name: selectedContact.value.label,
            category: form.value.category,
            street_address: form.value.street_address,
            city_name: form.value.city_name,
            barangay_name: form.value.barangay_name,
            building_type: form.value.building_type,
            property_owner: form.value.property_owner,
            building_name: form.value.building_name,
            listing_id: listingData.id,
            for: 'creation',
          })
        )
        
        // Show success notification immediately
        showToast({
          title: 'Listing created successfully!',
          message: `Listing #${listingData.id} is being created. Images are uploading in the background.`,
          icon: 'success',
        })
        
        dismissLoading()
        toggleModal()
        
        // Upload images in the background (non-blocking)
        if (form.value.images && form.value.images.length > 0) {
          ListingService._uploadListingImages(
            listingData.id,
            form.value.images,
            form.value.originalImages,
            selectedThumbnailId.value
          ).then(() => {
            // Remove temp listing from localStorage after images are uploaded
            localStorage.removeItem(`tempListing-${id}`)
          }).catch((error) => {
            console.error('Error uploading images in background:', error)
            showToast({
              title: 'Image upload issue',
              message: 'Some images may not have uploaded correctly. Please check the listing.',
              icon: 'warning',
            })
          })
        } else {
          // No images to upload, remove temp listing immediately
          localStorage.removeItem(`tempListing-${id}`)
        }
        
        // Redirect to listings page
        setTimeout(() => {
          router.push('/listings')
        }, 1000)
        
        return // Exit early to prevent reload
      }
      dismissLoading()
      window.location.reload()
    } else {
      step.value++
    }
  } catch (error) {
    console.error('Error saving listing:', error)
    showToast({
      title: `${error}`,
      icon: 'error',
    })
    showToast({
      title: `${error}`,
      icon: 'error',
    })
    dismissLoading()
    toggleModal()
  }
}

const uploadedImagesToBeDeleted = ref([])

// Filepond methods
const FilePond = vueFilePond()
const imagesTemp = ref([])
const isProcessingFiles = ref(false)

const handleFileRemove = async (imageName) => {
  form.value.images = form.value.images.filter(
    (image) => image.name !== imageName
  )
  form.value.originalImages = form.value.originalImages.filter(
    (image) => image.name !== imageName
  )
}

const handleFilesUpdated = async (fileItems) => {
  if (!fileItems || fileItems.length === 0) return
  if (isProcessingFiles.value) return
  isProcessingFiles.value = true

  try {
    // Get truly new files (not already in form.value.images)
    const newFileItems = fileItems.filter(
      (fi) => !form.value.images.some((existingImg) => existingImg.name === fi.file?.name)
    )
    
    if (newFileItems.length === 0) {
      imagesTemp.value = []
      return
    }

    // Check if we already have 4 images
    if (form.value.images.length >= 4) {
      showToast({
        title: 'Maximum 4 images allowed',
        message: 'You have reached the maximum number of images (4). Please remove some before adding more.',
        icon: 'error',
      })
      imagesTemp.value = []
      return
    }

    // Separate files into valid and invalid
    const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp']
    const maxFileSizeBytes = 2 * 1024 * 1024 // 2MB
    
    const validFiles = []
    const invalidFiles = []

    for (const fi of newFileItems) {
      // Check file type
      if (!fi.file?.type || !allowedTypes.includes(fi.file.type)) {
        invalidFiles.push({
          name: fi.file?.name || 'Unknown',
          reason: 'Invalid file type (use PNG or JPEG)',
        })
        continue
      }

      // Check file size
      if (fi.file?.size > maxFileSizeBytes) {
        const sizeMB = (fi.file.size / (1024 * 1024)).toFixed(2)
        invalidFiles.push({
          name: fi.file.name,
          reason: `File size ${sizeMB}MB exceeds 2MB limit`,
        })
        continue
      }

      validFiles.push(fi)
    }

    // Show error for invalid files
    if (invalidFiles.length > 0) {
      const errorMessages = invalidFiles.map(f => `${f.name}: ${f.reason}`).join('\n')
      showToast({
        title: 'Some files could not be uploaded',
        message: errorMessages,
        icon: 'error',
      })
    }

    // Check if adding valid files would exceed 4 images
    if (form.value.images.length + validFiles.length > 4) {
      showToast({
        title: 'Too many images',
        message: `You can only upload ${4 - form.value.images.length} more image(s). You selected ${validFiles.length}.`,
        icon: 'error',
      })
      imagesTemp.value = []
      return
    }

    // Process only valid files
    if (validFiles.length === 0) {
      imagesTemp.value = []
      return
    }

    async function convertToDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = (e) => resolve(e.target.result)
        reader.onerror = (e) => reject(e)
        reader.readAsDataURL(file)
      })
    }

    const baseId = Date.now()
    for (let i = 0; i < validFiles.length; i++) {
      const fileItem = validFiles[i]
      if (form.value.images.some((img) => img.name === fileItem.file.name)) continue

      const [watermarkedFile, dataUrl] = await Promise.all([
        applyWatermark(fileItem),
        convertToDataUrl(fileItem.file),
      ])
      if (!watermarkedFile?.watermarkedUrl) continue

      const isFirstNew = form.value.images.length === 0 && i === 0
      const id = baseId + i
      form.value.images.push({
        id,
        name: fileItem.file.name,
        dataUrl: watermarkedFile.watermarkedUrl,
        file: watermarkedFile.file,
        extension: fileItem.file.name.split('.').pop(),
        thumbnail: isFirstNew,
      })
      form.value.originalImages.push({
        id,
        name: fileItem.file.name,
        dataUrl,
        file: fileItem.file,
        extension: fileItem.file.name.split('.').pop(),
        thumbnail: isFirstNew,
      })
    }

    // Dedupe by name so the same file never shows twice (e.g. if updatefiles fired twice)
    const seenNames = new Set()
    form.value.images = form.value.images.filter((img) => {
      if (seenNames.has(img.name)) return false
      seenNames.add(img.name)
      return true
    })
    const seenOriginalNames = new Set()
    form.value.originalImages = form.value.originalImages.filter((img) => {
      if (seenOriginalNames.has(img.name)) return false
      seenOriginalNames.add(img.name)
      return true
    })
  } finally {
    isProcessingFiles.value = false
    imagesTemp.value = []
  }
}

// Watchers
watch(
  () => form.value.category,
  (newValue) => {
    resetCategorySpecificFields()
  }
)

// Functions
async function init() {
  await getBuildingsList()

  if (!!props.updateListingId) {
    await getListing()
  }
}

function filterBuildingOptions(search) {
  filteredBuildingOptions.value = buildingOptions.value.filter((option) =>
    option.building_name.toLowerCase().includes(search.toLowerCase())
  )
}

const noDropdown = ref(true)
const uploadedImages = ref([])
function setNoDropdown(value) {
  if (value) {
    noDropdown.value = false
  } else {
    noDropdown.value = true
  }

}

async function handleBuildingSelection(propertyId) {
  try {
    showLoading()
    const { data } = await ListingService._selectBuilding(propertyId)
    form.value.property_id = data.property_id
    form.value.property_category = data.category
    // city_name / barangay_name are kept in form state for the disabled
    // display inputs only — they are NOT sent to the API. The IDs below
    // are the source of truth for the listings insert payload.
    form.value.city_name = data.city_name
    form.value.barangay_name = data.barangay_name
    form.value.street_address = data.street_address
    form.value.building_type = data.type
    form.value.property_owner = data.developer_name
    form.value.building_name = data.building_name
    form.value.category = data.category

    // Pull the FKs straight off the building record. If the buildings view
    // doesn't surface them (older deployments), fall back to a label match
    // against the loaded cityOptions so the listings payload still gets a
    // city_id.
    if (data.city_id != null) {
      form.value.city_id = data.city_id
    } else if (data.city_name) {
      const cityOption = cityOptions.value.find(
        (c) => c.label === data.city_name,
      )
      form.value.city_id = cityOption?.city_id ?? null
    } else {
      form.value.city_id = null
    }
    form.value.barangay_id = data.barangay_id ?? null

    // Clear the dropdown selections — they're not used in the building flow,
    // but stale state from a previous non-building edit would otherwise leak.
    selectedBarangay.value = null
    selectedCity.value = null

    if (data.amenities)
      for (const amenity of data.amenities) {
        //check if amenity is present in amenities[amenity_name]
        if (amenities.value.some((a) => a.amenity_name === amenity)) {
          toggleAmenity(
            amenities.value.find((a) => a.amenity_name === amenity).amenity_id
          )
        }
      }


    setNoDropdown(false)
    await dismissLoading()
  } catch (error) {
    console.error('Error fetching building details:', error)
    showToast('Error loading building details')
  }
}

async function getContactData() {
  const nuxtApp = useNuxtApp()
  const user = useSupabaseUser()

  const { data, error } = await useSupabaseClient()
    .from('contacts')
    .select('*')
    .eq('owner_user_id', user.value && user.value.id ? user.value.id : null)
    .eq('email', user.value && user.value.email ? user.value.email : null)

  form.value.contact_id = data.id
}

async function handleCitySelection(cityValue) {
  if (cityValue) {
    selectedCity.value = cityValue
    form.value.city_name = cityValue.label
    form.value.city_id = cityValue.city_id

    // Clear barangay selection when city changes
    form.value.barangay_id = null
    form.value.barangay_name = ''
    selectedBarangay.value = null
  }
}

const fetchTypes = async () => {
  try {
    const nuxtApp = useNuxtApp()
    const { data, error } = await useSupabaseClient()
      .from('property_types')
      .select('*')
      .order('display_name')

    if (data) {
      typeOptions.value = data.map((type) => ({
        label: type.display_name,
        value: type.id,
        is_building: type.is_building,
        property_category: type.property_category,
      }))
    }
  } catch (error) {
    console.error('Error fetching property types:', error)

    showSwal({
      title: 'Something went wrong',
      html: 'Oops! Something went wrong fetching property types. Please try again later.',
      icon: 'error',
      allowOutsideClick: false,
      confirmButtonText: 'Reload',
    })
  }
}

// Add computed property to check if type is a non-building type
const isNonBuildingType = computed(() => isNewProperty.value)

// Mirror property_id → building_id whenever it changes. The two
// columns hold the same FK during the transition: legacy code reads
// property_id, new code reads building_id. The buildings table heal
// migration ensures buildings.id == buildings.property_id for every
// existing row, so this mirror is correct on every existing listing
// and continues to be correct as users pick buildings going forward.
watch(
  () => form.value.property_id,
  (id) => { form.value.building_id = id ?? null },
  { immediate: true },
)

// Add watcher for building_type changes
watch(
  () => form.value.building_type,
  (newType) => {
    // Avoid clearing fields while we are prefilling existing data
    if (isInitializing.value) return
    // Find the selected property type
    const selectedType = typeOptions.value.find(
      (type) => type.value === newType
    )

    if (selectedType) {
      selectedPropertyType.value = selectedType
      isNewProperty.value = !selectedType.is_building

      if (isNewProperty.value) {
        // For non-building types, clear building-related fields and enable manual entry
        form.value.building_name = ''
        form.value.property_id = null
        form.value.category = selectedType.property_category
        // Enable manual entry of location fields
        form.value.city_name = ''
        form.value.street_address = ''
        // Clear barangay selection for non-building types
        form.value.barangay_id = null
        selectedBarangay.value = null
        barangayOptions.value = []
        selectedCity.value = null
      } else {
        // For building types, clear manual location fields and fetch buildings
        form.value.city_name = ''
        form.value.street_address = ''
        form.value.category = selectedType.property_category
        // Clear barangay selection for building types
        form.value.barangay_id = null
        selectedBarangay.value = null
        barangayOptions.value = []
        selectedCity.value = null
        // Fetch buildings for building type
        if (form.value.category) {
          getBuildingsList(form.value.category, newType)
        }
      }
    }
  }
)

async function getBuildingsList(category, type) {
  showLoading()
  try {
    let data = []

    // Only fetch buildings if the selected type is a building type
    if (isNewProperty.value) {
      // For non-building types, we don't need to fetch buildings
      buildingOptions.value = []
      filteredBuildingOptions.value = []
    } else {
      // For building types, fetch buildings as before
      if (category) {
        if (type) {
          data = await ListingService._getBuildingNames(category, type)
          form.value.category = category
          form.value.building_type = type
        } else {
          data = await ListingService._getBuildingNames(category)
          form.value.category = category
        }
      } else if (type) {
        data = await ListingService._getBuildingNames(type)
        form.value.building_type = type
      } else {
        data = await ListingService._getBuildingNames()
      }

      buildingOptions.value = data.data
      filteredBuildingOptions.value = data.data
    }

    await fetchAmenities()

  } catch (error) {
    console.error('Error fetching buildings:', error)
    showSwal({
      confirmButtonColor: '#3085d6',
      title: 'Something went wrong',
      html: 'Oops! Something went wrong fetching buildings. Please try again later.',
      icon: 'error',
      allowOutsideClick: false,
      confirmButtonText: 'Reload',
    }).then((result) => {
      if (result.isConfirmed) {
        window.location.reload()
      }
    })
  }

  await getContactData()
  await dismissLoading()
}

async function getListing() {
  // try {
  //   await useApiFetch(`/api/listings/${props.updateListingId}`, {
  //     method: 'GET',
  //     onResponse({ response }) {
  //       if (response.status === 200) {
  //         const { data } = response._data.body
  //         form.value.property_id = data.property_id
  //         form.value.property_owner = data.property_owner
  //       }
  //     },
  //   })
  //   await useApiFetch(`/api/listings/${props.updateListingId}`, {
  //     method: 'GET',
  //     onResponse({ response }) {
  //       if (response.status === 200) {
  //         const { data } = response._data.body
  //         form.value.property_id = data.property_id
  //         form.value.property_owner = data.property_owner
  //       }
  //     },
  //   })
  // } catch (error) {
  //   showSwal({
  //     confirmButtonColor: '#3085d6',
  //     title: 'Something went wrong',
  //     html: 'Oops! Something went wrong fetching data. Please try again later.',
  //     icon: 'error',
  //     allowOutsideClick: false,
  //     confirmButtonText: 'Reload',
  //   }).then((result) => {
  //     if (result.isConfirmed) {
  //       window.location.reload()
  //     }
  //   })
  // }

  //get listing data from supabase
  const nuxtApp = useNuxtApp()
  // Reads from `listing_details` (canonical wide read source).
  const { data, error } = await useSupabaseClient()
    .from('listing_details')
    .select('*')
    .eq('listing_id', props.updateListingId)
    .single()

  if (data) {
    form.value.property_id = data.property_id
    form.value.property_owner = data.property_owner
  }

  if (error) {
    console.error(
      'NewForm > getListing() > Error fetching listing data:',
      error
    )
    showSwal({
      confirmButtonColor: '#3085d6',
      title: 'Something went wrong',
      html: 'Oops! Something went wrong fetching data. Please try again later.',
      icon: 'error',
      allowOutsideClick: false,
      confirmButtonText: 'Reload',
    }).then((result) => {
      if (result.isConfirmed) {
        window.location.reload()
      }
    })
  }

}

function resetCategorySpecificFields() {
  if (isCommercial.value) {
    form.value.bedrooms = 0
    form.value.bathrooms = 0
  } else {
    form.value.commercial_building_class = ''
    form.value.commercial_developer = ''
    form.value.commercial_aircon = ''
    form.value.commercial_aircon_operation = ''
  }
}

function handleBedroomsChange(value) {
  form.value.bedrooms = parseInt(value)
}

async function fetchBarangays() {
  const nuxtApp = useNuxtApp()
  const { data, error } = await useSupabaseClient().from('barangays').select('*')
  barangayOptions.value = data.map((barangay) => ({
    label: barangay.name,
    value: barangay.id,
    slug: barangay.slug,
  }))
}

// Lifecycle hooks
onMounted(async () => {
   await fetchTypes()
  await fetchCities() // Fetch cities from database
  await fetchBarangays()
  userCanEditListing.value = can('edit_any_listing')

  init()

  const nuxtApp = useNuxtApp()
  const user = useSupabaseUser()

  //fetch contact options - fetch in batches to get all contacts beyond 1000 limit
  let allContacts = []
  let offset = 0
  const batchSize = 1000
  let hasMore = true

  while (hasMore) {
    const { data: contactBatch, error: contactError } = await useSupabaseClient()
      .from('contacts')
      .select('id, full_name')
      .range(offset, offset + batchSize - 1)

    if (contactError || !contactBatch || contactBatch.length === 0) {
      hasMore = false
    } else {
      allContacts = [...allContacts, ...contactBatch]
      if (contactBatch.length < batchSize) {
        hasMore = false
      } else {
        offset += batchSize
      }
    }
  }

  contactOptions.value = allContacts.map((contact) => ({
    label: contact.full_name,
    value: contact.id,
  }))


  if (props.updateListingId) {
    let data

    // Use passed listingData if available, otherwise fetch from database
    if (props.listingData) {
      data = props.listingData
    } else {
      const nuxtApp = useNuxtApp()
      // Reads from `listing_details` (canonical wide read source).
      // The view exposes `listing_id` natively, so no alias and the
      // filter pivots on listing_id rather than id.
      const { data: fetchedData, error } = await useSupabaseClient()
        .from('listing_details')
        .select('*')
        .eq('listing_id', props.updateListingId)
        .single()

      data = fetchedData
    }

    if (data) {
      // Prevent reactive clears while initializing from existing data
      isInitializing.value = true

      // Set the type first so computed/UI behaves correctly
      form.value.building_type = data.building_type || data.type || data.property_type || ''
      form.value.property_category = data.property_category
      form.value.category = data.property_category || data.category

      // Load amenities FIRST before processing listing amenities
        // Make sure amenities are loaded

        if (amenities.value.length === 0) {
    await fetchAmenities()
  }

      // Now fill the rest of the fields
      form.value.unit_number = data.unit_number
      form.value.title = data.title
      form.value.description = data.description
      form.value.status = data.status
      form.value.availability_date = data.availability_date
      form.value.for_sale = data.for_sale
      form.value.for_rent = data.for_rent
      form.value.property_id = data.property_id
      // Prefer explicit building_name, fallback to property_name
      form.value.building_name = data.building_name || data.property_name || ''
      form.value.street_address = data.street_address
      // Display strings come from the joined relation (post-migration source
      // of truth). Fall back to legacy *_name columns during the transition
      // window so existing rows still render until the migrations land.
      form.value.city_name = data.city?.name ?? data.city_name ?? ''
      form.value.barangay_name = data.barangay?.name ?? data.barangay_name ?? ''

      // Hydrate the FKs. Prefer the listing's own city_id/barangay_id (post
      // Phase F), fall back to a label match against cityOptions for rows
      // that pre-date the migration.
      if (data.city_id != null) {
        form.value.city_id = data.city_id
      } else if (form.value.city_name) {
        const cityOption = cityOptions.value.find(
          (city) => city.label === form.value.city_name,
        )
        if (cityOption) form.value.city_id = cityOption.city_id
      }
      if (data.barangay_id != null) {
        form.value.barangay_id = data.barangay_id
      }

      // Hydrate the v-model selectors used by the non-building flow.
      if (form.value.city_id != null) {
        const cityOption = cityOptions.value.find(
          (city) => city.city_id === form.value.city_id,
        )
        if (cityOption) selectedCity.value = cityOption
      }
      if (form.value.barangay_id != null) {
        const barangayOption = barangayOptions.value.find(
          (barangay) => barangay.value === form.value.barangay_id,
        )
        if (barangayOption) selectedBarangay.value = barangayOption
      }
      form.value.is_online = data.is_online
      form.value.sale_price = data.sale_price
      form.value.rent_price = data.rent_price
      form.value.sale_price_per_sqm = data.sale_price_per_sqm
      form.value.rent_price_per_sqm = data.rent_price_per_sqm
      form.value.condition = data.condition
      form.value.bedrooms = data.bedrooms
      form.value.bathrooms = data.bathrooms
      form.value.floor_area = data.floor_area
      form.value.lot_area = data.lot_area
      form.value.parking_spaces = data.parking_spaces
      form.value.lease_term = data.lease_term
      form.value.rent_advance = data.rent_advance
      form.value.security_deposit = data.security_deposit
      form.value.association_dues = data.association_dues
      form.value.availability_date = data.availability_date
      form.value.remarks = data.remarks || ''
      form.value.created_by = data.created_by
      form.value.created_at = data.created_at

      // Load commercial-specific fields
      form.value.commercial_building_class =
        data.commercial_building_class || ''
      form.value.commercial_developer = data.commercial_developer || ''
      form.value.commercial_aircon = data.commercial_aircon || ''
      form.value.commercial_aircon_operation =
        data.commercial_aircon_operation || ''

      // Load amenities for the listing - map names/objects to amenity_id values
      if (data.listing_amenities) {

        let listingAmenities = data.listing_amenities
        if (typeof listingAmenities === 'string') {
          try {
            listingAmenities = JSON.parse(listingAmenities)
          } catch (e) {
            console.error('Error parsing amenities:', e)
            listingAmenities = []
          }
        }

        if (Array.isArray(listingAmenities)) {
          // Ensure amenities catalog is available
          if (amenities.value.length === 0) {
            await fetchAmenities()
          }


          const idType = typeof (amenities.value?.[0]?.amenity_id)
          const toIdType = (id) => (idType === 'string' ? String(id) : Number(id))

          const mappedIds = []
          const notFound = []

          for (const entry of listingAmenities) {
            if (typeof entry === 'number' || (typeof entry === 'string' && /^(\d+)$/.test(entry))) {
              // Already an id (number or numeric string)
              const coerced = toIdType(entry)
              if (!(idType === 'number' && Number.isNaN(coerced))) {
                mappedIds.push(coerced)
              }
              continue
            }

            if (entry && typeof entry === 'object') {
              if ('amenity_id' in entry) {
                mappedIds.push(toIdType(entry.amenity_id))
                continue
              }
              if ('amenity_name' in entry && typeof entry.amenity_name === 'string') {
                const name = entry.amenity_name.trim().toLowerCase()
                const match = amenities.value.find((a) => (a.amenity_name || '').trim().toLowerCase() === name)
                if (match) mappedIds.push(toIdType(match.amenity_id))
                else notFound.push(entry.amenity_name)
                continue
              }
            }

            if (typeof entry === 'string') {
              const name = entry.trim().toLowerCase()
              const match = amenities.value.find((a) => (a.amenity_name || '').trim().toLowerCase() === name)
              if (match) mappedIds.push(toIdType(match.amenity_id))
              else notFound.push(entry)
              continue
            }
          }

          // De-dupe
          selectedAmenities.value = Array.from(new Set(mappedIds))

          if (notFound.length > 0) {
            console.warn('Amenity names not found in catalog:', notFound)
          }
        }
      } else {
        // If no listing_amenities in data, try to fetch them separately
        try {
          const { data: amenityData, error: amenityError } = await useSupabaseClient()
            .from('listing_amenities')
            .select('amenity_id')
            .eq('listing_id', props.updateListingId)

          if (amenityData && amenityData.length > 0) {
            selectedAmenities.value = amenityData.map(item => item.amenity_id)
          }
        } catch (error) {
          console.error('Error fetching listing amenities:', error)
        }
      }

      const images = await ListingService._downloadListingImages(
        props.updateListingId
      )

      
      if (!images || !Array.isArray(images)) {
        console.error('No images returned or invalid format:', images)
        uploadedImages.value = []
        return
      }
      
      uploadedImages.value = images
        .map((url) => {
          if (!url || typeof url !== 'string') return null
          try {
            // Strip query string (signed URLs may use ?X-Amz- or ?x-amz-)
            const pathPart = url.split('?')[0]
            const propertyMatch = pathPart.match(/\/properties\/property-\d+\/(.+)$/)
            const pathAfterProperty = propertyMatch ? propertyMatch[1] : pathPart.split('/properties/property-')[1]?.split(/[?&]/)[0] || pathPart.split('/').pop() || ''
            const imgName = pathAfterProperty.split('/').pop() || pathAfterProperty
            const isThumbnail = imgName.includes('thumbnail')

            let id
            if (isThumbnail) {
              const parts = imgName.split('-')
              id = parseInt(parts[2], 10) || 0
            } else {
              const match = imgName.match(/image-(\d+)/)
              id = match ? parseInt(match[1], 10) : 0
            }

            return {
              id: Number.isNaN(id) ? 0 : id,
              name: imgName,
              dataUrl: url,
              extension: imgName.split('.').pop() || 'jpg',
              thumbnail: isThumbnail,
            }
          } catch (e) {
            console.warn('Skipping malformed image URL:', url?.slice(0, 80), e)
            return null
          }
        })
        .filter(Boolean)

      // Sort so the actual current thumbnail (filename contains "thumbnail") is first
      uploadedImages.value.sort((a, b) => {
        if (a.thumbnail && !b.thumbnail) return -1
        if (!a.thumbnail && b.thumbnail) return 1
        return (a.id ?? 0) - (b.id ?? 0)
      })

      // Set selected thumbnail to the actual current thumbnail (same one used by get-thumbnail API)
      const currentThumbnail = uploadedImages.value.find((img) => img.thumbnail)
      if (currentThumbnail) {
        selectedThumbnailId.value = Number(currentThumbnail.id)
      } else if (uploadedImages.value.length > 0) {
        selectedThumbnailId.value = Number(uploadedImages.value[0].id)
      }



      // Set the selected contact if the listing has a contact_id
      if (data.contact_id) {
        const contactOption = contactOptions.value.find(
          (contact) => contact.value === data.contact_id
        )
        if (contactOption) {
          selectedContact.value = contactOption
        } else {
          console.warn(
            'Contact not found in available options for ID:',
            data.contact_id
          )
        }
      }
    }
  }
})

// Ensure form is populated when parent updates props after mount
watch(
  () => [props.updateListingId, props.listingData],
  async ([newId, newListing]) => {
    if (!newId) return
    let data = newListing
    if (!data) {
      const nuxtApp = useNuxtApp()
      // Reads from `listing_details` (canonical wide read source).
      const { data: fetchedData } = await useSupabaseClient()
        .from('listing_details')
        .select('*')
        .eq('listing_id', newId)
        .single()
      data = fetchedData
    }
    if (data) {
      form.value.unit_number = data.unit_number
      form.value.title = data.title
      form.value.description = data.description
      form.value.status = data.status
      form.value.availability_date = data.availability_date
      form.value.for_sale = data.for_sale
      form.value.for_rent = data.for_rent
      form.value.property_id = data.property_id
      form.value.property_category = data.property_category
      form.value.property_type = data.property_type
      form.value.building_name = data.property_name
      form.value.street_address = data.street_address
      // Joined relation first, legacy column as fallback. See onMounted block above.
      form.value.city_name = data.city?.name ?? data.city_name ?? ''
      form.value.barangay_name = data.barangay?.name ?? data.barangay_name ?? ''
      if (data.city_id != null) {
        form.value.city_id = data.city_id
      }
      if (data.barangay_id != null) {
        form.value.barangay_id = data.barangay_id
      }
      form.value.is_online = data.is_online
      form.value.sale_price = data.sale_price
      form.value.rent_price = data.rent_price
      form.value.sale_price_per_sqm = data.sale_price_per_sqm
      form.value.rent_price_per_sqm = data.rent_price_per_sqm
      form.value.condition = data.condition
      form.value.bedrooms = data.bedrooms
      form.value.bathrooms = data.bathrooms
      form.value.floor_area = data.floor_area
      form.value.lot_area = data.lot_area
      form.value.parking_spaces = data.parking_spaces
      form.value.lease_term = data.lease_term
      form.value.rent_advance = data.rent_advance
      form.value.security_deposit = data.security_deposit
      form.value.association_dues = data.association_dues
      form.value.remarks = data.remarks || ''
      form.value.created_by = data.created_by
      form.value.created_at = data.created_at
      form.value.amenities = data.listing_amenities

      // Prefill city/barangay selectors for non-building types. Prefer the
      // FK; fall back to a label match for legacy rows that pre-date the
      // city_id / barangay_id columns.
      if (!selectedCity.value) {
        let cityOption = null
        if (form.value.city_id != null) {
          cityOption = cityOptions.value.find((c) => c.city_id === form.value.city_id)
        }
        if (!cityOption && form.value.city_name) {
          cityOption = cityOptions.value.find((c) => c.label === form.value.city_name)
        }
        if (cityOption) {
          selectedCity.value = cityOption
          form.value.city_id = cityOption.city_id
        }
      }
      if (!selectedBarangay.value) {
        let brgyOption = null
        if (form.value.barangay_id != null) {
          brgyOption = barangayOptions.value.find((b) => b.value === form.value.barangay_id)
        }
        if (!brgyOption && form.value.barangay_name) {
          brgyOption = barangayOptions.value.find((b) => b.label === form.value.barangay_name)
        }
        if (brgyOption) {
          selectedBarangay.value = brgyOption
          form.value.barangay_id = brgyOption.value
        }
      }

      // Prefill contact selector — FK only. The contact_name fallback was
      // removed because data.contact?.full_name (the joined relation) is the
      // source of truth, and legacy contact_name strings can collide with
      // multiple contacts (label match was lossy).
      if (!selectedContact.value && data.contact_id) {
        const opt = contactOptions.value.find((o) => o.value === data.contact_id)
        if (opt) selectedContact.value = opt
      }

      // Done initializing
      isInitializing.value = false
    }
  },
  { immediate: false }
)

import { useListingsRawAtom } from '~/store'
import { useListingColumnsAtom } from '~/store'
import { useJustCreatedListingStore } from '~/store'
const { listings, pushListing } = useListingsRawAtom()
const { buildColumns, listingColumnsData } = useListingColumnsAtom()
const { pushJustCreatedListing } = useJustCreatedListingStore()

function addTestListing() {
  const listing = {
    association_dues: null,
    availability_date: null,
    barangay_id: 2,
    barangay_name: 'Legaspi Village',
    barangay_slug: 'legaspi-village',
    bathrooms: 0,
    bedrooms: 0,
    category: 'residential',
    city_id: 1,
    city_name: 'Makati',
    city_slug: 'makati',
    condition: 'fully-furnished',
    contact_designation: null,
    contact_email: null,
    contact_home_phone: null,
    contact_id: null,
    contact_link: null,
    contact_mobile_number: null,
    contact_name: null,
    contact_notes: null,
    contact_owner_user_id: null,
    coord: null,
    created_at: '2025-03-24T15:37:08+00:00',
    created_by: 'fe8e26bd-62a8-4bd1-b221-de5fc96a9df2',
    description: '',
    developer_name: null,
    floor_area: 222,
    for_rent: true,
    for_sale: false,
    image_extension: null,
    image_name: null,
    is_online: false,
    is_online: false,
    lease_term: null,
    listing_amenities: null,
    listing_id: 57609,
    lot_area: null,
    parking_spaces: 0,
    property_amenities: null,
    property_category: 'residential',
    property_id: 5,
    property_name: 'Greenbelt Excelsior',
    property_slug: 'greenbelt-excelsior',
    property_type: 'condo',
    rent_advance: 1,
    rent_price: 2222,
    rent_price_per_sqm: 10,
    sale_price: null,
    sale_price_per_sqm: null,
    security_deposit: 2,
    status: 'available',
    street_address: '105 Don Carlos Palanca',
    thumbnail: '',
    title: 'Andrei Andrei Andrei',
    unit_number: '',
    updated_at: '2025-04-04T15:37:08+00:00',
    updated_by: 'fe8e26bd-62a8-4bd1-b221-de5fc96a9df2',
    year_built: null,
  }
  const listing_data = {
    listing_id: listing.listing_id,
    title: listing.title,
    thumbnail: listing.thumbnail,
    is_online: listing.is_online,
    column_name: 'Listing',
  }

  const price = {
    sale_price: listing.sale_price ? listing.sale_price : null,
    rent_price: listing.rent_price ? listing.rent_price : null,
    column_name: 'Price',
  }

  const price_per_sqm = {
    sale_price_per_sqm: listing.sale_price_per_sqm
      ? listing.sale_price_per_sqm
      : null,
    rent_price_per_sqm: listing.rent_price_per_sqm
      ? listing.rent_price_per_sqm
      : null,
    column_name: 'P/Sqm',
  }

  const condition = {
    value: listing.condition,
    column_name: 'Condition',
  }

  const city = {
    value: listing.city_name,
    city_slug: listing.city_slug,
    column_name: 'City',
  }

  const availability = {
    value: listing.availability_date,
    column_name: 'Availability',
  }

  const designation = {
    value: listing.contact_designation,
    column_name: 'Designation',
  }

  const contact = {
    name: listing.contact_name,
    designation: listing.contact_designation,
    email: listing.contact_email,
    home_phone: listing.contact_home_phone,
    mobile_number: listing.contact_mobile_number,
    column_name: 'Contact',
  }

  const bedrooms = {
    value: listing.bedrooms,
    column_name: 'Bedrooms',
  }

  const bathrooms = {
    value: listing.bathrooms,
    column_name: 'Bathrooms',
  }

  const floor_area = {
    value: listing.floor_area,
    column_name: 'Floor Area',
  }

  const lot_area = {
    value: listing.lot_area,
    column_name: 'Lot Area',
  }

  const parking_spaces = {
    value: listing.parking_spaces,
    column_name: 'Parking Spaces',
  }

  const type = {
    value: listing.type,
    column_name: 'Type',
  }

  const actions = {
    column_name: 'Actions',
  }

  const category = {
    value: listing.category,
    column_name: 'Category',
  }

  const created_at = {
    value: listing.created_at,
    column_name: 'Created At',
  }

  pushJustCreatedListing({
    listing_data,
    price,
    price_per_sqm,
    condition,
    city,
    availability,
    designation,
    contact,
    bedrooms,
    bathrooms,
    floor_area,
    lot_area,
    parking_spaces,
    type,
    actions,
    category,
    created_at,
    just_created: true,
  })
}

async function fetchAmenities() {
  const nuxtApp = useNuxtApp()
  let queryBuilder = useSupabaseClient().from('amenities_usage').select('*')

  switch (form.value.category) {
    case 'residential':
      queryBuilder = queryBuilder.gt('residential_listings', 0)
      break
    case 'commercial':
      queryBuilder = queryBuilder.gt('commercial_listings', 0)
      break
    default:
      queryBuilder = queryBuilder.gt('residential_listings', 0)
      queryBuilder = queryBuilder.gt('commercial_listings', 0)
      break
  }

  const { data, error } = await queryBuilder

  amenities.value = data

  if (error) {
    console.error('Error fetching amenities:', error)
  }
  amenities.value = data
}

function toggleAmenity(amenity) {
  //check if amenity is already in the array
  if (selectedAmenities.value.includes(amenity)) {
    selectedAmenities.value = selectedAmenities.value.filter(
      (a) => a !== amenity
    )
  } else {
    selectedAmenities.value.push(amenity)
  }
}

async function setThumbnail(imageId) {
  // Just update the visual selection - don't actually change the thumbnail yet
  selectedThumbnailId.value = Number(imageId)

  showToast({
    title:
      'Thumbnail selection updated. Changes will be applied when you save the listing.',
    icon: 'info',
  })
}

async function refreshUploadedImages() {
  if (!props.updateListingId) return

  try {
    // Download the latest images from storage
    const images = await ListingService._downloadListingImages(
      props.updateListingId
    )
    
    if (!images || !Array.isArray(images)) {
      console.error('No images returned or invalid format:', images)
      uploadedImages.value = []
      return
    }
    
    uploadedImages.value = images
      .map((url) => {
        if (!url || typeof url !== 'string') return null
        try {
          const pathPart = url.split('?')[0]
          const propertyMatch = pathPart.match(/\/properties\/property-\d+\/(.+)$/)
          const pathAfterProperty = propertyMatch ? propertyMatch[1] : pathPart.split('/properties/property-')[1]?.split(/[?&]/)[0] || pathPart.split('/').pop() || ''
          const imgName = pathAfterProperty.split('/').pop() || pathAfterProperty
          const isThumbnail = imgName.includes('thumbnail')
          let id
          if (isThumbnail) {
            const parts = imgName.split('-')
            id = parseInt(parts[2], 10) || 0
          } else {
            const match = imgName.match(/image-(\d+)/)
            id = match ? parseInt(match[1], 10) : 0
          }
          return {
            id: Number.isNaN(id) ? 0 : id,
            name: imgName,
            dataUrl: url,
            extension: imgName.split('.').pop() || 'jpg',
            thumbnail: isThumbnail,
          }
        } catch (e) {
          console.warn('Skipping malformed image URL:', url?.slice(0, 80), e)
          return null
        }
      })
      .filter(Boolean)

    // Sort so current thumbnail is first (matches get-thumbnail API and "Current Thumbnail" label)
    uploadedImages.value.sort((a, b) => {
      if (a.thumbnail && !b.thumbnail) return -1
      if (!a.thumbnail && b.thumbnail) return 1
      return (a.id ?? 0) - (b.id ?? 0)
    })

    // Keep selected thumbnail in sync with actual current thumbnail
    const currentThumb = uploadedImages.value.find((img) => img.thumbnail)
    if (currentThumb) {
      selectedThumbnailId.value = Number(currentThumb.id)
    } else if (uploadedImages.value.length > 0) {
      selectedThumbnailId.value = Number(uploadedImages.value[0].id)
    }

  } catch (error) {
    console.error('Error refreshing uploaded images:', error)
  }
}

function deselectThumbnail() {
  selectedThumbnailId.value = null
  showToast({
    title: 'Thumbnail deselected',
    icon: 'info',
  })
}

function removeNewImage(imageId) {
  // Remove from form.images (newly added images)
  form.value.images = form.value.images.filter((image) => image.id !== imageId)

  // Remove from form.originalImages (newly added original images)
  form.value.originalImages = form.value.originalImages.filter(
    (image) => image.id !== imageId
  )

  // If this was the selected thumbnail, deselect it
  if (selectedThumbnailId.value === imageId) {
    selectedThumbnailId.value = null
  }

}

function scheduleForDeletion(image) {

  // Check if image is already scheduled for deletion
  if (uploadedImagesToBeDeleted.value.some((img) => img.id === image.id)) {
    return // Already scheduled, don't add again
  }

  // Add image to deletion list
  uploadedImagesToBeDeleted.value.push({
    id: image.id,
    name: image.name,
    extension: image.extension,
  })

  // If this is the current thumbnail, auto-select the first available image
  if (image.thumbnail) {
    const remainingUploadedImages = uploadedImages.value.filter(
      (img) =>
        !uploadedImagesToBeDeleted.value.some(
          (deletedImg) => deletedImg.id === img.id
        )
    )

    if (remainingUploadedImages.length > 0) {
      // Auto-select the first remaining uploaded image as thumbnail
      selectedThumbnailId.value = remainingUploadedImages[0].id
    } else {
      // No uploaded images left, check if there are newly added images
      if (form.value.images.length > 0) {
        // Auto-select the first newly added image as thumbnail
        selectedThumbnailId.value = form.value.images[0].id
      } else {
        // No images left at all, clear thumbnail selection
        selectedThumbnailId.value = null
      }
    }
  }
}

function cancelDeletion(imageId) {
  uploadedImagesToBeDeleted.value = uploadedImagesToBeDeleted.value.filter(
    (image) => image.id !== imageId
  )
}

// Computed properties for converted values (always in months)
const advanceInMonths = computed(() => {
  if (form.value.advance_unit === 'years') {
    return form.value.advance * 12
  }
  return form.value.advance
})

const depositInMonths = computed(() => {
  if (form.value.deposit_unit === 'years') {
    return form.value.deposit * 12
  }
  return form.value.deposit
})

const minimumLeaseTermInMonths = computed(() => {
  if (form.value.minimum_lease_term_unit === 'years') {
    return form.value.minimum_lease_term * 12
  }
  return form.value.minimum_lease_term
})
</script>

<template>
  <div class="flex flex-col flex-1 p-4 listing-form overflow-y-auto w-72 sm:w-full h-[85vh]">
    <canvas ref="canvas" style="display: none"></canvas>
    <!-- Add test listing button -->
    <!-- <button @click="addTestListing">Add Test Listing</button> -->
    <ul
      class="hidden mb-9 w-full leading-10 rounded-lg form-tabs sm:flex md:flex lg:flex bg-muted/30"
    >
      <li
        @click="toggleTab(1)"
        :class="
          'flex-1 text-center font-bold rounded-lg ' +
          (step === 1 ? 'bg-primary/10 text-primary' : '')
        "
      >
        Details
      </li>
      <li
        @click="toggleTab(2)"
        :class="
          'flex-1 text-center font-bold rounded-lg ' +
          (step === 2 ? 'bg-primary/10 text-primary' : '')
        "
      >
        Information
      </li>
      <li
        @click="toggleTab(3)"
        :class="
          'flex-1 text-center font-bold rounded-lg ' +
          (step === 3 ? 'bg-primary/10 text-primary' : '')
        "
      >
        Attributes
      </li>
      <li
        @click="toggleTab(4)"
        :class="
          'flex-1 text-center font-bold rounded-lg ' +
          (step === 4 ? 'bg-primary/10 text-primary' : '')
        "
      >
        Amenities
      </li>
      <li
        @click="toggleTab(5)"
        :class="
          'flex-1 text-center font-bold rounded-lg ' +
          (step === 5 ? 'bg-primary/10 text-primary' : '')
        "
      >
        Images
      </li>
    </ul>

    <!-- Step 1: Details -->
    <div v-show="step === 1">
      <div class="grid-cols-2 gap-4 w-full sm:grid">
        <!-- Category - only show for condo type -->
        <div class="flex gap-3 items-center mb-4" v-if="!isHouseType">
          <!-- <label class="text-sm font-medium text-foreground min-w-[100px]">Category:</label> -->
          <div
            v-for="(category, categoryIndex) in building_categories"
            :key="categoryIndex"
          >
            <div
              class="px-1.5 py-1 rounded-lg"
              :class="form.category == category.value ? 'bg-primary/10' : ''"
            >
              <input
                type="radio"
                :id="`category-${category.value}`"
                name="category"
                class="hidden cursor-text"
                v-model="form.category"
                :value="category.value"
                @change="getBuildingsList(category.value, form.building_type)"
              />
              <label
                :for="`category-${category.value}`"
                class="flex items-center cursor-pointer"
              >
                <span
                  class="block mr-2 w-4 h-4 rounded-full border"
                  :class="
                    form.category == category.value
                      ? 'bg-blue border-blue shadow-checkbox'
                      : 'border-gray-401'
                  "
                ></span>
                <span class="text-sm font-medium">{{ category.name }}</span>
              </label>
            </div>
          </div>
        </div>

        <!-- Listing Type -->
        <div class="flex gap-3 items-center mb-4">
          <div class="flex gap-4 items-center">
            <div
              class="px-1.5 py-1 rounded-lg"
              :class="form.for_sale ? 'bg-primary/10' : ''"
            >
              <label class="flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  class="hidden"
                  v-model="form.for_sale"
                  :true-value="1"
                  :false-value="0"
                />
                <span
                  class="block mr-2 w-4 h-4 rounded border"
                  :class="
                    form.for_sale ? 'bg-blue border-blue' : 'border-gray-401'
                  "
                ></span>
                <span class="text-sm font-medium">Sale</span>
              </label>
            </div>

            <div
              class="px-1.5 py-1 rounded-lg"
              :class="form.for_rent ? 'bg-primary/10' : ''"
            >
              <label class="flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  class="hidden"
                  v-model="form.for_rent"
                  :true-value="1"
                  :false-value="0"
                />
                <span
                  class="block mr-2 w-4 h-4 rounded border"
                  :class="
                    form.for_rent ? 'bg-blue border-blue' : 'border-gray-401'
                  "
                ></span>
                <span class="text-sm font-medium">Rent</span>
              </label>
            </div>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-4 w-full">
        <!-- Type - moved above Building -->
        <div class="mb-2">
          <VSelect
            v-model="form.building_type"
            :clearable="false"
            placeholder="Select type"
            required
            :error="errors.building_type"
            :options="typeOptions"
            label="label"
            :reduce="(item) => item.value"
          >
            Type
          </VSelect>
        </div>

        <!-- Building - only show for building types -->
        <div class="mb-2" v-if="!isNonBuildingType">
          <InputFormField
            v-model="form.building_name"
            placeholder="Select Building"
            required
            label="Building Name"
            @filterOptions="filterBuildingOptions"
            @set-no-dropdown="setNoDropdown"
          >
            <!-- Building Dropdown Menu -->
            <div
              class="absolute z-50 w-full mt-1 bg-card rounded-lg shadow-lg overflow-y-auto max-h-[200px] border border-border"
              v-if="!noDropdown"
            >
              <div
                v-for="option in filteredBuildingOptions"
                :key="option.property_id"
                class="px-3 py-2 text-sm font-medium text-foreground hover:bg-muted cursor-pointer"
                @click="handleBuildingSelection(option.property_id)"
              >
                {{ option.building_name }}
              </div>
            </div>
          </InputFormField>
        </div>

        <!-- Empty div to maintain grid layout when building is hidden -->
        <div class="mb-2" v-if="isNonBuildingType"></div>
      </div>

      <!-- Street Address - editable for non-building types, non-editable for building types -->
      <div class="grid grid-cols-2 gap-4 w-full mb-4">
        <div class="mb-2">
          <!-- For building types, show as non-editable input -->
          <div v-if="!isNonBuildingType">
            <label class="block text-sm font-bold text-foreground mb-2">
              Street Address <span class="text-destructive">*</span>
            </label>
            <input
              id="street_address"
              placeholder="Street address"
              type="text"
              :value="form.street_address"
              disabled
              class="w-full h-10 leading-9 block pl-2 rounded-lg text-sm font-bold placeholder-gray-3 text-foreground border border-solid cursor-not-allowed"
            />
          </div>

          <!-- For non-building types, show as editable input -->
          <Input
            v-else
            id="street_address"
            placeholder="Street address"
            type="text"
            v-model="form.street_address"
            @change="
              (value) => {
                form.street_address = value
              }
            "
            required
            :error="errors.street_address"
            tooltip="A catchy description for the property. (e.g., A fancy 2bedroom condominium in the heart of Makati City)"
          >
            Street Address
          </Input>
        </div>

        <!-- Contact -->
        <div class="mb-2">
          <VSelect
            v-model="selectedContact"
            :options="contactOptions"
            required
            @option:selected="
              (value) => {
                selectedContact = value
              }
            "
          >
            Contact
          </VSelect>
        </div>
      </div>

      <!-- Recommend building link - only show for building types -->
      <div
        v-if="!isNonBuildingType"
        class="text-primary hover:underline cursor-pointer w-full mb-2"
      >
        <a
          href="mailto:info@housinginteractive.com"
          class="text-primary hover:underline"
        >
          Can't find the building you're looking for? Recommend one here
        </a>
      </div>

      <div class="grid grid-cols-2 gap-4 mb-4">
        <!-- City - editable for non-building types, non-editable for building types -->
        <div class="mb-2">
          <!-- For building types, show as non-editable input -->
          <div v-if="!isNonBuildingType">
            <label class="block text-sm font-bold text-foreground mb-2">
              City <span class="text-destructive">*</span>
            </label>
            <input
              id="city_name"
              placeholder="City"
              type="text"
              :value="form.city_name"
              disabled
              class="w-full h-10 leading-9 block pl-2 rounded-lg text-sm font-bold placeholder-gray-3 text-foreground border border-solid cursor-not-allowed"
            />
          </div>

          <!-- For non-building types, show as editable select -->
          <VSelect
            v-else
            v-model="selectedCity"
            :options="cityOptions"
            required
            @option:selected="handleCityChange"
          >
            City
          </VSelect>
        </div>

        <!-- Barangay - only show for non-building types -->
        <div class="mb-2" v-if="isNonBuildingType">
          <VSelect
            v-model="selectedBarangay"
            :options="barangayOptions"
            :clearable="false"
            placeholder="Select barangay"
            required
            :error="errors.barangay_id"
            @option:selected="
              (value) => {
                selectedBarangay = value
                form.barangay_id = value.value
                form.barangay_name = value.label
              }
            "
          >
            Barangay
          </VSelect>
        </div>

        <!-- Area - only show for building types, non-editable -->
        <div class="mb-2" v-if="!isNonBuildingType">
          <label class="block text-sm font-bold text-foreground mb-2">
            Area <span class="text-destructive">*</span>
          </label>
          <input
            id="area_name"
            placeholder="Area"
            type="text"
            :value="form.barangay_name"
            disabled
            class="w-full h-10 leading-9 block pl-2 rounded-lg text-sm font-bold placeholder-gray-3 text-foreground border border-solid cursor-not-allowed"
          />
        </div>
      </div>

      <!-- Online Status Toggle -->
      <div class="mb-6" v-if="userCanEditListing">
        <div class="flex items-center mb-2">
          <span class="text-sm font-bold text-foreground mr-2"
            >Turn listing online / offline</span
          >
          <span class="text-destructive">*</span>
        </div>
        <div class="flex gap-4 items-center">
          <div
            class="px-3 py-2 rounded-lg"
            :class="form.is_online ? 'bg-primary/10' : ''"
          >
            <label class="flex items-center cursor-pointer">
              <input
                type="radio"
                name="is_online"
                class="hidden"
                v-model="form.is_online"
                :value="true"
              />
              <span
                class="block mr-2 w-4 h-4 rounded-full border"
                :class="
                  form.is_online === true
                    ? 'bg-blue border-blue shadow-checkbox'
                    : 'border-gray-401'
                "
              ></span>
              <span class="text-sm font-medium">Online</span>
            </label>
          </div>
          <div
            class="px-3 py-2 rounded-lg"
            :class="form.is_online === false ? 'bg-primary/10' : ''"
          >
            <label class="flex items-center cursor-pointer">
              <input
                type="radio"
                name="is_online"
                class="hidden"
                v-model="form.is_online"
                :value="false"
              />
              <span
                class="block mr-2 w-4 h-4 rounded-full border"
                :class="
                  form.is_online === false
                    ? 'bg-blue border-blue shadow-checkbox'
                    : 'border-gray-401'
                "
              ></span>
              <span class="text-sm font-medium">Offline</span>
            </label>
          </div>
        </div>
      </div>
    </div>

    <!-- Step 2: Information -->
    <div v-show="step === 2">
      <div class="grid grid-cols-4 gap-4 mb-4 w-full">
        <!-- Unit Number -->
        <div class="col-span-2 mb-2">
          <Input
            id="unit_number"
            :placeholder="isServicedOffice ? 'Suite number' : 'Unit number'"
            type="text"
            v-model="form.unit_number"
            @change="
              (value) => {
                form.unit_number = value
              }
            "
            :error="errors.unit_number"
            tooltip="This is for internal purposes only, will not appear in the site. (e.g 24E, Unit 3102)"
          >
            {{ isServicedOffice ? 'Suite number' : 'Unit number' }}
          </Input>
        </div>

        <!-- Title -->
        <div class="col-span-2 mt-2 mb-2">
          <Input
            id="name"
            placeholder="Property title"
            type="text"
            v-model="form.title"
            @change="
              (value) => {
                form.title = value
              }
            "
            required
            :error="errors.title"
            tooltip="A catchy description for the property. (e.g., A fancy 2bedroom condominium in the heart of Makati City)"
          >
            Listing Title
          </Input>
        </div>

        <!-- Status -->
        <div class="col-span-2 mb-2">
          <VSelect
            v-model="form.status"
            :clearable="false"
            placeholder="Select status"
            required
            :error="errors.status"
            :options="listing_statuses"
            label="name"
            :reduce="(item) => item.value"
          >
            Listing Status
          </VSelect>
        </div>

        <!-- Availability -->
        <div class="col-span-2 mb-2">
          <label class="text-sm font-bold text-foreground">Availability</label>
          <span class="text-destructive">*</span>
          <Input
            type="date"
            v-model="form.availability_date"
            @change="
              (value) => {
                form.availability_date = value
              }
            "
          />
        </div>

        <!-- Commercial Only Options -->
        <template v-if="isCommercial">
          <!-- Building Class -->
          <div class="col-span-2 mb-2">
            <Input
              id="commercial_building_class"
              placeholder="e.g., Class A"
              type="text"
              v-model="form.commercial_building_class"
              @change="
                (value) => {
                  form.commercial_building_class = value
                }
              "
              :error="errors.commercial_building_class"
              >Building Class</Input
            >
          </div>

          <!-- Developer -->
          <div class="col-span-2 mb-2">
            <Input
              id="commercial_developer"
              placeholder="e.g., DCMI"
              type="text"
              v-model="form.commercial_developer"
              @change="
                (value) => {
                  form.commercial_developer = value
                }
              "
              :error="errors.commercial_developer"
              >Developer</Input
            >
          </div>

          <!-- Commercial (Serviced Office Type) Only Options  -->
          <template v-if="isServicedOffice">
            <!-- Office Floor -->
            <div class="mb-2">
              <Input
                id="commercial_office_floor"
                placeholder="e.g., 11th Floor"
                type="text"
                v-model="form.commercial_office_floor"
                @change="
                  (value) => {
                    form.commercial_office_floor = value
                  }
                "
                required
                :error="errors.commercial_office_floor"
                >Office Floor</Input
              >
            </div>

            <!-- No. of occupants -->
            <div class="mb-2">
              <Input
                id="commercial_occupant_number"
                placeholder="e.g., 1"
                type="number"
                min="1"
                v-model="form.commercial_occupant_number"
                @change="
                  (value) => {
                    form.commercial_occupant_number = value
                  }
                "
                required
                :error="errors.commercial_occupant_number"
                >No. of occupants</Input
              >
            </div>

            <!-- Office Space Type -->
            <div class="mb-2">
              <VSelect
                v-model="form.commercial_office_type"
                :clearable="false"
                placeholder="Select space type"
                required
                :error="errors.commercial_office_type"
                :options="officeSpaceTypeOptions"
                label="text"
                :reduce="(item) => item.value"
                >Office Space Type
              </VSelect>
            </div>

            <!-- Office Setup -->
            <div class="mb-2">
              <VSelect
                v-model="form.commercial_office_setup"
                :clearable="false"
                placeholder="Select setup"
                required
                :error="errors.commercial_office_setup"
                :options="officeSetupOptions"
                label="text"
                :reduce="(item) => item.value"
                >Office Setup</VSelect
              >
            </div>
          </template>

          <!-- Building Name -->
          <!-- <div class="col-span-4 mb-2">
              <Input id="commercial_building_name" placeholder="e.g., LDM Building" type="text"
                v-model="form.commercial_building_name" required :error="errors.commercial_building_name">Building
              Name</Input>
            </div> -->
        </template>
      </div>

      <!-- Des  cription -->
      <div>
        <client-only>
          <div class="col-span-2 mb-2">
            <span class="block mb-2 text-sm font-bold text-foreground"
              >Description</span
            >
            <div
              class="relative flex justify-center items-center p-4 bg-muted rounded-lg h-40 lg:h-[9vw]"
            >
              <textarea
                v-model="form.description"
                placeholder="Enter description here"
                class="bg-muted rounded-lg w-full h-full text-foreground font-medium focus:outline-none placeholder:text-muted-foreground"
              ></textarea>
            </div>
          </div>
        </client-only>
      </div>
    </div>

    <!-- Step 3: Attributes -->
    <div v-show="step === 3">
      <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-4 w-full">
        <template v-if="isForSale">
          <div class="mb-2">
            <InputMoney
              id="sale_price"
              placeholder="e.g., 47000"
              min="0"
              :model-value="form.sale_price"
              @updated="
                (value) => {
                  form.sale_price = value
                }
              "
              required
              :error="errors.sale_price"
            >
              Sale Price
            </InputMoney>
          </div>

          <div class="mb-2">
            <InputMoney
              id="sale_pps"
              placeholder="e.g., 47000"
              min="0"
              :model-value="form.sale_price_per_sqm"
              @updated="(value) => (form.sale_price_per_sqm = value)"
              :error="errors.sale_price_per_sqm"
            >
              Sale Price P/Sqm
            </InputMoney>
            <HelperText v-if="calculatedSalePricePerSqm" class="text-success">
              Auto-calculated: {{ calculatedSalePricePerSqm }}
            </HelperText>
          </div>

          <div class="mb-2">
            <InputMoney
              id="original_sale_price"
              placeholder="e.g., 47000"
              min="0"
              :model-value="form.original_sale_price"
              @updated="(value) => (form.original_sale_price = value)"
              :error="errors.original_sale_price"
              :disabled="price.orig_sale.disable"
            >
              Original Sale Price
            </InputMoney>
          </div>

          <div class="mb-2">
            <InputMoney
              id="original_sale_pps"
              placeholder="e.g., 47000"
              min="0"
              :model-value="form.original_sale_pps"
              :error="errors.original_sale_pps"
              @updated="(value) => (form.original_sale_pps = value)"
              :disabled="price.orig_sale_pps.disable"
            >
              Original Sale Price P/Sqm
            </InputMoney>
          </div>
        </template>

        <template v-if="isForRent">
          <div class="mb-2">
            <InputMoney
              id="rent_price"
              placeholder="e.g., 47000"
              min="0"
              :model-value="form.rent_price"
              @updated="(value) => (form.rent_price = value)"
              required
              :error="errors.rent_price"
              :disabled="price.rent.disable"
            >
              Rental Price
            </InputMoney>
          </div>

          <div class="mb-2" v-if="isCommercial">
            <InputMoney
              id="rent_pps"
              placeholder="e.g., 47000"
              min="0"
              :model-value="form.rent_price_per_sqm"
              @updated="(value) => (form.rent_price_per_sqm = value)"
              :error="errors.rent_price_per_sqm"
              :disabled="price.rent_pps.disable"
            >
              Rental Price P/Sqm
            </InputMoney>
            <HelperText v-if="calculatedRentPricePerSqm" class="text-success">
              Auto-calculated: {{ calculatedRentPricePerSqm }}
            </HelperText>
          </div>

          <div class="mb-2">
            <InputMoney
              id="reduced_rent_price"
              placeholder="e.g., 47000"
              :model-value="form.reduced_rent_price"
              @updated="(value) => (form.reduced_rent_price = value)"
              :error="errors.reduced_rent_price"
              :disabled="price.orig_rent.disable"
            >
              Rental reduced price
            </InputMoney>
          </div>

          <div class="mb-2" v-if="isCommercial">
            <Input
              id="original_rent_pps"
              placeholder="e.g., 47000"
              type="number"
              :model-value="form.original_rent_pps"
              @updated="(value) => (form.original_rent_pps = value)"
              :error="errors.original_rent_pps"
              :disabled="price.orig_rent_pps.disable"
            >
              Original Rental Price P/Sqm
            </Input>
          </div>
        </template>

        <!-- <template v-if="isServicedOffice">
            <div class="mb-2">
              <VSelect v-model="form.price_per" :clearable="false" placeholder="Select price unit" required
                :error="errors.price_per" :options="priceUnitOptions" label="text" :reduce="(item) => item.value">
                Price Per</VSelect>
            </div>

            <div class="mb-2">
              <VSelect v-model="form.price_rate" :clearable="false" placeholder="Select price rate unit" required
                :error="errors.price_rate" :options="priceRateOptions" label="text" :reduce="(item) => item.value">Price
                Type</VSelect>
            </div>

            <div class="mb-2">
              <Input id="discount_percentage" placeholder="e.g., 10" type="number" min="0" max="100"
                v-model="form.discount_percentage" :error="errors.discount_percentage">Discount Percentage</Input>
            </div>
          </template> -->

        <div class="mb-2">
          <Input
            id="floor_area"
            placeholder="e.g., 200"
            type="number"
            min="0"
            step="1"
            :model-value="form.floor_area"
            @change="handleFloorAreaChange"
            required
            :error="errors.floor_area"
            >Floor Area</Input
          >
        </div>

        <template v-if="isForRent">
          <div class="relative">
            <label for="advance" class="mb-2 text-sm font-bold text-foreground"
              >Advance Rental</label
            >
            <div class="flex mb-2">
              <div class="mr-1 w-1/2">
                <Input
                  id="advance"
                  type="number"
                  v-model="form.advance"
                  min="0"
                  :error="errors.advance"
                  error-message-invisible
                />
              </div>
              <div class="ml-1 w-1/2">
                <VSelect
                  v-model="form.advance_unit"
                  :clearable="false"
                  :error="errors.advance_unit"
                  error-message-invisible
                  :options="unitOptions"
                  label="text"
                  :reduce="(item) => item.value"
                />
              </div>
            </div>
            <HelperText
              v-if="!!errors.advance || !!errors.advance_unit"
              invalid
              v-model="errors.advance_unit"
              class="absolute left-3 top-16"
            />
          </div>

          <div class="relative">
            <label for="deposit" class="mb-2 text-sm font-bold text-foreground"
              >Security Deposit</label
            >
            <div class="flex mb-2">
              <div class="mr-1 w-1/2">
                <Input
                  id="deposit"
                  type="number"
                  v-model="form.deposit"
                  min="0"
                  :error="errors.deposit"
                  error-message-invisible
                />
              </div>
              <div class="ml-1 w-1/2">
                <VSelect
                  v-model="form.deposit_unit"
                  :clearable="false"
                  :error="errors.deposit_unit"
                  error-message-invisible
                  :options="unitOptions"
                  label="text"
                  :reduce="(item) => item.value"
                />
              </div>
            </div>
            <HelperText
              v-if="!!errors.deposit || !!errors.deposit_unit"
              invalid
              v-model="errors.deposit"
              class="absolute left-3 top-16"
            />
          </div>
        </template>

        <div class="mb-2">
          <Input
            id="lot_area"
            placeholder="e.g., 200"
            type="number"
            min="0"
            step="1"
            :model-value="form.lot_area"
            @change="handleLotAreaChange"
            :error="errors.lot_area"
            >Lot Area</Input
          >
        </div>

        <template v-if="isResidential">
          <div class="mb-2">
            <Input
              id="bedrooms"
              type="number"
              :model-value="form.bedrooms"
              @change="handleBedroomsChange"
              :error="errors.bedrooms"
              min="0"
              >Bedrooms</Input
            >
          </div>
          <div class="mb-2">
            <Input
              id="bathrooms"
              type="number"
              :model-value="form.bathrooms"
              @change="
                (value) => {
                  form.bathrooms = value
                }
              "
              :error="errors.bathrooms"
              min="0"
              >Bathrooms</Input
            >
          </div>
        </template>

        <template v-if="isResidential || isCommercial">
          <div class="mb-2">
            <!-- <VSelect
              v-model="form.parking_spaces"
              :clearable="false"
              :error="errors.parking_spaces"
              :options="carSpaceOptions"
              label="text"
              :reduce="(item) => item.value"
              >Parking</VSelect
            > -->
            <Input
              id="parking_spaces"
              placeholder="e.g., 200"
              type="number"
              min="0"
              :model-value="form.parking_spaces"
              @change="
                (value) => {
                  form.parking_spaces = value
                }
              "
              :error="errors.parking_spaces"
              >Parking</Input
            >
          </div>
        </template>

        <template v-if="isForRent">
          <div class="relative">
            <label
              for="minimum_lease_term"
              class="mb-2 text-sm font-bold text-foreground"
              >Minimum Lease Term <span class="text-red">*</span></label
            >
            <div class="flex mb-2">
              <div class="mr-1 w-1/2">
                <Input
                  id="minimum_lease_term"
                  type="number"
                  v-model="form.minimum_lease_term"
                  min="0"
                  :error="errors.minimum_lease_term"
                  error-message-invisible
                />
              </div>
              <div class="ml-1 w-1/2">
                <VSelect
                  v-model="form.minimum_lease_term_unit"
                  :clearable="false"
                  :error="errors.minimum_lease_term_unit"
                  error-message-invisible
                  :options="unitOptions"
                  label="text"
                  :reduce="(item) => item.value"
                />
              </div>
              <HelperText
                v-if="
                  !!errors.minimum_lease_term ||
                  !!errors.minimum_lease_term_unit
                "
                invalid
                v-model="errors.minimum_lease_term"
                class="absolute left-3 top-16"
              />
            </div>
          </div>
        </template>

        <div class="mb-2">
          <Input
            id="association_dues"
            placeholder="e.g., 180"
            type="text"
            v-model="form.association_dues"
            :error="errors.association_dues"
            >Association dues/What is CUSA?</Input
          >
        </div>

        <template v-if="isCommercial">
          <div class="mb-2">
            <Input
              id="escalation"
              type="text"
              v-model="form.escalation"
              :error="errors.escalation"
              >Escalation</Input
            >
          </div>

          <div class="mb-2">
            <Input
              id="telcos"
              type="text"
              v-model="form.telcos"
              :error="errors.telcos"
              placeholder="e.g., Multi, PLDT"
              >Telcos</Input
            >
          </div>

          <div class="mb-2">
            <Input
              id="commercial_aircon"
              type="text"
              v-model="form.commercial_aircon"
              :error="errors.commercial_aircon"
              >Aircon</Input
            >
          </div>

          <div class="mb-2">
            <Input
              id="commercial_aircon_operation"
              type="text"
              v-model="form.commercial_aircon_operation"
              :error="errors.commercial_aircon_operation"
              >Aircon Operation</Input
            >
          </div>
        </template>

        <div class="mb-2">
          <Input
            id="slideshare_id"
            type="text"
            v-model="form.slideshare_id"
            :error="errors.slideshare_id"
            placeholder="e.g., hK9wOl86SF2wLM"
            >Slideshare ID</Input
          >
        </div>

        <div class="mb-2">
          <Input
            id="youtube_id"
            type="text"
            v-model="form.youtube_id"
            :error="errors.youtube_id"
            placeholder="e.g., tHSsrWX5EOI"
            >Youtube ID</Input
          >
        </div>

        <template v-if="isForRent">
          <div>
            <label class="mb-2 text-sm font-bold text-foreground">Display</label>
            <div class="flex mb-6">
              <div
                v-for="displayOption in displayOptions"
                :key="displayOption.value"
                class="mr-2.5 h-7"
              >
                <div class="px-1.5 pt-1.5 h-7 rounded-lg bg-primary/10">
                  <input
                    type="checkbox"
                    :id="`display-${displayOption.value}`"
                    name="display"
                    class="hidden"
                    v-model="form.optional_contents"
                    :value="displayOption.value"
                  />
                  <label
                    :for="`display-${displayOption.value}`"
                    class="flex cursor-pointer"
                  >
                    <span
                      class="block mr-2 w-4 h-4 border"
                      :class="
                        form.optional_contents.indexOf(displayOption.value) !==
                        -1
                          ? 'bg-blue border-blue shadow-checkbox'
                          : 'border-gray-401'
                      "
                    ></span>
                    <span class="text-sm font-medium">{{
                      displayOption.text
                    }}</span>
                  </label>
                </div>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- Step 4: Attributes -->
    <div v-show="step === 4">
      <!-- Condition -->
      <div class="mb-9">
        <VSelect
          v-model="form.condition"
          :clearable="false"
          placeholder="Select condition"
          required
          :error="errors.condition"
          :options="conditionsOptions"
          label="label"
          :reduce="(item) => item.value"
        >
          Condition
        </VSelect>
      </div>

      <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-4 w-full">
        <div
          v-for="amenity in amenities"
          :key="amenity.amenity_id"
          class="mr-2.5 h-7"
        >
          <div class="px-1.5 pt-1.5 h-7 rounded-lg bg-primary/10">
            <input
              type="checkbox"
              :id="`amenity-${amenity.amenity_name}`"
              name="amenities"
              class="hidden"
              :key="amenity.amenity_id"
              :checked="selectedAmenities.includes(amenity.amenity_id)"
              @change="toggleAmenity(amenity.amenity_id)"
            />
            <label
              :for="`amenity-${amenity.amenity_name}`"
              class="flex cursor-pointer"
            >
              <span
                class="block mr-2 w-4 h-4 border"
                :class="
                  selectedAmenities.indexOf(amenity.amenity_id) !== -1
                    ? 'bg-blue border-blue shadow-checkbox'
                    : 'border-gray-401'
                "
              ></span>
              <span class="text-sm font-medium">{{
                amenity.amenity_name
              }}</span>
            </label>
          </div>
        </div>
      </div>
      <div class="mt-2">
        <HelperText
          v-if="!!errors.amenities"
          invalid
          v-model="errors.amenities"
        />
      </div>
    </div>

    <!-- Step 5: Image & Remarks -->
    <div v-show="step === 5">
      <div class="my-4 font-bold">Upload your images</div>
      <div
        class="relative flex items-center p-4 bg-muted rounded-lg h-52 lg:h-[9vw] mb-6"
      >
        <div
          class="flex justify-center items-center rounded-lg border-[2px] border-blue border-dashed w-full h-full bg-card"
        >
          <file-pond
            name="images"
            ref="images"
            accepted-file-types="image/jpeg, image/jpg, image/png"
            :allow-multiple="true"
            :files="imagesTemp"
            style-item-panel-aspect-ratio="0.5625"
            label-idle="<span class='text-sm font-bold text-primary whitespace-nowrap'>Drag Your Images</span>"
            :credits="false"
            @updatefiles="handleFilesUpdated"
            @removefile="handleFileRemove"
            class="filepond-container"
          />
        </div>
      </div>

      <!-- List of uploaded images -->
      <div class="flex flex-col gap-5 inline-block mb-5">
        <div v-if="form.images.length > 0" class="w-full mb-2">
          <span class="font-bold"
            >Newly added images: {{ form.images.length }}</span
          >
        </div>
        <div class="flex flex-wrap max-h-[16vw] gap-5 inline-block mb-5 overflow-x-auto">
          <div
            v-for="image in form.images"
            :key="image.id"
            class="relative rounded-lg overflow-hidden max-w-[200px] max-h-[200px]"
          >
            <div>
              <span
                v-if="selectedThumbnailId === image.id"
                class="font-bold text-primary border border-blue border-dashed rounded-lg px-2 py-1 bg-primary/10 text-xs cursor-pointer"
                @click="deselectThumbnail()"
                >Selected Thumbnail</span
              >
              <span
                v-else
                class="cursor-pointer font-bold text-muted-foreground border border-border border-dashed rounded-lg px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground"
                @click="setThumbnail(image.id)"
                >Set Thumbnail</span
              >
              <div class="w-full relative rounded-lg mt-2">
                <img
                  v-watermark="{
                    mode: 'bottomright',
                    text: 'HOUSING INTERACTIVE',
                    color: 'rgba(255, 0, 0, 1)',
                  }"
                  :src="image.dataUrl"
                  alt="Image"
                  class="w-full max-w-[10vw] h-full object-cover rounded-lg"
                />
              </div>
              <span
                class="text-destructive cursor-pointer hover:underline text-xs mt-1 block"
                @click="removeNewImage(image.id)"
                >Remove</span
              >
            </div>
          </div>
        </div>
      </div>
      <div
        v-if="!!props.updateListingId"
        class="flex flex-wrap max-h-[16vw] gap-5 inline-block mb-5"
      >
        <span class="w-full font-bold"
          >Already uploaded images: {{ uploadedImages.length }}</span
        >
        <div
          class="flex flex-col justify-end gap-2"
          v-for="uploadedImage in uploadedImages"
          :key="uploadedImage.name"
        >
          <div>
            <span
              v-if="
                uploadedImage.thumbnail &&
                selectedThumbnailId === uploadedImage.id
              "
              class="font-bold text-muted-foreground/70 border border-border border-dashed rounded-lg px-2 py-1"
              >Current Thumbnail</span
            >
            <span
              v-else-if="selectedThumbnailId === uploadedImage.id"
              class="font-bold text-primary border border-blue border-dashed rounded-lg px-2 py-1 bg-primary/10 cursor-pointer text-xs"
              @click="deselectThumbnail()"
              >Selected Thumbnail</span
            >
            <span
              v-else-if="uploadedImage.thumbnail"
              class="font-bold text-foreground border border-border border-dashed rounded-lg px-2 py-1"
              >Active Thumbnail</span
            >
            <span
              v-else-if="
                !uploadedImagesToBeDeleted.some(
                  (image) => image.id === uploadedImage.id
                )
              "
              class="cursor-pointer font-bold text-muted-foreground border border-border border-dashed rounded-lg px-2 py-1 text-xs"
              @click="setThumbnail(uploadedImage.id)"
              >Set Thumbnail</span
            >
            <div class="w-full h-3/4 relative rounded-lg mt-2">
              <div
                v-if="
                  uploadedImagesToBeDeleted.some(
                    (image) => image.id === uploadedImage.id
                  )
                "
                id="overlay"
                class="absolute top-0 left-0 w-full h-full cursor-pointer bg-destructive opacity-70 flex justify-center items-center"
              >
                <span class="text-center text-xl font-bold text-white"
                  >SCHEDULED <br />
                  FOR DELETION</span
                >
              </div>
              <img
                :src="uploadedImage.dataUrl"
                alt="Image"
                class="min-w-[6vw] h-[6vw] object-cover rounded-lg"
              />
            </div>
            <span
              v-if="
                !uploadedImagesToBeDeleted.some(
                  (image) => image.id === uploadedImage.id
                )
              "
              class="text-destructive cursor-pointer hover:underline"
              @click="scheduleForDeletion(uploadedImage)"
              >Schedule for Deletion</span
            >
            <span
              v-if="
                uploadedImagesToBeDeleted.some(
                  (image) => image.id === uploadedImage.id
                )
              "
              class="text-primary cursor-pointer hover:underline"
              @click="cancelDeletion(uploadedImage.id)"
              >Cancel Deletion</span
            >
          </div>
        </div>
      </div>

      <!-- Remarks -->
      <div class="mb-6">
        <div class="col-span-2 mb-2">
          <span class="block mb-2 text-sm font-bold text-foreground"
            >Remarks</span
          >
          <div
            class="relative flex justify-center items-center p-4 bg-muted rounded-lg h-36 lg:h-[9vw]"
          >
            <textarea
              v-model="form.remarks"
              placeholder="Enter remarks here"
              class="bg-muted rounded-lg w-full h-full text-foreground font-medium focus:outline-none placeholder:text-muted-foreground resize-none"
            ></textarea>
          </div>
        </div>
      </div>
    </div>

    <span class="block h-12"></span>

    <div class="flex gap-4 flex-col sm:flex-row items-center justify-center mt-auto">
      <button
        type="button"
        class="sm:mr-auto h-9 bg-opacity-20 rounded-lg w-full sm:w-39 bg-green hover:bg-green-dark hover:bg-opacity-30"
        @click="step--"
        v-show="step > 1"
      >
        <span class="inline-block mt-0.5 font-bold text-green">Previous</span>
      </button>
      <button
        type="button"
        class="sm:ml-auto h-9 bg-opacity-20 rounded-lg w-full sm:w-39 bg-green hover:bg-green-dark hover:bg-opacity-30"
        @click="step++"
        v-show="step < 5"
      >
        <span class="inline-block mt-0.5 font-bold text-green">Next</span>
      </button>
      <button
        type="button"
        class="sm:ml-auto h-9 rounded-lg w-full sm:w-39 bg-green"
        @click="save"
        v-show="step === 5"
      >
        <span class="inline-block mt-0.5 font-bold text-white">Save</span>
      </button>
    </div>
  </div>
</template>
<style>
.filepond-container {
  width: 100% !important;
  height: 100% !important;
}

.filepond-container:hover {
  cursor: pointer;
  transition: opacity 0.3s ease-in-out;
  opacity: 0.5;
}

.filepond--root {
  width: 100%;
  height: 100%;
  margin: 0;
}

.filepond--panel-root {
  background-color: transparent;
}

.filepond--drop-label {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
