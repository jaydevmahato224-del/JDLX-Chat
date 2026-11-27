import { Bluetooth, Ear, Headphones, Volume2 } from 'lucide-react'
import { CALL_SPEAKER_MODES, normalizeSpeakerMode } from '../utils/callAudio'

const BASE_SPEAKER_OPTIONS = [
  {
    id: CALL_SPEAKER_MODES.LOUD,
    label: 'Loud',
    ariaLabel: 'Switch to loud speaker',
    Icon: Volume2
  },
  {
    id: CALL_SPEAKER_MODES.EAR,
    label: 'Ear',
    ariaLabel: 'Switch to ear speaker',
    Icon: Ear
  }
]

/**
 * Audio output switch between Loud (loudspeaker), Ear (earpiece), and an
 * attached Bluetooth/wired headset when connected. Intentionally has no
 * "speaker off" state so call audio cannot be muted by accident.
 */
export default function SpeakerSwitch({
  mode,
  onChange,
  headsetInfo,
  variant = 'card'
}) {
  const activeMode = normalizeSpeakerMode(mode)
  const isOverlay = variant === 'overlay'
  const options = headsetInfo?.connected
    ? [
        ...BASE_SPEAKER_OPTIONS,
        {
          id: CALL_SPEAKER_MODES.HEADSET,
          label: headsetInfo.type === 'bluetooth' ? 'BT' : 'Headset',
          ariaLabel:
            headsetInfo.type === 'bluetooth'
              ? 'Switch to Bluetooth headset'
              : 'Switch to wired headset',
          Icon: headsetInfo.type === 'bluetooth' ? Bluetooth : Headphones
        }
      ]
    : BASE_SPEAKER_OPTIONS

  return (
    <div
      role="radiogroup"
      aria-label="Speaker output"
      className={`inline-flex max-w-full flex-wrap items-center justify-center gap-1 border p-1 ${
        isOverlay
          ? 'rounded-full border-white/15 bg-black/55 backdrop-blur-md'
          : 'rounded-2xl border-white/10 bg-white/5'
      }`}
    >
      {options.map(({ id, label, ariaLabel, Icon }) => {
        const selected = activeMode === id
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={ariaLabel}
            title={ariaLabel}
            onClick={() => onChange(id)}
            className={`inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold transition-all cursor-pointer active:scale-95 ${
              isOverlay ? 'rounded-full' : 'rounded-xl'
            } ${
              selected
                ? 'border border-amber-400/40 bg-amber-400/20 text-[#facc15] shadow-sm'
                : 'border border-transparent text-zinc-300 hover:bg-white/5 hover:text-white'
            }`}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span>{label}</span>
          </button>
        )
      })}
    </div>
  )
}
