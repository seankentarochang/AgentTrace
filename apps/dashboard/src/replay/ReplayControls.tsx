/**
 * Time controls for fixture replay: play/pause, a seek slider across the
 * fixture timeline, and playback speed. Rendered only in replay mode.
 */
import type { ReplayHandle } from "../lib/useTrace";
import { formatMs } from "../lib/derive";

const SPEEDS = [0.5, 1, 2, 4];

export function ReplayControls({ replay }: { replay: ReplayHandle }) {
  const done = replay.positionMs >= replay.totalMs;
  return (
    <div className="replay-controls">
      <button
        className="replay-btn"
        onClick={() =>
          done ? replay.restart() : replay.setPaused(!replay.paused)
        }
        title={done ? "replay" : replay.paused ? "play" : "pause"}
      >
        {replay.paused || done ? "▶" : "⏸"}
      </button>
      <input
        className="replay-seek"
        type="range"
        min={0}
        max={replay.totalMs}
        step="any"
        value={replay.positionMs}
        onChange={(e) => replay.seek(Number(e.target.value))}
      />
      <span className="replay-time">
        {formatMs(replay.positionMs)} / {formatMs(replay.totalMs)}
      </span>
      <div className="replay-speeds">
        {SPEEDS.map((s) => (
          <button
            key={s}
            className={`replay-btn ${replay.speed === s ? "active" : ""}`}
            onClick={() => replay.setSpeed(s)}
          >
            {s}×
          </button>
        ))}
      </div>
    </div>
  );
}
