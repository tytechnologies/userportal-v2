import { showToast } from '~/helpers/helpers'

// `UseFetchOptions<any>` from "#app" triggered TS2589 (excessively deep
// type instantiation) on Vue/Nuxt's generic recursion — typed as
// `Record<string, any>` since the runtime spread + cast handles shape.
export const useApiFetch = async (url: string, opts: Record<string, any>) => {
  // const user = useSupabaseUser()

  try {
    const apiFetch = $fetch.create({
      onRequest({ options }) {
        options.retry = false
        options.headers = {
          ...options.headers,
          // Authorization: user.value?.access_token ? `Bearer ${user.value.access_token}` : ''
        }
      },
      onResponseError({ response }) {
        showToast({
          title: response?._data?.message ?? response?._data?.error ?? 'Something went wrong!',
          icon: 'warning'
        })
      }
    })

    return await apiFetch(url, { 
      server: false, 
      lazy: true, 
      ...opts 
    } as any)
  } catch (error: any) {
    showToast({
      title: error?.message ?? 'Something went wrong!',
      icon: 'error'
    })
    throw error
  }
}
