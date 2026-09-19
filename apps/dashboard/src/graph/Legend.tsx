/**
 * Visibility legend (spec §16). The graph must never imply more visibility
 * than was captured, which only works if the viewer can read the encoding.
 *
 * Mirrors the canvas exactly: line *style* carries visibility, line *colour*
 * carries status. Swatches are lines for anything drawn as a line.
 */
interface SwatchProps {
  color: string;
  width: number;
  dashed?: boolean;
}

function LineSwatch({ color, width, dashed }: SwatchProps) {
  return (
    <svg width="26" height="8" aria-hidden>
      <line
        x1="0"
        y1="4"
        x2="26"
        y2="4"
        stroke={color}
        strokeWidth={width}
        strokeDasharray={dashed ? "6 5" : undefined}
      />
    </svg>
  );
}

export function Legend() {
  return (
    <div className="legend">
      <span className="legend-title">visibility</span>
      <span className="legend-item">
        <LineSwatch color="var(--muted)" width={2} />
        full protocol
      </span>
      <span className="legend-item">
        <LineSwatch color="var(--muted)" width={1.4} />
        structured events
      </span>
      <span className="legend-item">
        <LineSwatch color="var(--muted)" width={1.4} dashed />
        lifecycle only
      </span>
      <span className="legend-item">
        <span className="legend-swatch unobserved">?</span>
        unobservable
      </span>

      <span className="legend-sep" />

      <span className="legend-title">status</span>
      <span className="legend-item">
        <LineSwatch color="var(--warn)" width={2} />
        in progress
      </span>
      <span className="legend-item">
        <LineSwatch color="var(--failure)" width={2} />
        failure
      </span>
    </div>
  );
}
