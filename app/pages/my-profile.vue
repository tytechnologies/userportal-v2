<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import Input from '~/components/Input.vue'
import VSelect from '~/components/NewVSelect.vue'
import ImageUpload from '~/components/ImageUpload.vue'
import Button from '~/components/ui/Button.vue'
import VerificationPanel from '~/components/profile/VerificationPanel.vue'
import { showLoading, dismissLoading, showToast, showSwal } from '~/helpers/helpers'
import { updateContactAvatar } from '~/services/contacts/updateContactImage'
import { getContactAvatar } from '~/services/contacts/getContactImage'

const router = useRouter()
const user = useSupabaseUser()
const nuxtApp = useNuxtApp()

const currentContact = ref(null)
const avatar = ref('')
const designations = ref([])
const loading = ref(false)
const profilePictureInput = ref(null)
const licenseInput = ref(null)

// Agent-licensing fields gate. False by default so Members on the
// basic profile page don't see PRC/HLURB/DTI fields that don't apply.
// Pre-flips to true on mount when the user has any verification row,
// so existing agents don't have to re-toggle every visit.
const showAgentVerification = ref(false)

const form = ref({
    avatar: '',
    name: '',
    designation: '',
    email: '',
    mobile: '',
    landline: '',
    fb_link: '',
    note: '',
})

const errors = ref({})

const fetchContact = async () => {
    try {
        showLoading()

        // Shared profile cache; see app/composables/useCurrentProfile.ts.
        // refresh() forces a re-read since this entry-point is the
        // profile editor and the operator wants current values.
        const { profile, refresh } = useCurrentProfile()
        await refresh()
        const data = profile.value
        const error = !data ? new Error('profile not found') : null

        if (error) {
            console.error('Error fetching profile from database:', error)
            throw new Error(`Database error: ${error.message}`)
        }

        if (!data) {
            console.error('No profile data found for user:', user.value?.email)
            throw new Error('Profile not found')
        }

        let avatarImage = []
        try {
            avatarImage = await getContactAvatar(data.id)
        } catch (avatarError) {
            console.error('Error loading avatar, using default:', avatarError)
        }

        const avatarUrl = (avatarImage && avatarImage.length > 0 ? avatarImage[0] : null) ||
            'https://img.icons8.com/ios/200/user-male-circle.png'

        avatar.value = avatarUrl

        currentContact.value = {
            id: data.id,
            full_name: data.display_name || data.full_name || '',
            designation: data.designation || '',
            email: data.email || '',
            contact: data.contact || '',
            mobile_phone: data.contact || '',
            home_phone: data.home_phone || '',
            link: data.link || '',
            notes: data.notes || '',
            avatar: avatarUrl,
        }

        // Populate form
        form.value.name = currentContact.value.full_name
        form.value.designation = currentContact.value.designation
        form.value.email = currentContact.value.email
        form.value.mobile = currentContact.value.mobile_phone
        form.value.landline = currentContact.value.home_phone
        form.value.fb_link = currentContact.value.link
        form.value.note = currentContact.value.notes
        form.value.avatar = currentContact.value.avatar

        dismissLoading()
    } catch (error) {
        console.error('Error in fetchContact:', error)
        dismissLoading()
        showSwal({
            title: 'Error',
            html: `Failed to load profile data: ${error.message}`,
            icon: 'error',
        })
    }
}

const fetchDesignations = async () => {
    const { data, error } = await useSupabaseClient()
        .from('designations')
        .select('*')

    if (error) {
        console.error('Error fetching designations:', error)
        return
    }

    designations.value = data.map((designation) => ({
        label: designation.display_name,
        value: designation.id,
    }))
}

const triggerProfilePictureUpload = () => {
    profilePictureInput.value?.click()
}

const triggerLicenseUpload = () => {
    licenseInput.value?.click()
}

const handleProfilePictureChange = (event) => {
    const file = event.target.files?.[0]
    if (file) {
        uploadImage(file)
    }
}

const handleLicenseChange = (event) => {
    const file = event.target.files?.[0]
    if (file) {
        // Handle license upload - you can add separate logic here if needed
        console.log('License file selected:', file)
    }
}

const uploadImage = (image) => {
    const reader = new FileReader()
    reader.readAsDataURL(image)
    reader.onload = () => {
        form.value.avatar = reader.result
    }
    reader.onerror = (error) => {
        console.error('Error reading image file:', error)
        showSwal({
            title: 'Error',
            html: 'Failed to read image file. Please try again.',
            icon: 'error',
        })
    }
}

const removeImage = () => {
    form.value.avatar = ''
}

const hasChanges = () => {
    if (!currentContact.value) return false

    return (
        currentContact.value.full_name !== form.value.name ||
        currentContact.value.designation !== form.value.designation ||
        currentContact.value.email !== form.value.email ||
        currentContact.value.mobile_phone !== form.value.mobile ||
        currentContact.value.home_phone !== form.value.landline ||
        currentContact.value.link !== form.value.fb_link ||
        currentContact.value.notes !== form.value.note ||
        currentContact.value.avatar !== form.value.avatar
    )
}

