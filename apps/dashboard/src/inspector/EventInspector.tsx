/**
 * Event inspector (spec §18): full detail on the selected event, raw
 * payload collapsible. TODO(track-2): related-events section (same
 * correlationId), copy buttons, payload field search.
 */
import type { TraceEvent, TraceState } from "@agenttrace/protocol";

interface Props {
  state: TraceState;
  eventId?: string;
}

export function EventInspector({ state, eventId }: Props) {
  const event: TraceEvent | undefined = state.events.find(
    (e) => e.eventId === eventId,
  );

  if (!event) {
    return (
      <div className="inspector" style={{ color: "var(--muted)" }}>
        select a node, edge or span
      </div>
    );
  }

  const fields: [string, string | undefined][] = [
    ["Type", `${event.category} / ${event.type}`],
    ["Source", `${event.source.name} (${event.source.id})`],
    ["Destination", event.destination ? `${event.destination.name} (${event.destination.id})` : undefined],
    ["Provider", `${event.provider.adapter} v${event.provider.adapterVersion}`],
    ["Timestamp", event.timestamp],
    ["Duration", event.durationMs !== undefined ? `${event.durationMs} ms` : undefined],
    ["Status", event.status],
    ["Correlation ID", event.correlationId],
    ["Parent event", event.parentEventId],
    ["Visibility", event.visibility],
  ];

  return (
    <div className="inspector">
      <h2>{event.eventId}</h2>
      <dl>
        {fields
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => (
            <div key={k} style={{ display: "contents" }}>
              <dt>{k}</dt>
              <dd className={v === "failure" ? "failure" : undefined}>{v}</dd>
            </div>
          ))}
      </dl>
      <details open>
        <summary>raw event</summary>
        <pre>{JSON.stringify(event, null, 2)}</pre>
      </details>
    </div>
  );
}
