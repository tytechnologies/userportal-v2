<template>
  <div class="grid grid-cols-2 gap-4 p-4 max-h-[81vh] overflow-y-auto">
    <div>
      <Input
        id="name"
        type="text"
        :model-value="form.name"
        @change="
          (value) => {
            form.name = value
            errors.name = ''
          }
        "
        required
        :error="errors.name"
        placeholder="Name"
        >Name</Input
      >
    </div>

    <div>
      <VSelect
        id="designation"
        v-model="form.designation"
        :clearable="false"
        placeholder="Select designation"
        required
        :error="errors.designation"
        :options="designations"
        label="label"
        :reduce="(item) => item.value"
        >Designation
      </VSelect>
    </div>

    <div>
      <Input
        id="email"
        type="email"
        :model-value="form.email"
        required
        :error="errors.email"
        placeholder="Email"
        @change="
          (value) => {
            form.email = value
            errors.email = ''
          }
        "
        >Email</Input
      >
    </div>

    <div>
      <Input
        id="mobile"
        type="text"
        :model-value="form.mobile"
        :error="errors.mobile"
        placeholder="Mobile"
        @change="
          (value) => {
            form.mobile = value
            errors.mobile = ''
          }
        "
        >Mobile</Input
      >
    </div>

    <div>
      <Input
        id="landline"
        type="text"
        :model-value="form.landline"
        :error="errors.landline"
        placeholder="Landline"
        @change="
          (value) => {
            form.landline = value
            errors.landline = ''
          }
        "
        >Landline</Input
      >
    </div>

    <div>
      <Input
        id="fb"
        type="text"
        :model-value="form.fb_link"
        :error="errors.fb_link"
        placeholder="Facebook"
        @change="
          (value) => {
            form.fb_link = value
            errors.fb_link = ''
          }
        "
        >FB Link</Input
      >
    </div>

    <div class="col-span-2">
      <Input
        id="note"
        type="text"
        :model-value="form.note"
        placeholder="Note"
        @change="
          (value) => {
            form.note = value
            errors.note = ''
          }
        "
        >Note</Input
      >
    </div>

    <div class="col-span-2 mb-2">
      <ImageUpload v-model="form.avatar" @uploadImage="uploadImage" />
      <div v-if="form.avatar">
        <img class="max-w-[10vw]" :src="form.avatar" alt="Avatar" />
      </div>
      <span
        v-if="form.avatar"
        class="text-sm text-destructive cursor-pointer"
        @click="removeImage"
        >Remove image</span
      >
    </div>

    <div class="col-span-2 flex gap-4 justify-end">
      <Button class="w-[10vw] bg-muted" @click="closeModal">Cancel</Button>
      <Button
        class="w-[10vw]"
        :disabled="!anyTrueVerdict"
        :loading="loading"
        @click="submit"
        >Save</Button
      >
    </div>
  </div>
</template>

<script>
import Input from '~/components/Input.vue'
import Select from '~/components/NewVSelect.vue'
import ImageUpload from '~/components/ImageUpload.vue'
import { showLoading, dismissLoading } from '~/helpers/helpers'
import { updateContactAvatar } from '~/services/contacts/updateContactImage'
import { showToast, showSwal } from '~/helpers/helpers'

