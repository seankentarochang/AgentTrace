/**
 * Visibility legend (spec §16). The graph must never imply more visibility
 * than was captured, which only works if the viewer can read the encoding.
 */
export function Legend() {
  return (
    <div className="legend">
      <span className="legend-title">visibility</span>
      <span className="legend-item">
        <svg width="26" height="8" aria-hidden>
          <line x1="0" y1="4" x2="26" y2="4" stroke="var(--accent)" strokeWidth="2" />
        </svg>
        full protocol
      </span>
      <span className="legend-item">
        <svg width="26" height="8" aria-hidden>
          <line x1="0" y1="4" x2="26" y2="4" stroke="var(--accent)" strokeWidth="1" />
        </svg>
        structured events
      </span>
      <span className="legend-item">
        <svg width="26" height="8" aria-hidden>
          <line
            x1="0"
            y1="4"
            x2="26"
            y2="4"
            stroke="var(--muted)"
            strokeWidth="1.5"
            strokeDasharray="5 4"
          />
        </svg>
        lifecycle only
      </span>
      <span className="legend-item">
        <span className="legend-swatch unobserved">?</span>
        unobservable
      </span>
      <span className="legend-sep" />
      <span className="legend-item">
        <span className="legend-swatch status-active" /> in progress
      </span>
      <span className="legend-item">
        <span className="legend-swatch status-failure" /> failure
      </span>
    </div>
  );
}
