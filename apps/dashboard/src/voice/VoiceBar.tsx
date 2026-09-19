/**
 * Voice control bar: mic toggle, session status, and a scrolling transcript
 * (you said / Gemini said). The mic button is the whole UI — everything else
 * is hands-free.
 */
import type { VoiceHandle } from "./useVoice";

export function VoiceBar({ voice }: { voice: VoiceHandle }) {
  const live = voice.status === "live" || voice.status === "connecting";
  return (
    <div className="voice-bar">
      <button
        className={`voice-mic ${live ? "live" : ""} ${voice.status === "error" ? "error" : ""}`}
        onClick={() => (live ? voice.stop() : voice.start())}
        title={
          voice.status === "error"
            ? voice.error ?? "voice error"
            : live
              ? "stop voice"
              : "start voice (Gemini Live)"
        }
      >
        {voice.status === "connecting" ? "◌" : live ? "⏹" : "🎙"}
      </button>
      <div className="voice-status">
        <span className={`voice-dot ${voice.speaking ? "speaking" : live ? "live" : ""}`} />
        {voice.status === "live"
          ? voice.speaking
            ? "speaking…"
            : "listening"
          : voice.status === "connecting"
            ? "connecting…"
            : voice.status === "error"
              ? (voice.error ?? "voice error")
              : "voice off"}
      </div>
      <div className="voice-transcript">
        {voice.lines.slice(-4).map((line, i) => (
          <div key={i} className={`voice-line ${line.role}`}>
            <b>{line.role === "you" ? "you" : "agenttrace"}</b> {line.text}
          </div>
        ))}
      </div>
    </div>
  );
}
