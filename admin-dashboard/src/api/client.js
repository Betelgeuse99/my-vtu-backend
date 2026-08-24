import axios from 'axios'
import { supabase } from '../lib/supabaseClient'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || '',
})

api.interceptors.request.use(async (config) => {
  const { data: { session } } = await supabase.auth.getSession()
  if (session?.access_token) {
    config.headers.Authorization = `Bearer ${session.access_token}`
  }
  return config
})

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config

    if (error.response?.status === 401 && !original._retry) {
      original._retry = true

      const { data, error: refreshError } = await supabase.auth.refreshSession()
      if (refreshError || !data.session?.access_token) {
        await supabase.auth.signOut()
        window.location.href = '/admin/login'
        return Promise.reject(error)
      }

      original.headers.Authorization = `Bearer ${data.session.access_token}`
      return api(original)
    }

    return Promise.reject(error)
  }
)

export { api }