const handleAvatarUpdated = async () => {
    // Shared profile cache. refresh() bypasses the cache for this
    // post-upload re-read; subsequent calls in the same session use
    // the cached row.
    const { profile, refresh } = useCurrentProfile()
    await refresh()
    const data = profile.value
    if (!data) return

    const avatarImage = await getContactAvatar(data.id)

    if (avatarImage.length > 0) {
        avatar.value = avatarImage[0]
        if (currentContact.value) {
            currentContact.value.avatar = avatar.value
        }
    }
}

const submit = async () => {
    loading.value = true
    showLoading()

    const session = useSupabaseSession()

    useSupabaseClient().auth.setSession({
        access_token: session.value.access_token,
        refresh_token: session.value.refresh_token,
    })

    try {
        // Update email if changed
        if (currentContact.value.email !== form.value.email) {
            const { error } = await useSupabaseClient().auth.updateUser({
                email: form.value.email,
            })

            if (error) {
                showSwal({
                    title: 'Error',
                    html: error.message,
                    icon: 'error',
                })
                loading.value = false
                dismissLoading()
                return
            }
        }

        // Update name if changed
        if (currentContact.value.full_name !== form.value.name) {
            const { error } = await useSupabaseClient().auth.updateUser({
                display_name: form.value.name,
            })

            if (error) {
                showSwal({
                    title: 'Error',
                    html: error.message,
                    icon: 'error',
                })
                loading.value = false
                dismissLoading()
                return
            }
        }

        // Update avatar if changed
        if (currentContact.value.avatar !== form.value.avatar && form.value.avatar) {
            try {
                await updateContactAvatar(currentContact.value.id, form.value.avatar)
                await handleAvatarUpdated()
            } catch (error) {
                console.error('Error updating contact avatar:', error)
                showSwal({
                    title: 'Error',
                    html: 'Failed to update avatar image. Please try again.',
                    icon: 'error',
                })
                loading.value = false
                dismissLoading()
                return
            }
        }

        // Update profile in database
        const { error: contactError } = await useSupabaseClient()
            .from('profiles')
            .update({
                display_name: form.value.name,
                designation: form.value.designation,
                email: form.value.email,
                contact: form.value.mobile,
            })
            .eq('id', currentContact.value.id)

        if (contactError) {
            showSwal({
                title: 'Error',
                html: contactError.message,
                icon: 'error',
            })
            loading.value = false
            dismissLoading()
            return
        }

        showToast({
            title: 'Profile updated successfully',
            icon: 'success',
        })

        // Refresh data
        await fetchContact()

    } catch (error) {
        console.error('Error updating profile:', error)
        showSwal({
            title: 'Error',
            html: 'An error occurred while updating your profile.',
            icon: 'error',
        })
    } finally {
        loading.value = false
        dismissLoading()
    }
}

onMounted(async () => {
    await fetchDesignations()
    await fetchContact()
})
</script>

