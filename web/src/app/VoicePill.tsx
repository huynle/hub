// The Voice mode indicator shown while the user looks at anything but the session in Voice mode: which session
// it is (a link back to it) and End.
import { sessionHref } from "./router"
import { Icon } from "./ui"
import { voice, voiceState, voiceTitle } from "./voice"

export function VoicePill() {
  const id = () => voiceState().sessionID ?? ""
  return (
    <div class={`voice-pill ${voiceState().voice}`} role="status" aria-label={`Voice mode is on in ${voiceTitle()}`}>
      <Icon name="wave" />
      <a href={sessionHref(id())} class="voice-pill-link" title="Go to the session in Voice mode">
        Voice: <strong>{voiceTitle()}</strong>
      </a>
      <button type="button" class="btn small end" onClick={() => void voice.end()} aria-label="End Voice mode">
        End
      </button>
    </div>
  )
}
