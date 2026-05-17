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
      <Button class="w-[10vw] bg-gray-3" @click="closeModal"> Cancel </Button>
      <Button class="w-[10vw]" @click="submit">Update</Button>
    </div>
  </div>
</template>

<script>
import Input from '~/components/Input.vue'
import VSelect from '~/components/NewVSelect.vue'
import ImageUpload from '~/components/ImageUpload.vue'
import Button from '~/components/ui/Button.vue'
import { showLoading, dismissLoading, showToast } from '~/helpers/helpers'
import { updateContact } from '~/services/contacts/updateContact'

export default {
  components: { Input, VSelect, ImageUpload, Button },
  props: ['currentContact', 'editingContact'],
  emits: ['toggleModal', 'contactUpdated'],
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

    console.log('this.editingContact: ', this.editingContact)

    if (this.editingContact) {
      console.log('this.editingContact: ', this.editingContact)
      // Map the contact data to form fields correctly
      this.form.name =
        this.editingContact.contact_name || this.editingContact.full_name || ''
      this.form.designation = this.editingContact.designation || ''
      this.form.email = this.editingContact.email || ''
      this.form.mobile =
        this.editingContact.mobile || this.editingContact.mobile_phone || ''
      this.form.landline =
        this.editingContact.landline || this.editingContact.home_phone || ''
      this.form.fb_link = this.editingContact.link || ''
      this.form.note = this.editingContact.notes || ''
      this.form.avatar = this.editingContact.avatar || ''
      this.form.id = this.editingContact.id
    }
  },
  methods: {
    closeModal() {
      this.$emit('close')
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
      try {
        showLoading()
        const user = useSupabaseUser()
        const ownerUserId = user.value.id

        console.log('form data: ', this.form)

        const result = await updateContact({
          ownerUserId,
          name: this.form.name,
          email: this.form.email,
          designation: this.form.designation,
          mobilePhone: this.form.mobile,
          homePhone: this.form.landline,
          fbLink: this.form.fb_link,
          notes: this.form.note,
          avatarImage: this.form.avatar,
          contactId: this.form.id,
        })

        if (result.success) {
          console.log('Contact updated successfully:', result.data)

          // Show success toast
          showToast({
            title: 'Success',
            message: 'Contact updated successfully',
            icon: 'success',
          })

          this.$emit('contactUpdated', result.data)
        } else {
          throw new Error('Failed to update contact')
        }
      } catch (error) {
        console.error('Error updating contact:', error)
        // Show error message to user
        showToast({
          title: 'Error updating contact',
          message:
            error.message || 'An error occurred while updating the contact',
          icon: 'error',
        })
      } finally {
        dismissLoading()
      }
    },
  },
}
</script>
