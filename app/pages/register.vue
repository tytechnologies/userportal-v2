<template>
  <div class="lg:flex bg-background text-foreground">
    <aside class="flex flex-col w-full px-10 py-6 bg-card lg:max-w-md lg:h-screen lg:top-0 lg:sticky">
      <LogoLink />

      <div class="flex flex-col flex-1 w-full max-w-sm mx-auto mt-12 overflow-y-auto pb-6">
        <div class="text-center mb-9">
          <h3 class="mb-2 text-xl font-bold whitespace-nowrap">
            Sign Up with Housinginteractive
          </h3>
          <span class="text-muted-foreground">
            Sell or Rent Out Your Property `Hassle-free
          </span>
        </div>

        <form @submit.prevent="register" class="w-full space-y-2">
          <div>
            <Input id="name" type="text" :model-value="form.name" @change="
              (value) => {
                form.name = value
              }
            " required :error="errors.name" placeholder="Name" class="text-left">
            Name
            </Input>
          </div>

          <div>
            <Input id="email" type="email" :model-value="form.email" @change="
              (value) => {
                form.email = value
              }
            " required :error="errors.email" placeholder="Email" class="text-left">
            Email
            </Input>
          </div>

          <div class="relative">
            <div>
              <Input id="password" :type="!showPassword ? 'password' : 'text'" :model-value="form.password" @change="
                (value) => {
                  form.password = value
                }
              " required :error="errors.password" placeholder="password" class="text-left"
                @input="validatePasswords">
              Password
              </Input>
            </div>
            <div class="absolute inset-y-0 right-0 flex items-center pr-2 cursor-pointer" @click="togglePassword">
              <Eye v-if="!showPassword" class="absolute w-6 h-6 right-3 top-8 text-gray-3" />
              <EyeOff v-if="showPassword" class="absolute w-6 h-6 right-3 top-8 text-gray-3" />
            </div>
          </div>

          <div class="relative my-2">
            <div>
              <Input id="passwordConfirmation" :type="!showPasswordConfirm ? 'password' : 'text'"
                :model-value="form.password_confirmation" @change="
                  (value) => {
                    form.password_confirmation = value
                  }
                " required :error="errors.password_confirmation" placeholder="Confirm Password" class="text-left"
                @input="validatePasswords">
              Confirm Password
              </Input>
            </div>
            <div class="absolute inset-y-0 right-0 flex items-center pr-2 cursor-pointer"
              @click="toggleShowPasswordConfirm">
              <Eye v-if="!showPasswordConfirm" class="absolute w-6 h-6 right-3 top-8 text-gray-3" />
              <EyeOff v-if="showPasswordConfirm" class="absolute w-6 h-6 right-3 top-8 text-gray-3" />
            </div>
          </div>

          <div>
            <Input id="contact" type="text" :model-value="form.contact_number" @change="
              (value) => {
                form.contact_number = value
              }
            " required :error="errors.contact_number" placeholder="Contact" class="text-left">
            Contact
            </Input>
          </div>

          <div class="my-2 text-left">
            <VSelect id="designation" v-model="form.designation" :options="designations" :clearable="false"
              placeholder="Designation" :error="errors.designation" label="display_name" :reduce="(option: any) => option.id"
              required>
              Designation
            </VSelect>
          </div>

          <div class="my-4">
            <div class="flex items-start">
              <div class="flex items-center h-5 space-x-2">
                <Checkbox id="terms" v-model:checked="terms" aria-describedby="terms" />

                <label for="terms"
                  class="text-sm font-medium leading-none text-muted-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                  I agree to the terms and Conditions.
                </label>
              </div>
            </div>

            <HelperText v-if="!!errors.terms" invalid v-model="errors.terms" style="top: 1.75rem" />
          </div>

          <Button class="w-full h-12 mb-3"> Sign Up </Button>

          <p class="mb-auto">
            Already got an account?
            <NuxtLink to="/login" class="font-medium"> Login </NuxtLink>
          </p>
        </form>
      </div>
    </aside>
    <Register class="hidden md:block" />
  </div>
</template>

<script setup lang="ts">
// icons
import Eye from 'vue-material-design-icons/Eye.vue'
import EyeOff from 'vue-material-design-icons/EyeOff.vue'

import { dismissLoading, showLoading, showToast } from '~/helpers/helpers'

const supabase = useSupabaseClient()
const user = useSupabaseUser()

definePageMeta({
  layout: 'auth',
})

watchEffect(() => {
  if (user.value) {
    return navigateTo('/dashboard')
  }
})

const showPassword = ref(false)
const showPasswordConfirm = ref(false)
const passwordMismatch = ref(false)
const errors = ref({
  name: '',
  email: '',
  password: '',
  password_confirmation: '',
  contact_number: '',
  designation: '',
  terms: '',
})
const designations = ref<{ name: string; slug: string }[]>([])
const terms = ref(false)

const form = reactive({
  name: '',
  email: '',
  password: '',
  password_confirmation: '',
  contact_number: '',
  designation: '',
})

const togglePassword = () => {
  showPassword.value = !showPassword.value
}

const toggleShowPasswordConfirm = () => {
  showPasswordConfirm.value = !showPasswordConfirm.value
}

const getDesignations = async () => {
  try {
    const { data, error } = await supabase.from('designations').select('*')
    if (error) {
      throw error
    }

    designations.value = data

    console.log('designations data: ', data)
    console.log('designations: ', designations.value)
  } catch (error) {
    console.log('designations error: ', error)
  }
}

const validatePasswords = () => {
  passwordMismatch.value = form.password === form.password_confirmation
}

const register = async () => {
  // console.log('register', terms.value)
  if (!terms.value) {
    showToast({
      title: 'Please agree to the terms and Conditions.',
      icon: 'error',
    })
    return null
  }

  if (!passwordMismatch.value) {
    showToast({
      title: 'Please ensure that your passwords match.',
      icon: 'error',
    })
    return null
  }

  try {
    showLoading()

    const {
      data: { user },
      error: signupError,
    } = await supabase.auth.signUp({
      email: form.email,
      password: form.password,
      options: {
        data: {
          full_name: form.name,
          contact: form.contact_number,
          designation: form.designation,
        },
      },
    })

    console.log('user: ', user)

    if (signupError) {
      console.log('signup error: ', signupError)
      if (signupError.code === 'user_already_exists') {
        showToast({ title: 'User already exists.', icon: 'error' })
        throw signupError
      }
      throw signupError
    }

    showToast({
      title:
        'Registered successfully. Please check your email to confirm your account.',
      icon: 'success',
    })
    navigateTo('/login')
  } catch (error: any) {
    showToast({ title: error.message, icon: 'error' })
    // console.error('Register errors', error)
  } finally {
    dismissLoading()
  }
}

onMounted(() => {
  getDesignations()
})
</script>
