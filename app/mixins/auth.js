
export default {
  methods: {
    userHasPermissionTo(key) {
      if (!key) {
        return true;
      }
      if (!this.$auth.loggedIn) {
        return true;
      }
      return this.$auth.user.permissions.indexOf(key) !== -1;
    }
  }
}
