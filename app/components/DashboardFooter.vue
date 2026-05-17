<template>
  <footer class="p-8 bg-muted min-h-[15vw] px-10">
    <div class="flex justify-between">
      <div class="flex flex-col gap-2">
        <div>
          <span class="text-[#858BA0] font-bold italic">Member since</span> <br />
          <span class="text-[#858BA0]">{{ memberSince }}</span>
        </div>
        <div>
          <span class="text-[#858BA0] font-bold italic">View our</span>
          <a 
            href="/agreement-pdf/PARTNERSHIP AGREEMENT.pdf" 
            target="_blank" 
            class="text-[#858BA0] cursor-pointer hover:underline"
          >
            Partnership Agreement
          </a>
        </div>
      </div>
      <div>
        <span class="text-[#858BA0] font-bold italic">Experience any issues?</span><br />
        <!-- <span class="text-[#858BA0] ">Contact us</span> -->
         <a href="https://hi-web-staging.housinginteractive.com.ph/contact-us" target="_blank" class="text-[#858BA0] ">Contact us</a>
      </div>
    </div>
    <div class="w-full flex justify-center items-center md:h-1/2">
      <BrandLogo class="w-auto h-[3vw]" />
    </div>
  </footer>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { library } from '@fortawesome/fontawesome-svg-core'

import {
  faEnvelope,
  faLocationDot,
  faPhone
} from '@fortawesome/free-solid-svg-icons'

import {
  faFacebookF,
  faInstagram,
  faLinkedinIn,
  faTiktok,
  faTwitter,
  faYoutube
} from '@fortawesome/free-brands-svg-icons'

library.add(
  faEnvelope,
  faFacebookF,
  faInstagram,
  faLinkedinIn,
  faLocationDot,
  faPhone,
  faTiktok,
  faTwitter,
  faYoutube
)

defineProps({
  theme: {
    type: String,
    default: 'primary',
  },
  show: {
    type: Boolean,
  },
})

const memberSince = ref('Loading...')

const formatDate = (dateString) => {
  if (!dateString) return 'N/A'
  
  const date = new Date(dateString)
  const day = String(date.getDate()).padStart(2, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const year = date.getFullYear()
  
  return `${day}.${month}.${year}`
}

const fetchMemberSinceDate = async () => {
  try {
    const user = useSupabaseUser()
    
    if (!user.value) {
      memberSince.value = 'N/A'
      return
    }

    // First, try to get the created_at from the auth user metadata
    if (user.value.created_at) {
      memberSince.value = formatDate(user.value.created_at)
      console.log('Member since (from auth):', memberSince.value)
      return
    }

    // Fallback: use the shared profile cache instead of firing a
    // dedicated round trip. See app/composables/useCurrentProfile.ts —
    // the multi-component fetch storm was a 2026-05-14 smoke-test
    // finding.
    const { profile, refresh } = useCurrentProfile()
    if (!profile.value) await refresh()
    const data = profile.value
    if (data && data.created_at) {
      memberSince.value = formatDate(data.created_at)
    } else {
      memberSince.value = 'N/A'
    }
  } catch (error) {
    console.error('Error in fetchMemberSinceDate:', error)
    memberSince.value = 'N/A'
  }
}

onMounted(() => {
  fetchMemberSinceDate()
})
</script>