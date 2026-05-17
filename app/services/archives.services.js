const HOST = `${process.env.API_URL}/api`
const cancelTokens = {}
import { apiRoutes } from '~/contants'

export default {
  methods: {
    generateCancelToken(cancelTokenName) {
      cancelTokens[cancelTokenName] = this.$axios.CancelToken.source()
    },

    getCancelToken(tokenName) {
      if (cancelTokens[tokenName] != undefined) {
        cancelTokens[tokenName].cancel()
      }

      this.generateCancelToken(tokenName)

      return cancelTokens[tokenName].token
    },

    _getArchive(id) {
      const token = this.getCancelToken('getArchive')
      return $fetch(apiRoutes.archive + '/' + `${id}`, {
        cancelToken: token,
      })
    },

    _getArchives(params = '') {
      const token = this.getCancelToken('getArchives')
      //return $fetch(`${HOST}/properties${params}`, { cancelToken: cancelTokens[cancelTokenName].token });
      return $fetch(apiRoutes['listings.archives'] + `${params}`, {
        cancelToken: token,
      })
    },

    _deleteListings(id) {
      const token = this.getCancelToken('deleteListings')
      return this.$axios.$delete(`${HOST}/properties/${id}`, {
        cancelToken: token,
      })
    },

    _reactivateListing(id) {
      const token = this.getCancelToken('reactivateListing')
      const body = { _method: 'PATCH' }
      return this.$axios.$post(`${HOST}/properties/${id}/unarchive`, body, {
        cancelToken: token,
      })
    },

    _getSelection() {
      const token = this.getCancelToken('getSelection')
      return $fetch(apiRoutes['listings.selections'], {
        cancelToken: token,
      })
    },

    _changeListingOnlineStatus(id, is_online) {
      const token = this.getCancelToken('changeListingOnlineStatus')
      const body = { _method: 'PATCH', is_online }
      return this.$axios.$post(`${HOST}/properties/${id}/online`, body, {
        cancelToken: token,
      })
    },

    _setAmenity(id, amenity, state) {
      const token = this.getCancelToken('setAmenity')
      const body = { _method: 'PATCH', amenity, state }
      return this.$axios.$post(`${HOST}/properties/${id}/set-amenity`, body, {
        cancelToken: token,
      })
    },

    _remarksUpdate(id, remarks) {
      const token = this.getCancelToken('remarksUpdate')
      const body = { _method: 'PATCH', remarks }
      return this.$axios.$post(`${HOST}/properties/${id}/remarks`, body, {
        cancelToken: token,
      })
    },

    _quickUpdate(id, data) {
      const token = this.getCancelToken('quickUpdate')
      const body = data
      return this.$axios.$post(`${HOST}/properties/${id}/quick-update`, body, {
        cancelToken: token,
      })
    },

    _getSuggestions(params) {
      const token = this.getCancelToken('_getSuggestions')
      return $fetch(apiRoutes.suggestions + `${params}`, {
        cancelToken: token,
      })
    },
  },
}
