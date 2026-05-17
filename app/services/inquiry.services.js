const HOST = `${process.env.API_URL}`
const cancelTokens = {}
import { apiRoutes } from '~/contants'

export default {
  methods: {
    _store(data) {
      return this.$axios.$post(`${HOST}/${apiRoutes.inquiries}`, data)
    },
  },
}
