/**
 * Event inspector (spec §18): everything captured for the selected event,
 * plus the other events sharing its correlationId so a call and its result
 * are one click apart. Raw payloads stay collapsible and copyable.
 */
import { useState } from "react";
import type { TraceEvent, TraceState } from "@agenttrace/protocol";
import {
  VISIBILITY_LABEL,
  formatMs,
  offsetMs,
  relatedEvents,
  spanForEvent,
} from "../lib/derive";

interface Props {
  state: TraceState;
  eventId?: string;
  onSelect: (eventId: string) => void;
}

function CopyButton({ text, label = "copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="copy-btn"
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          })
          .catch(() => undefined);
      }}
    >
      {done ? "copied" : label}
    </button>
  );
}

/** Split a payload into the named sections spec §18 asks for. */
function payloadSections(payload: unknown): { title: string; value: unknown }[] {
  if (payload === undefined || payload === null) return [];
  if (typeof payload !== "object") return [{ title: "payload", value: payload }];

  const record = { ...(payload as Record<string, unknown>) };
  const sections: { title: string; value: unknown }[] = [];
  const take = (key: string, title: string) => {
    if (key in record) {
      sections.push({ title, value: record[key] });
      delete record[key];
    }
  };

  take("prompt", "prompt");
  take("message", "message");
  take("arguments", "arguments");
  take("result", "result");
  take("error", "error");
  take("stderr", "stderr");

  if (Object.keys(record).length > 0) {
    sections.push({ title: "other fields", value: record });
  }
  return sections;
}

function render(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function EventInspector({ state, eventId, onSelect }: Props) {
  const event: TraceEvent | undefined = state.events.find(
    (e) => e.eventId === eventId,
  );

  if (!event) {
    return (
      <div className="inspector inspector-empty">
        <p>Select a node, edge or span.</p>
        <p className="hint">
          Every field shown here is captured data. Regions AgentTrace could not
          observe are marked as unavailable rather than filled in.
        </p>
      </div>
    );
  }

  const related = relatedEvents(state, event);
  const span = spanForEvent(state, event.eventId);
  const sections = payloadSections(event.payload);

  const fields: [string, string | undefined][] = [
    ["Type", `${event.category} / ${event.type}`],
    ["Source", `${event.source.name} (${event.source.id})`],
    [
      "Destination",
      event.destination
        ? `${event.destination.name} (${event.destination.id})`
        : undefined,
    ],
    ["Provider", `${event.provider.adapter} v${event.provider.adapterVersion}`],
    ["Raw type", event.provider.rawEventType],
    ["Start time", `${event.timestamp}  (+${formatMs(offsetMs(state, event.timestamp))})`],
    [
      "Duration",
      event.durationMs !== undefined
        ? formatMs(event.durationMs)
        : span?.durationMs !== undefined
          ? `${formatMs(span.durationMs)} (span)`
          : undefined,
    ],
    ["Correlation ID", event.correlationId],
    ["Parent event", event.parentEventId],
    ["Visibility", VISIBILITY_LABEL[event.visibility]],
  ];

  return (
    <div className="inspector">
      <div className="inspector-head">
        <div>
          <span className={`type-badge cat-${event.category}`}>{event.type}</span>
          {event.status && (
            <span className={`status-pill status-${event.status}`}>
              {event.status}
            </span>
          )}
        </div>
        <CopyButton text={JSON.stringify(event, null, 2)} label="copy event" />
      </div>
      <div className="inspector-id" title={event.eventId}>
        {event.eventId}
      </div>

      <dl>
        {fields
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => (
            <div key={k} className="dl-row">
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
      </dl>

      {sections.map((section) => (
        <section className="payload-section" key={section.title}>
          <div className="payload-head">
            <h3 className={section.title === "error" || section.title === "stderr" ? "failure" : undefined}>
              {section.title}
            </h3>
            <CopyButton text={render(section.value)} />
          </div>
          <pre>{render(section.value)}</pre>
        </section>
      ))}

      {event.correlationId && (
        <section className="related">
          <h3>
            related events <span className="hint">· {event.correlationId}</span>
          </h3>
          {related.length === 0 ? (
            <p className="hint">No other events share this correlation ID.</p>
          ) : (
            <ul>
              {related.map((r) => (
                <li key={r.eventId}>
                  <button onClick={() => onSelect(r.eventId)}>
                    <span className="rel-time">
                      +{formatMs(offsetMs(state, r.timestamp))}
                    </span>
                    <span className="rel-type">{r.type}</span>
                    <span className="rel-path">
                      {r.source.name}
                      {r.destination ? ` → ${r.destination.name}` : ""}
                    </span>
                    {r.status && (
                      <span className={`status-pill small status-${r.status}`}>
                        {r.status}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <details className="raw">
        <summary>raw event</summary>
        <pre>{JSON.stringify(event, null, 2)}</pre>
      </details>
    </div>
  );
}
