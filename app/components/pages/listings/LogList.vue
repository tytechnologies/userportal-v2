<template>
  <div class="p-3" aria-labelledby="menu-button" tabindex="-1">
    <div
      class="overflow-y-auto scrollbar-thin scrollbar-thumb-black-10 scrollbar-thumb-rounded-full"
    >
      <ul class="py-1" role="none" style="height: 350px">
        <li class="pt-1.5 pb-0.5 border-b" v-for="log in logs" :key="log.id">
          <div>{{ log.outcome }}</div>
          <div v-if="log.notes">{{ log.notes }}</div>
          <div class="text-xs text-muted-foreground">
            Initiated By {{ log.user_name }} &#183; {{ log.date }}
          </div>
        </li>
        <li class="pt-1.5 pb-1.5" v-if="!isLoaded">
          <div class="text-center">
            Loading ... <span><font-awesome-icon icon="spinner" spin /></span>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>

<script>
import { apiRoutes } from '~/contants'

export default {
  props: {
    listingId: Number,
  },

  data() {
    return {
      isLoaded: false,
      logs: [],
    }
  },

  methods: {
    purpose(log) {
      return log.purpose == 'Others' ? log.purpose_others : log.purpose
    },

    async fetch() {
      this.logs = await $fetch(
        apiRoutes['listings.logs'].replace(':id', this.listingId)
      )
      this.isLoaded = true
    },
  },

  mounted() {
    this.fetch()
  },
}
</script>
