/**
 * Primary screen layout (spec §15): header stats, live graph + inspector
 * split, execution timeline, assistant bar.
 */
import { useState } from "react";
import { useTrace, type SourceMode } from "./lib/useTrace";
import { LiveGraph } from "./graph/LiveGraph";
import { Legend } from "./graph/Legend";
import { Timeline } from "./timeline/Timeline";
import { EventInspector } from "./inspector/EventInspector";
import { Assistant } from "./assistant/Assistant";
import { formatMs } from "./lib/derive";

const MODES: SourceMode[] = ["live", "fixture", "replay"];

export function App() {
  const {
    state,
    traces,
    traceId,
    selectTrace,
    connection,
    mode,
    setMode,
    restartReplay,
    refreshTraces,
  } = useTrace();
  const [selectedEventId, setSelectedEventId] = useState<string>();
  const m = state.metrics;

  return (
    <div className="app">
      <header className="app-header">
        <h1>AgentTrace</h1>

        {mode === "live" ? (
          <select
            className="trace-picker"
            value={traceId ?? ""}
            disabled={traces.length === 0 && !traceId}
            onChange={(e) => {
              selectTrace(e.target.value);
              setSelectedEventId(undefined);
            }}
            onMouseDown={refreshTraces}
          >
            {traces.length === 0 && !traceId && (
              <option value="">no traces yet</option>
            )}
            {traceId && !traces.some((t) => t.traceId === traceId) && (
              <option value={traceId}>{traceId} · live</option>
            )}
            {traces.map((t) => (
              <option key={t.traceId} value={t.traceId}>
                {t.traceId} · {t.eventCount} ev · {t.status}
              </option>
            ))}
          </select>
        ) : (
          <span className="trace-picker static">{traceId} · fixture</span>
        )}

        <span className="stats">
          <b>{m.agentCount}</b> agents · <b>{m.toolCallCount}</b> calls ·{" "}
          <b>{m.messageCount}</b> messages ·{" "}
          <b>{formatMs(m.totalDurationMs ?? 0)}</b> ·{" "}
          <b className={m.failureCount > 0 ? "failure" : undefined}>
            {m.failureCount}
          </b>{" "}
          errors
        </span>

        <div className="mode-switch" role="group" aria-label="event source">
          {MODES.map((value) => (
            <button
              key={value}
              className={mode === value ? "active" : ""}
              onClick={() => {
                setSelectedEventId(undefined);
                if (value === "replay") restartReplay();
                else setMode(value);
              }}
              title={
                value === "live"
                  ? "events from the collector"
                  : value === "fixture"
                    ? "the demo fixture, all at once"
                    : "the demo fixture, played back in real time"
              }
            >
              {value}
            </button>
          ))}
        </div>

        <span className={`conn ${connection}`}>
          {connection === "live"
            ? "● collector live"
            : connection === "connecting"
              ? "◌ connecting"
              : "○ collector offline"}
        </span>
      </header>

      <div className="app-main">
        <div className="panel graph-panel">
          <LiveGraph
            state={state}
            selectedEventId={selectedEventId}
            onSelect={setSelectedEventId}
          />
          <Legend />
        </div>
        <div className="panel inspector-panel">
          <EventInspector
            state={state}
            eventId={selectedEventId}
            onSelect={setSelectedEventId}
          />
        </div>
      </div>

      <div className="timeline-panel">
        <Timeline
          state={state}
          selectedEventId={selectedEventId}
          onSelect={setSelectedEventId}
        />
      </div>

      {/* Fixture/replay traces live only in the browser — the collector
          can't answer questions about them, so the bar stays disabled. */}
      <Assistant traceId={mode === "live" ? traceId : undefined} />
    </div>
  );
}
