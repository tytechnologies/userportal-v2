<template>
  <section
    class="fixed inset-0 z-10 overflow-y-auto"
    aria-labelledby="modal-title"
    role="dialog"
    aria-modal="true"
    v-show="isVisible"
  >
    <div
      class="flex items-end justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0"
    >
      <transition
        enter-active-class="duration-300 ease-out"
        enter-from-class="opacity-0"
        enter-to-class="opacity-100"
        leave-active-class="duration-200 ease-in"
        leave-from-class="opacity-100"
        leave-to-class="opacity-0"
      >
        <div
          class="fixed inset-0 transition-opacity bg-card bg-opacity-90"
          aria-hidden="true"
          v-show="isVisible"
        ></div>
      </transition>

      <!-- This element is to trick the browser into centering the modal contents. -->
      <span
        class="hidden sm:inline-block sm:align-middle sm:h-screen"
        aria-hidden="true"
        >&#8203;</span
      >

      <transition
        enter-active-class="duration-300 ease-out"
        enter-from-class="translate-y-4 sm:translate-y-0 sm:scale-95"
        enter-to-class="translate-y-0 opacity-100 sm:scale-100"
        leave-active-class="duration-200 ease-in"
        leave-from-class="translate-y-0 opacity-100 sm:scale-100"
        leave-to-class="translate-y-4 opacity-0 sm:translate-y-0 sm:scale-95"
      >
        <div
          class="inline-block overflow-hidden text-left align-bottom transition-all transform bg-card rounded-lg hi-modal sm:my-8 sm:align-middle sm:max-w-3xl sm:w-full"
          v-show="isVisible"
        >
          <div class="my-8 text-foreground mx-9">
            <div class="flex mb-16">
              <div class="mr-4 text-muted-foreground/70">
                <Account :size="64" />
              </div>
              <div class="flex-1">
                <h3 class="text-lg font-bold"></h3>
                <p class="mb-2 leading-5">Address: {{ hiAddress }}</p>
                <p class="mb-2 leading-5">Telephone: {{ hiTelephone }}</p>
              </div>
              <button
                type="button"
                class="w-8 h-8 my-auto ml-auto text-center rounded-full bg-muted/50 hover:bg-muted"
                @click="close"
              >
                <span
                  class="block w-6 h-6 mx-auto opacity-50 hover:text-foreground hover:opacity-100"
                >
                  <Close class="opacity-inherit" :size="24" />
                </span>
              </button>
            </div>
            <div>
              <h3 class="text-xl font-bold leading-8 text-center">Ask Agent</h3>
              <Input
                id="name"
                type="text"
                class="mb-4"
                v-model="form.name"
                required
                :error="errors.name"
                placeholder="Name"
                >Name</Input
              >
              <Input
                id="email"
                type="email"
                class="mb-4"
                v-model="form.email"
                required
                :error="errors.email"
                placeholder="Email"
                >Email</Input
              >
              <Input
                id="phone"
                type="text"
                class="mb-4"
                v-model="form.phone"
                required
                :error="errors.phone"
                placeholder="Phone"
                >Phone</Input
              >
              <Input
                id="message"
                type="text"
                textarea
                rows="3"
                class="mb-9"
                v-model="form.message"
                required
                :error="errors.message"
                placeholder="Message"
                >Message</Input
              >
              <button
                class="block w-40 py-2 mx-auto font-bold text-white rounded-lg bg-green hover:bg-green-dark"
                @click="send"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      </transition>
    </div>
  </section>
</template>

<script>
import Account from 'vue-material-design-icons/Account.vue'
import Close from 'vue-material-design-icons/Close.vue'
import Input from '~/components/Input.vue'
import { hiAddress, hiTelephone } from '~/contants'
import { apiRoutes } from '~/contants'

export default {
  props: ['value'],
  components: { Account, Close, Input },
  data() {
    return {
      form: {
        name: null,
        email: null,
        phone: null,
        message: null,
      },
      errors: {},
      hiAddress,
      hiTelephone,
    }
  },
  computed: {
    isVisible() {
      return !!this.value
    },
  },
  watch: {
    isVisible(value) {
      if (value) {
        this.form.name = null
        this.form.email = null
        this.form.phone = null
        this.form.message = null
      }
    },
  },
  methods: {
    send() {
      this.$axios
        .$post(
          apiRoutes['public.inquiries'],
          Object.assign(
            { property_id: this.value, referrer: location.href },
            this.form
          )
        )
        .then(() => {
          this.close()
        })
        .catch(({ response }) => {
          if (response.status === 422) {
            const errors = response.data.errors
            for (let key in errors) {
              if (errors.hasOwnProperty(key)) {
                errors[key] = errors[key][0]
              }
            }
            this.errors = errors
          } else {
            alert('Oops. Something went wrong. Please try again later.')
          }
        })
    },
    close() {
      this.$emit('close')
    },
  },
}
</script>
