<template>
  <div class="p-4">
    <div class="grid w-full gap-4 mb-4">
      <div class="mb-2">
        <VSelect
          v-model="form.outcome"
          :clearable="false"
          required
          :options="outcomes"
          >Outcome</VSelect
        >
      </div>
      <div class="mb-2">
        <label class="mb-2 text-sm font-bold text-foreground"> Remarks </label>
        <textarea
          v-model="form.notes"
          class="w-full p-4 text-sm rounded-md bg-muted/50 focus:border-0 border-border"
          rows="5"
        ></textarea>
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
  </div>
</template>

<script>
import { apiRoutes } from '~/contants'
import Input from '~/components/Input.vue'
import VSelect from '~/components/NewVSelect.vue'

export default {
  components: {
    Input,
    VSelect,
  },

  props: {
    listingId: Number,
  },

  data() {
    return {
      outcomes: [],
      form: {
        property_id: this.listingId,
        outcome: 'Successfully Updated',
        notes: null,
      },
    }
  },

  methods: {
    save() {
      this.$axios.$post(apiRoutes['listings.log'], this.form).then(() => {
        this.$emit('submitCallback')
      })
    },

    async fetchSelections() {
      const res = await $fetch(apiRoutes['listings.log.selections'])
      this.outcomes = res.outcomes
    },
  },

  mounted() {
    this.fetchSelections()
  },
}
</script>
