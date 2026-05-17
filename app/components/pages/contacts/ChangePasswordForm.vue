<template>
  <div class="flex items-end justify-center pt-4 px-4 sm:block sm:p-0">
    <div class="px-6 py-6">
      <div class="w-full grid grid-cols-2 gap-4 mb-4">
        <div class="col-span-2 mb-2">
          <Input
            id="old_pass"
            type="password"
            :model-value="form.old_password"
            @change="
              (value) => {
                form.old_password = value
              }
            "
            required
            :error="errors.old_password"
            placeholder="Old Password..."
            >Old Password</Input
          >
          <span
            v-if="errors.old_password !== undefined"
            class="text-destructive text-sm"
          >
            {{ errors.old_password }}
          </span>
        </div>

        <div class="col-span-2 mb-2">
          <Input
            id="new_pass"
            type="password"
            :model-value="form.new_password"
            @change="
              (value) => {
                form.new_password = value
              }
            "
            required
            :error="errors.new_password"
            placeholder="New Password..."
            >New Password</Input
          >
          <span
            v-if="errors.new_password !== undefined"
            class="text-destructive text-sm"
          >
            {{ errors.new_password }}
          </span>
        </div>

        <div class="col-span-2 mb-2">
          <Input
            id="re_pass"
            type="password"
            :model-value="form.new_password_confirm"
            @change="
              (value) => {
                form.new_password_confirm = value
              }
            "
            required
            :error="errors.new_password_confirm"
            placeholder="Confirm New Password..."
            >Confirm New Password</Input
          >
          <span class="text-destructive text-sm">
            {{ errors.new_password_confirm }}
          </span>
        </div>
      </div>
      <div class="flex">
        <button
          type="button"
          class="w-39 h-9 ml-auto bg-green hover:bg-green-dark rounded-lg"
          @click="save"
          :disabled="isSaving"
          :class="{ 'opacity-50 cursor-not-allowed': isSaving }"
        >
          <span
            v-if="!isSaving"
            class="inline-block text-white font-bold mt-0.5"
          >
            Save
          </span>
          <span v-else class="inline-block text-white font-bold mt-0.5">
            Saving...
          </span>
        </button>
      </div>
    </div>
  </div>
</template>

<script>
import authService from '@/services/auth.services'
import Input from '~/components/Input.vue'
import {
  dismissLoading,
  showLoading,
  showSwal,
  showToast,
} from '~/helpers/helpers'

export default {
  mixins: [authService],
  props: {
    closeModal: {
      type: Function,
      required: false,
    },
  },
  emits: ['closeModal'],
  components: { Input },

  data() {
    return {
      formValidated: false,
      isSaving: false,
      form: {
        old_password: null,
        new_password: null,
        new_password_confirm: null,
      },
      errors: {},
    }
  },

  methods: {
    async save() {
      const formValidated = await this.validate()
      this.formValidated = formValidated

      console.log('formValidated: ', this.formValidated)
      console.log('this.isSaving: ', this.isSaving)
      console.log('this.errors: ', this.errors)
      if (formValidated) {
        const session = useSupabaseSession()

        const nuxtApp = useNuxtApp()
        useSupabaseClient().auth.setSession({
          access_token: session.value.access_token,
          refresh_token: session.value.refresh_token,
        })

        showLoading()

        //change password
        const { data, error } = await useSupabaseClient().auth.updateUser({
          password: this.form.new_password,
        })
        console.log('data: ', data)
        console.log('error: ', error)

        if (error) {
          showSwal({
            title: 'Error',
            html: error.message,
            icon: 'error',
          })
          dismissLoading()
          return
        }

        dismissLoading()
        this.$emit('closeModal')
        showToast({ title: 'Password updated successfully.', icon: 'success' })
      }
    },

    onError(error) {
      const response = error.response
      if (response.status === 422) {
        const errors = response.data.errors
        for (let key in errors) {
          if (errors.hasOwnProperty(key)) {
            errors[key] = errors[key][0]
          }
        }
        this.errors = errors
      } else {
        showSwal({
          title: 'Add Listing',
          html: 'Oops. Something went wrong. Please try again later.',
          icon: 'error',
        })
      }
    },

    async validate() {
      let errors = {}

      if (!this.form.old_password) {
        errors.old_password = 'Please enter your old password'
      }

      if (!this.form.new_password) {
        errors.new_password = 'Please enter your new password'
      }

      if (!this.form.new_password_confirm) {
        errors.new_password_confirm = 'Please confirm your new password'
      }

      if (
        errors.old_password ||
        errors.new_password ||
        errors.new_password_confirm
      ) {
        this.errors = errors
        return false
      }

      if (this.form.new_password && this.form.new_password_confirm) {
        if (this.form.new_password !== this.form.new_password_confirm) {
          showSwal({
            title: 'Error',
            html: 'The New password and Confirm new password fields do not match',
            icon: 'error',
          })
          return false
        }
      }

      // Check if the old password is equal to the new password
      if (this.form.old_password === this.form.new_password) {
        showSwal({
          title: 'Error',
          html: 'The old password and new password fields cannot be the same',
          icon: 'error',
        })
        return false
      }

      if (this.form.old_password) {
        this.isSaving = true
        const user = useSupabaseUser()
        const session = useSupabaseSession()

        const nuxtApp = useNuxtApp()
        useSupabaseClient().auth.setSession({
          access_token: session.value.access_token,
          refresh_token: session.value.refresh_token,
        })

        // Check if old password match the current auth.user one
        const { data, error } = await useSupabaseClient().auth.signInWithPassword({
          email: user.value.email,
          password: this.form.old_password,
        })

        // If sign in succeeds, the password was correct
        if (error) {
          this.isSaving = false
          this.errors = errors
          showSwal({
            title: 'Error',
            html: 'The old password is incorrect',
            icon: 'error',
          })
          return false
        }
      }

      return true
    },
  },
}
</script>
