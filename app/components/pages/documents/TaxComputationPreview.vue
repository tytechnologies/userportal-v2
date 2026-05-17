<template>
  <div class="embed-responsive">
    <iframe class="embed-responsive-item" :src="url" allowfullscreen></iframe>
  </div>
</template>

<script>
import { apiRoutes } from '~/contants'

export default {
  props: {
    data: Object,
  },

  computed: {
    url() {
      return (
        process.env.API_URL +
        '/' +
        apiRoutes['documents.tax-computation.generate'] +
        '?' +
        this.queryParams()
      )
    },
  },

  methods: {
    queryParams() {
      return Object.keys(this.data)
        .map((key) => `${key}=${encodeURIComponent(this.data[key])}`)
        .join('&')
    },
  },
}
</script>

<style scoped>
.embed-responsive-item {
  width: 100%;
  height: 80vh;
}
</style>
