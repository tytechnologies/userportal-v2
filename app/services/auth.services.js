export default {
  async resetPassword(email) {
    // For password reset, we need to use resetPasswordForEmail since user is not authenticated
    const { data, error } = await useSupabaseClient().auth.resetPasswordForEmail(
      email,
      {
        redirectTo: 'http://localhost:3000/forgot-password',
      }
    )

    if (error) {
      console.error('Error resetting password:', error)
      throw new Error('Failed to reset password')
    }

    return data
  },
}
