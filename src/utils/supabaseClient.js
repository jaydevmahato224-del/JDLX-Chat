import { createClient } from '@supabase/supabase-js'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config'

let supabaseInstance = null

export function getSupabase() {
  if (supabaseInstance) return supabaseInstance
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null

  try {
    supabaseInstance = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      realtime: {
        params: {
          eventsPerSecond: 20
        }
      }
    })
    return supabaseInstance
  } catch (err) {
    console.warn('[SUPABASE] Failed to initialize Supabase client:', err)
    return null
  }
}

export const supabase = getSupabase()

/** Set (or clear) the Realtime JWT used for private channels. */
export function setSupabaseRealtimeAuth(token) {
  if (!supabase?.realtime?.setAuth) return false
  try {
    supabase.realtime.setAuth(token || '')
    return Boolean(token)
  } catch {
    return false
  }
}
