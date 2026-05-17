<template>
  <div class="p-4">
    <!-- Title -->
    <div class="mb-2">
      <client-only>
        <textarea
          v-model="form.remarks"
          class="w-full p-4 text-sm rounded-md bg-muted/50 focus:border-0 border-border"
          rows="10"
        ></textarea>
      </client-only>
    </div>

    <div class="flex mt-auto">
      <button
        type="button"
        class="ml-auto rounded-lg w-39 h-9 bg-green"
        @click="save"
      >
        <span class="inline-block text-white font-bold mt-0.5">Save</span>
      </button>
    </div>
  </div>
</template>

<script>
import Auth from '~/mixins/auth'
import Close from 'vue-material-design-icons/Close.vue'
import HelperText from '~/components/HelperText'
import Input from '~/components/Input.vue'
import listingService from '@/services/listing.services'
import { showLoading, dismissLoading, showToast } from '~/helpers/helpers'
import { apiRoutes } from '~/contants'

import { useListingColumnsAtom } from '~/store'

export default {
  mixins: [Auth, listingService],
  props: {
    listing: Object,
  },
  data() {
    return {
      form: {
        remarks: '',
      },
      errors: {},
      listingColumnsStore: useListingColumnsAtom(),
    }
  },
  components: {
    Close,
    HelperText,
    Input,
  },

  methods: {
    async save() {
      showLoading()
      const nuxtApp = useNuxtApp()
      const supabase = useSupabaseClient()

      const { data, error } = await supabase
        .from('listings')
        .update({ remarks: this.form.remarks })
        .eq('id', this.listing.listing_data.listing_id)

      if (error) {
        console.error(error)
      }

      this.listingColumnsStore.updateListingRemarks(
        this.listing.listing_data.listing_id,
        this.form.remarks
      )

      showToast({
        title: 'Remarks updated successfully.',
        icon: 'success',
      })
      dismissLoading()
    },
  },
  async created() {
    console.log('this.listing: ', this.listing)
    const nuxtApp = useNuxtApp()
    const supabase = useSupabaseClient()

    const { data, error } = await supabase
      .from('listings')
      .select('*')
      .eq('id', this.listing.listing_data.listing_id)
      .single()

    this.form.remarks = data.remarks
  },
}
</script>
