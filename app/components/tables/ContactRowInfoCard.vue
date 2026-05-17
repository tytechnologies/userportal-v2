<template>
  <div
    @click="
      () => {
        emit('showListingDetails')
        listingSelected = true
      }
    "
    class="cursor-pointer hover:bg-primary/10 relative flex gap-3 p-2 rounded whitespace-no-wrap text-foreground min-w-[14vw] max-w-[14vw] max-w-[fit-content]"
    :class="{ 'bg-primary/10': listingSelected }"
  >
    <div class="relative h-[4vw] min-w-[4vw]">
      <img
        class="absolute top-0 left-0 w-[100%] h-[100%] rounded-lg"
        :src="thumbnail || '/img/image-loading.gif'"
        alt="Contact Avatar"
      />
    </div>
    <div class="flex flex-col gap-2 justify-center">
      <span
        :class="{
          'text-foreground font-bold text-[1.5em]': contactName.length <= 25,
          'text-foreground font-bold text-[1em]': contactName.length > 25,
        }"
      >
        {{ contactName }}
      </span>
      <span class="text-foreground">ID: {{ props.contact_data.contact_id }}</span>
    </div>
  </div>
</template>

<script lang="ts" setup>
const props = defineProps({
  index: {
    type: Number,
    required: true,
  },
  contact_data: {
    type: Object,
    required: true,
  },
  showOnlineStatus: {
    type: Boolean,
    default: false,
  },
})

const contactName = computed(() => {
  return props.contact_data.contact_name
    ? props.contact_data.contact_name
    : 'No Name'
})

const emit = defineEmits(['changeListingOnlineStatus', 'showListingDetails'])
const listingSelected = ref(false)
const thumbnail = ref('')

// Use the avatar data that's already available from the contact
const updateThumbnail = () => {
  const avatarUrl =
    props.contact_data.avatar || props.contact_data.avatar_url || ''

  console.log('ContactRowInfoCard - contact_data:', props.contact_data)
  console.log('ContactRowInfoCard - avatarUrl:', avatarUrl)

  if (!avatarUrl) {
    console.log('ContactRowInfoCard - No avatar URL, using default')
    thumbnail.value = '/img/hi_logo.svg'
    return
  }

  // If it's a data URL (base64), use it directly
  if (avatarUrl.startsWith('data:')) {
    console.log('ContactRowInfoCard - Using data URL avatar')
    thumbnail.value = avatarUrl
    return
  }

  // If it's a relative path, make it absolute
  if (avatarUrl.startsWith('/')) {
    console.log('ContactRowInfoCard - Using relative path avatar')
    thumbnail.value = avatarUrl
    return
  }

  // If it's an external URL, test if it loads
  console.log('ContactRowInfoCard - Testing external avatar URL:', avatarUrl)
  const img = new Image()
  img.src = avatarUrl
  img.onload = () => {
    console.log('ContactRowInfoCard - Avatar loaded successfully:', avatarUrl)
    thumbnail.value = avatarUrl
  }
  img.onerror = () => {
    console.log(
      'ContactRowInfoCard - Avatar failed to load, using default:',
      avatarUrl
    )
    thumbnail.value = '/img/hi_logo.svg'
  }
}

watch(
  () => props.contact_data,
  () => {
    updateThumbnail()
  },
  { immediate: true, deep: true }
)
</script>

<style></style>