<template>
    <div class="min-h-screen bg-card">
        <div class="container mx-auto px-4 py-8">
            <div class="flex gap-5">
                <!-- Left side - Profile Form -->
                <div class="w-full">
                    <div class="bg-[#FAFAFA] rounded-lg shadow-sm p-6">


                        <div class="flex gap-5">
                            <div class="border-r border-[#C2C9D8] pr-5 flex flex-col justify-center gap-5">
                                <!-- Profile Picture Section -->
                                <div class="mt-6">
                                    <div class="items-start gap-4">
                                        <div class="w-24 h-24 rounded-full overflow-hidden bg-muted flex-shrink-0">
                                            <img v-if="form.avatar" :src="form.avatar" alt="Profile"
                                                class="w-full h-full object-cover" />
                                            <div v-else class="w-full h-full flex items-center justify-center">
                                                <font-awesome-icon icon="user" class="text-3xl text-muted-foreground/70" />
                                            </div>
                                        </div>
                                        <input ref="profilePictureInput" type="file" accept="image/*" class="hidden"
                                            @change="handleProfilePictureChange" />
                                        <Button variant="secondary" @click="triggerProfilePictureUpload"
                                            class="mt-2 bg-primary/10 text-primary">Edit
                                            picture</Button>
                                    </div>
                                </div>

                                <!-- License Section -->
                                <div class="mt-6">
                                    <div class="gap-4">
                                        <div
                                            class="w-32 h-20 bg-muted rounded flex-shrink-0 flex items-center justify-center">
                                            <font-awesome-icon icon="id-card" class="text-2xl text-muted-foreground/70" />
                                        </div>
                                        <input ref="licenseInput" type="file" accept="image/*" class="hidden"
                                            @change="handleLicenseChange" />
                                        <Button variant="secondary" @click="triggerLicenseUpload"
                                            class="mt-2 bg-primary/10 text-primary">Edit
                                            License</Button>
                                    </div>
                                </div>
                            </div>
                            <div class="w-full">
                                <h2 class="text-2xl font-bold mb-6">Agent Profile</h2>
                                <div class="grid grid-cols-1 md:grid-cols-2 gap-4 w-full mb-5">
                                    <div>
                                        <Input id="firstName" type="text" :model-value="form.name?.split(' ')[0] || ''"
                                            @change="(value) => {
                                                const lastName = form.name?.split(' ').slice(1).join(' ') || ''
                                                form.name = lastName ? `${value} ${lastName}` : value
                                                errors.name = ''
                                            }" required :error="errors.name" placeholder="First Name">
                                            First Name
                                        </Input>
                                    </div>

                                    <div>
                                        <Input id="lastName" type="text"
                                            :model-value="form.name?.split(' ').slice(1).join(' ') || ''" @change="(value) => {
                                                const firstName = form.name?.split(' ')[0] || ''
                                                form.name = `${firstName} ${value}`.trim()
                                                errors.name = ''
                                            }" required :error="errors.name" placeholder="Last Name">
                                            Last Name
                                        </Input>
                                    </div>
                                </div>

                                <div class="mb-5">
                                    <Input id="email" type="email" :model-value="form.email" required
                                        :error="errors.email" placeholder="Email" @change="(value) => {
                                            form.email = value
                                            errors.email = ''
                                        }">
                                        E-mail
                                    </Input>
                                </div>

                                <div class="mb-5">
                                    <Input id="mobile" type="text" :model-value="form.mobile" :error="errors.mobile"
                                        placeholder="Phone number" @change="(value) => {
                                            form.mobile = value
                                            errors.mobile = ''
                                        }">
                                        Phone number
                                    </Input>
                                </div>

                                <div class="mb-5">
                                    <Input id="address1" type="text" :model-value="form.fb_link" :error="errors.fb_link"
                                        placeholder="Address 1" @change="(value) => {
                                            form.fb_link = value
                                            errors.fb_link = ''
                                        }">
                                        Address 1
                                    </Input>
                                </div>

                                <div class="mb-5">
                                    <Input id="address2" type="text" :model-value="form.note" placeholder="Address 2"
                                        @change="(value) => {
                                            form.note = value
                                            errors.note = ''
                                        }">
                                        Address 2
                                    </Input>
                                </div>
                            </div>
                        </div>
                        <!-- Save Button -->
                        <div class="mt-6 flex justify-end">
                            <Button class="px-8 bg-blue" :disabled="!hasChanges()" :loading="loading" @click="submit">
                                Save
                            </Button>
                        </div>
                    </div>
                </div>

                <!-- Right side - User Info Card -->
                <div class="w-1/3">
                    <div class="bg-[#FAFAFA] rounded-lg shadow-sm p-6">
                        <div class="flex items-center">
                            <div class="w-20 mr-5 rounded-full overflow-hidden bg-muted mb-4">
                                <img v-if="avatar" :src="avatar" alt="Profile" class="w-full h-full object-cover" />
                                <div v-else class="w-full h-full flex items-center justify-center">
                                    <font-awesome-icon icon="user" class="text-3xl text-muted-foreground/70" />
                                </div>
                            </div>


                            <div class="w-full mt-4 space-y-2">
                                <div class="text-sm">
                                    <p class="font-semibold text-foreground">{{ currentContact?.full_name || 'Loading...'
                                    }}</p>
                                    <p class="text-muted-foreground">{{ form.fb_link || 'N/A' }}</p>
                                    <p class="text-muted-foreground">{{ form.note || '' }}</p>
                                </div>

                                <div class="text-sm">
                                    <p class="font-semibold text-foreground">Telephone:</p>
                                    <p class="text-muted-foreground">{{ form.mobile || 'N/A' }}</p>
                                </div>
                            </div>

                        </div>
                        <Button class="w-full mt-6 bg-green">
                            Ask Agent
                        </Button>
                    </div>
                </div>
            </div>

            <!-- Agent-licensing panel: PRC / HLURB / DTI verification.
                 Hidden behind an explicit "I'm a licensed agent" toggle
                 so Members on the basic profile page don't see fields
                 that don't apply to them. The toggle state is local-
                 only — submitting the verification form is what
                 actually flags the user as agent-track via the
                 listing_verifications table. -->
            <div class="mt-6 rounded-md border border-border bg-card p-4">
                <label class="flex items-start gap-3 cursor-pointer">
                    <input
                        type="checkbox"
                        v-model="showAgentVerification"
                        class="mt-1 h-4 w-4"
                    />
                    <span>
                        <span class="block text-sm font-semibold text-foreground">
                            I'm a licensed real-estate agent / broker
                        </span>
                        <span class="block mt-0.5 text-xs text-muted-foreground">
                            Adds PRC / HLURB / DTI license fields so we can
                            verify your credentials. Leave unchecked if you're
                            using Housing Interactive purely as a buyer or renter.
                        </span>
                    </span>
                </label>
            </div>

            <VerificationPanel v-if="showAgentVerification" />
        </div>
    </div>
</template>
