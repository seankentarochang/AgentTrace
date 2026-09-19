/**
 * Execution timeline (spec §17): every asynchronous operation is a span.
 * Rows are grouped agent → the tools that agent called, so parallel work
 * reads at a glance. Clicking a span opens the inspector.
 */
import { useMemo } from "react";
import type { Span, TraceState } from "@agenttrace/protocol";
import { formatMs, timelineRows } from "../lib/derive";

interface Props {
  state: TraceState;
  selectedEventId?: string;
  onSelect: (eventId: string) => void;
}

/** ~7 ticks on a 1/2/5 × 10ⁿ grid. */
function axisTicks(totalMs: number): number[] {
  if (totalMs <= 0) return [0];
  const rough = totalMs / 7;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 5, 10].find((m) => magnitude * m >= rough)! * magnitude;
  const ticks: number[] = [];
  for (let t = 0; t <= totalMs; t += step) ticks.push(t);
  return ticks;
}

export function Timeline({ state, selectedEventId, onSelect }: Props) {
  const rows = useMemo(() => timelineRows(state), [state]);

  const start = state.metrics.startedAt ? Date.parse(state.metrics.startedAt) : 0;
  const end = state.metrics.endedAt ? Date.parse(state.metrics.endedAt) : start;
  const total = Math.max(end - start, 1);
  const ticks = axisTicks(total);
  const pct = (ms: number) => `${Math.min((ms / total) * 100, 100)}%`;

  if (rows.length === 0) {
    return <div className="timeline-empty">No spans observed yet.</div>;
  }

  return (
    <div className="timeline">
      <div className="timeline-axis">
        <div className="timeline-label timeline-axis-title">
          execution timeline
        </div>
        <div className="timeline-track">
          {ticks.map((t) => (
            <span key={t} className="timeline-tick" style={{ left: pct(t) }}>
              {formatMs(t)}
            </span>
          ))}
        </div>
      </div>

      <div className="timeline-rows">
        {rows.map((row) => (
          <div className={`timeline-row depth-${row.depth}`} key={row.key}>
            <div
              className="timeline-label"
              style={{ paddingLeft: 4 + row.depth * 14 }}
              title={row.entityId}
            >
              {row.depth === 2 && <span className="tree-branch">└</span>}
              {row.label}
            </div>
            <div className="timeline-track">
              {ticks.map((t) => (
                <span
                  key={t}
                  className="timeline-gridline"
                  style={{ left: pct(t) }}
                />
              ))}
              {row.spans.map((span) => (
                <SpanBar
                  key={span.id}
                  span={span}
                  start={start}
                  end={end}
                  total={total}
                  selected={
                    span.startEventId === selectedEventId ||
                    span.endEventId === selectedEventId
                  }
                  onSelect={onSelect}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface BarProps {
  span: Span;
  start: number;
  end: number;
  total: number;
  selected: boolean;
  onSelect: (eventId: string) => void;
}

function SpanBar({ span, start, end, total, selected, onSelect }: BarProps) {
  const spanStart = Date.parse(span.startTime);
  const offset = spanStart - start;
  // An unfinished span runs to the newest event we have — it is still open,
  // so the bar is drawn open-ended rather than given an invented end time.
  const open = span.status === "started" || span.endTime === undefined;
  const duration = open
    ? Math.max(end - spanStart, 0)
    : (span.durationMs ?? Date.parse(span.endTime!) - spanStart);

  const left = (offset / total) * 100;
  const width = Math.max((duration / total) * 100, 0.6);
  const label = `${formatMs(duration)}${open ? "+" : ""}`;

  return (
    <div
      className={[
        "timeline-bar",
        `status-${span.status}`,
        open ? "is-open" : "",
        selected ? "is-selected" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ left: `${left}%`, width: `${width}%` }}
      title={`${span.name} · ${span.status} · start ${formatMs(offset)} · ${label}`}
      onClick={() => onSelect(span.endEventId ?? span.startEventId)}
    >
      <span className="timeline-bar-label">{label}</span>
    </div>
  );
}
