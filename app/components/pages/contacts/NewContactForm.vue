<template>
  <div class="grid grid-cols-2 gap-4 p-4">
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
        @update:model-value="
          (value) => {
            form.designation = value
            errors.designation = ''
          }
        "
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
      <Button class="lg:w-[10vw] bg-gray-3" @click="closeModal"> Cancel </Button>
      <Button class="lg:w-[10vw]" @click="submit">Add</Button>
    </div>
  </div>
</template>

<script>
import Input from '~/components/Input.vue'
import VSelect from '~/components/NewVSelect.vue'
import ImageUpload from '~/components/ImageUpload.vue'
import Button from '~/components/ui/Button.vue'
import { showLoading, dismissLoading, showToast } from '~/helpers/helpers'
import { addContact } from '~/services/contacts/addContact'

export default {
  components: { Input, VSelect, ImageUpload, Button },
  props: ['currentContact', 'editingContact'],
  emits: ['toggleModal', 'contactCreated'],
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
  mounted() {
    this.fetchDesignations()
    // Initialize form with empty values for new contact
    this.form = {
      avatar: '',
      name: '',
      designation: '',
      email: '',
      mobile: '',
      landline: '',
      fb_link: '',
      note: '',
    }
  },
  methods: {
    closeModal() {
      this.$emit('close')
    },
    validateForm() {
      this.errors = {}
      let isValid = true

      // Validate name (required)
      if (!this.form.name || this.form.name.trim() === '') {
        this.errors.name = 'Name is required'
        isValid = false
      }

      // Validate designation (required)
      if (!this.form.designation || this.form.designation.trim() === '') {
        this.errors.designation = 'Designation is required'
        isValid = false
      }

      // Validate email (optional but if provided, should be valid format)
      if (this.form.email && this.form.email.trim() !== '') {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
        if (!emailRegex.test(this.form.email)) {
          this.errors.email = 'Please enter a valid email address'
          isValid = false
        }
      }

      // Validate mobile (optional but if provided, should be valid format)
      if (this.form.mobile && this.form.mobile.trim() !== '') {
      }

      // Validate landline (optional but if provided, should be valid format)
      if (this.form.landline && this.form.landline.trim() !== '') {
      }

      return isValid
    },
    uploadImage(image) {
      console.log('my image: ', image)
      const reader = new FileReader()
      reader.readAsDataURL(image)
      reader.onload = () => {
        this.form.avatar = reader.result
      }
    },
    removeImage() {
      this.form.avatar = ''
    },
    resetForm() {
      this.form = {
        avatar: '',
        name: '',
        designation: '',
        email: '',
        mobile: '',
        landline: '',
        fb_link: '',
        note: '',
      }
      this.errors = {}
    },
    convertFileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onloadend = () => resolve(reader.result)
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
    },
    async fetchDesignations() {
      const { data, error } = await useSupabaseClient()
        .from('designations')
        .select('*')

      if (error) {
        console.error('Error fetching designations:', error)
      }

      this.designations = data.map((designation) => ({
        label: designation.display_name,
        value: designation.id,
      }))
    },
    async delete(id) {
      let result = await this._deleteContact(id)

      if (result.success) {
        this.fetch()
      } else {
        Swal.fire({
          title: 'ERROR',
          html: result.error_message,
          confirmButtonColor: '#2F80ED',
        })
      }
    },
    async submit() {
      // Validate form before submitting
      if (!this.validateForm()) {
        // Show error message to user
        showToast({
          title: 'Validation Error',
          message: 'Please fix the errors in the form before submitting',
          icon: 'error',
        })
        return
      }

      showLoading()
      const user = useSupabaseUser()
      const ownerUserId = user.value.id

      console.log('form data: ', this.form)
      const avatarImage = this.form.avatar

      console.log('avatarImage: ', avatarImage)

      try {
        const { data, error } = await addContact({
          ownerUserId,
          name: this.form.name,
          email: this.form.email,
          designation: this.form.designation,
          mobilePhone: this.form.mobile,
          homePhone: this.form.landline,
          fbLink: this.form.fb_link,
          notes: this.form.note,
          avatarImage: avatarImage,
        })

        dismissLoading()

        // Show success toast
        showToast({
          title: 'Success',
          message: 'Contact created successfully',
          icon: 'success',
        })

        // Reset form
        this.resetForm()

        // Emit contact created event
        this.$emit('contactCreated')
      } catch (error) {
        dismissLoading()
        console.error('Error creating contact:', error)

        // Show error toast
        showToast({
          title: 'Error',
          message: error.message || 'Failed to create contact',
          icon: 'error',
        })
      }
    },
  },
}
</script>
