/**
 * Execution timeline (spec §17): every async operation is a span, one row
 * per entity. Clicking a span opens the inspector.
 *
 * TODO(track-2): time axis ticks, parallel-overlap visualization, zoom,
 * group rows by agent->tool nesting.
 */
import type { Span, TraceState } from "@agenttrace/protocol";

interface Props {
  state: TraceState;
  onSelect: (eventId: string) => void;
}

export function Timeline({ state, onSelect }: Props) {
  const start = state.metrics.startedAt ? Date.parse(state.metrics.startedAt) : 0;
  const total = Math.max(state.metrics.totalDurationMs ?? 0, 1);

  // One row per entity, in first-seen order.
  const rows = new Map<string, Span[]>();
  for (const span of state.spans) {
    const list = rows.get(span.entityId) ?? [];
    list.push(span);
    rows.set(span.entityId, list);
  }
  const orderedRows = [...rows.entries()].sort(([a], [b]) => {
    const fa = state.entities[a]?.firstSeen ?? "";
    const fb = state.entities[b]?.firstSeen ?? "";
    return fa < fb ? -1 : 1;
  });

  return (
    <div>
      {orderedRows.length === 0 && (
        <div style={{ color: "var(--muted)", padding: 8 }}>no spans yet</div>
      )}
      {orderedRows.map(([entityId, spans]) => (
        <div className="timeline-row" key={entityId}>
          <div className="timeline-label">
            {state.entities[entityId]?.ref.name ?? entityId}
          </div>
          <div className="timeline-track">
            {spans.map((span) => {
              const offset = Date.parse(span.startTime) - start;
              const width =
                span.durationMs ??
                (Date.parse(state.metrics.endedAt ?? "") - Date.parse(span.startTime) || 0);
              return (
                <div
                  key={span.id}
                  className={`timeline-bar ${span.status}`}
                  title={`${span.name} · ${span.status} · ${span.durationMs ?? "?"}ms`}
                  style={{
                    left: `${(offset / total) * 100}%`,
                    width: `${Math.max((width / total) * 100, 0.5)}%`,
                  }}
                  onClick={() => onSelect(span.endEventId ?? span.startEventId)}
                />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