export default {
  components: { Input, Select, ImageUpload },
  props: ['currentContact'],
  emits: ['closeModal', 'avatarUpdated'],
  data() {
    return {
      designations: [],
      form: {
        avatar: '',
        name: '',
        designation: '',
        email: '',
        mobile: '',
        landline: '',
        fb_link: '',
        note: '',
      },
      errors: {},
    }
  },
  async created() {
    if (this.currentContact) {
      console.log('this.currentContact: ', this.currentContact)
      this.form.name = this.currentContact.full_name
      this.form.designation = this.currentContact.designation
      this.form.email = this.currentContact.email
      this.form.mobile = this.currentContact.mobile_phone
      this.form.landline = this.currentContact.home_phone
      this.form.fb_link = this.currentContact.link
      this.form.note = this.currentContact.notes
      this.form.avatar = this.currentContact.avatar
    }

    await this.fetchDesignations()

    console.log('this.anyTrueVerdict: ', this.anyTrueVerdict)
  },
  computed: {
    async fetchDesignations() {
      const nuxtApp = useNuxtApp()

      const { data, error } = await useSupabaseClient()
        .from('designations')
        .select('*')

      if (error) {
        console.error('Error fetching designations:', error)
      }

      console.log('designations ~ data: ', data)

      this.designations = data.map((designation) => ({
        label: designation.display_name,
        value: designation.id,
      }))
    },
    newContactName() {
      if (this.currentContact.full_name !== this.form.name) {
        console.log('Name comparison:', {
          current: this.currentContact.full_name,
          form: this.form.name,
        })
        return { verdict: true, name: this.form.name }
      }
      return { verdict: false, name: this.currentContact.full_name }
    },
    newContactDesignation() {
      if (this.currentContact.designation !== this.form.designation) {
        console.log('Avem verdict in designation')
        return { verdict: true, designation: this.form.designation }
      }
      return { verdict: false, designation: this.currentContact.designation }
    },
    newContactEmail() {
      if (this.currentContact.email !== this.form.email) {
        console.log('Avem verdict in email')
        return { verdict: true, email: this.form.email }
      }
      return { verdict: false, email: this.currentContact.email }
    },
    newContactMobile() {
      if (this.currentContact.mobile_phone !== this.form.mobile) {
        console.log('Avem verdict in mobile')
        return { verdict: true, mobile: this.form.mobile }
      }
      return { verdict: false, mobile: this.currentContact.mobile_phone }
    },
    newContactLandline() {
      if (this.form.landline !== this.currentContact.home_phone) {
        console.log('this.form.landline: ', this.form.landline)
        console.log(
          'this.currentContact.home_phone: ',
          this.currentContact.home_phone
        )
        console.log('Landline comparison:', {
          current: this.currentContact.home_phone,
          form: this.form.landline,
        })
        return { verdict: true, landline: this.form.landline }
      }
      return { verdict: false, landline: this.currentContact.home_phone }
    },
    newContactFbLink() {
      if (this.currentContact.link !== this.form.fb_link) {
        console.log('Avem verdict in fb_link')
        return { verdict: true, fb_link: this.form.fb_link }
      }
      return { verdict: false, fb_link: this.currentContact.link }
    },
    newContactNote() {
      if (this.currentContact.notes !== this.form.note) {
        console.log('Avem verdict in note')
        return { verdict: true, note: this.form.note }
      }
      return { verdict: false, note: this.currentContact.notes }
    },
    newContactAvatar() {
      if (this.currentContact.avatar !== this.form.avatar) {
        console.log('Avem verdict in avatar')
        return { verdict: true, avatar: this.form.avatar }
      }
      return { verdict: false, avatar: this.currentContact.avatar }
    },
    anyTrueVerdict() {
      return (
        this.newContactName.verdict ||
        this.newContactDesignation.verdict ||
        this.newContactEmail.verdict ||
        this.newContactMobile.verdict ||
        this.newContactLandline.verdict ||
        this.newContactFbLink.verdict ||
        this.newContactNote.verdict ||
        this.newContactAvatar.verdict
      )
    },
  },
  watch: {
    anyTrueVerdict(newVal) {
      console.log('anyTrueVerdict: ', newVal)
    },
  },
  methods: {
    closeModal() {
      this.$emit('closeModal')
    },
    uploadImage(image) {
      console.log('my image: ', image)
      const reader = new FileReader()
      reader.readAsDataURL(image)
      reader.onload = () => {
        console.log(
          'FileReader result:',
          reader.result.substring(0, 100) + '...'
        )
        this.form.avatar = reader.result
      }
      reader.onerror = (error) => {
        console.error('Error reading image file:', error)
        showSwal({
          title: 'Error',
          html: 'Failed to read image file. Please try again.',
          icon: 'error',
        })
      }
    },
    removeImage() {
      this.form.avatar = ''
    },
    convertFileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onloadend = () => resolve(reader.result)
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
    },
    async submit() {
      showLoading()
      const nuxtApp = useNuxtApp()
      const session = useSupabaseSession()

      useSupabaseClient().auth.setSession({
        access_token: session.value.access_token,
        refresh_token: session.value.refresh_token,
      })

      if (this.newContactEmail.verdict) {
        //update the auth.user full_name
        const { data, error } = await useSupabaseClient().auth.updateUser({
          email: this.newContactEmail.email,
        })

        if (error) {
          showSwal({
            title: 'Error',
            html: error.message,
            icon: 'error',
          })
          dismissLoading()
          return
        }
      }

      if (this.newContactName.verdict) {
        //update the auth.user full_name
        const { data, error } = await useSupabaseClient().auth.updateUser({
          display_name: this.newContactName.name,
        })

        if (error) {
          showSwal({
            title: 'Error',
            html: error.message,
            icon: 'error',
          })
          dismissLoading()
          return
        }
      }

      if (this.newContactAvatar.verdict && this.form.avatar) {
        console.log('Updating avatar with data:', {
          contactId: this.currentContact.id,
          avatarData: this.form.avatar.substring(0, 100) + '...', // Log first 100 chars
          avatarStartsWithDataImage: this.form.avatar.startsWith('data:image/'),
        })
        try {
          await updateContactAvatar(this.currentContact.id, this.form.avatar)
          // Emit event to notify parent component that avatar was updated
          this.$emit('avatarUpdated')
        } catch (error) {
          console.error('Error updating contact avatar:', error)
          showSwal({
            title: 'Error',
            html: 'Failed to update avatar image. Please try again.',
            icon: 'error',
          })
          dismissLoading()
          return
        }
      }

      const { data: contactData, error: contactError } = await useSupabaseClient()
        .from('profiles')
        .update({
          full_name: this.newContactName.verdict
            ? this.newContactName.name
            : this.currentContact.full_name,
          designation: this.newContactDesignation.verdict
            ? this.newContactDesignation.designation
            : this.currentContact.designation,
          email: this.newContactEmail.verdict
            ? this.newContactEmail.email
            : this.currentContact.email,
          contact: this.newContactMobile.verdict
            ? this.newContactMobile.mobile
            : this.currentContact.contact,
          link: this.newContactFbLink.verdict
            ? this.newContactFbLink.fb_link
            : this.currentContact.link,
          notes: this.newContactNote.verdict
            ? this.newContactNote.note
            : this.currentContact.notes,
        })
        .eq('id', this.currentContact.id)

      if (contactError) {
        showSwal({
          title: 'Error',
          html: contactError.message,
          icon: 'error',
        })
      }

      showToast({
        title: 'Contact updated successfully',
        icon: 'success',
      })

      dismissLoading()
    },
  },
}
</script>
