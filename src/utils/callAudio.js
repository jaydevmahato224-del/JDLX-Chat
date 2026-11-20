import { Capacitor, registerPlugin } from '@capacitor/core'

// Native counterpart: android/.../CallAudioPlugin.java. Registered lazily so
// the web build (where the plugin does not exist) never calls into it.
const CallAudio = registerPlugin('CallAudio')

export const isNativeCallAudioAvailable = () =>
  typeof window !== 'undefined' && Capacitor?.isNativePlatform?.() === true

export const startNativeCallAudio = async ({ video = false, speaker = true } = {}) => {
  if (!isNativeCallAudioAvailable()) return
  try {
    await CallAudio.start({ video, speaker })
  } catch (e) {
    console.warn('native call audio start failed:', e)
  }
}

export const setNativeSpeaker = async (enabled) => {
  if (!isNativeCallAudioAvailable()) return
  try {
    await CallAudio.setSpeakerphoneOn({ enabled })
  } catch (e) {
    console.warn('native speaker switch failed:', e)
  }
}

export const stopNativeCallAudio = async () => {
  if (!isNativeCallAudioAvailable()) return
  try {
    await CallAudio.stop()
  } catch (e) {
    console.warn('native call audio stop failed:', e)
  }
}
