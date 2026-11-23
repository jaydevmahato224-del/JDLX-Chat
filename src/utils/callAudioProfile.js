// Low-data voice profile for calls.
//
// A default WebRTC voice call settles around ~100 kbps Opus, which a weak
// mobile link (2G/3G, congested tower, capped plan) cannot carry: the call
// "connects" but speech arrives late or not at all. Mono capture plus a hard
// ~24 kbps ceiling and in-band FEC keeps voice intelligible there, and the
// quality loss is inaudible for speech on a phone speaker.

export const CALL_AUDIO_MAX_BITRATE = 24000

// Mono capture halves the Opus payload; EC/NS/AGC matter on a phone speaker and
// Android WebView honours these constraints.
export const CALL_AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1
}

export const CALL_OPUS_FMTP = {
  maxaveragebitrate: '24000',
  stereo: '0',
  'sprop-stereo': '0',
  useinbandfec: '1',
  minptime: '10'
}

// Rewrites the Opus `a=fmtp` line of a local description, keeping every other
// parameter the browser put there. Local fmtp is what the encoder obeys, so
// this is where the bitrate ceiling actually takes effect.
export const applyLowDataAudioSdp = (sdp) => {
  if (typeof sdp !== 'string' || !sdp) return sdp
  const rtpmap = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i)
  if (!rtpmap) return sdp
  const pt = rtpmap[1]
  const lineRe = new RegExp('a=fmtp:' + pt + ' ([^\\r\\n]*)')
  const existing = sdp.match(lineRe)
  const merged = new Map()
  if (existing) {
    existing[1].split(';').forEach((pair) => {
      const eq = pair.indexOf('=')
      const key = (eq === -1 ? pair : pair.slice(0, eq)).trim()
      if (key) merged.set(key, eq === -1 ? '' : pair.slice(eq + 1).trim())
    })
  }
  Object.entries(CALL_OPUS_FMTP).forEach(([key, value]) => merged.set(key, value))
  const fmtp =
    'a=fmtp:' + pt + ' ' +
    Array.from(merged, ([key, value]) => (value === '' ? key : key + '=' + value)).join(';')
  if (existing) return sdp.replace(lineRe, fmtp)
  return sdp.replace(/(a=rtpmap:\d+ opus\/48000\/2[^\r\n]*\r?\n)/i, '$1' + fmtp + '\r\n')
}

// Caps the RTP sender itself. Chrome honours whichever of the fmtp ceiling and
// the sender parameter is lower, so this also holds if the SDP is rewritten.
export const applyCallAudioBitrate = async (pc) => {
  if (!pc || typeof pc.getSenders !== 'function') return
  await Promise.all(
    pc.getSenders().map(async (sender) => {
      if (!sender.track || sender.track.kind !== 'audio') return
      try {
        const params = sender.getParameters()
        if (!params.encodings || !params.encodings.length) return
        params.encodings.forEach((encoding) => {
          encoding.maxBitrate = CALL_AUDIO_MAX_BITRATE
        })
        await sender.setParameters(params)
      } catch (e) {
        // Some browsers refuse setParameters before negotiation; the fmtp
        // ceiling in the SDP still applies, so this is not fatal.
      }
    })
  )
}
