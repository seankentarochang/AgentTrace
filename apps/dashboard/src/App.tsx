/**
 * Primary screen layout (spec §15): header stats, live graph + inspector
 * split, execution timeline, assistant bar.
 */
import { useState } from "react";
import { DEMO_TRACE_ID } from "@agenttrace/protocol";
import { useTrace, type SourceMode } from "./lib/useTrace";
import { LiveGraph } from "./graph/LiveGraph";
import { Legend } from "./graph/Legend";
import { Timeline } from "./timeline/Timeline";
import { EventInspector } from "./inspector/EventInspector";
import { Assistant } from "./assistant/Assistant";
import { ReplayControls } from "./replay/ReplayControls";
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
    replay,
  } = useTrace();
  const [selectedEventId, setSelectedEventId] = useState<string>();
  // Clicking the already-selected event (node, span bar, inspector link)
  // deselects it; undefined clears the selection (pane click).
  const toggleSelect = (eventId?: string) =>
    setSelectedEventId((prev) => (prev === eventId ? undefined : eventId));
  const m = state.metrics;

  return (
    <div className="app">
      <header className="app-header">
        <h1>AgentTrace</h1>

        {/* One source picker for all tabs — live/fixture/replay only change
            how the selected trace arrives. DEMO_TRACE_ID = bundled fixture. */}
        <select
          className="trace-picker"
          value={traceId ?? ""}
          onChange={(e) => {
            selectTrace(e.target.value);
            setSelectedEventId(undefined);
          }}
          onMouseDown={refreshTraces}
        >
          {!traceId && (
            <option value="">
              {traces.length ? "pick a trace…" : "no traces yet"}
            </option>
          )}
          <option value={DEMO_TRACE_ID}>{DEMO_TRACE_ID} · bundled fixture</option>
          {traceId !== DEMO_TRACE_ID &&
            traceId &&
            !traces.some((t) => t.traceId === traceId) && (
              <option value={traceId}>
                {traceId} · {mode}
              </option>
            )}
          {traces.map((t) => (
            <option key={t.traceId} value={t.traceId}>
              {t.traceId} · {t.eventCount} ev · {t.status}
            </option>
          ))}
        </select>

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

      {mode === "replay" && <ReplayControls replay={replay} />}

      <div className="app-main">
        <div className="panel graph-panel">
          <LiveGraph
            state={state}
            selectedEventId={selectedEventId}
            onSelect={toggleSelect}
          />
          <Legend />
        </div>
        <div className="panel inspector-panel">
          <EventInspector
            state={state}
            eventId={selectedEventId}
            onSelect={toggleSelect}
          />
        </div>
      </div>

      <div className="timeline-panel">
        <Timeline
          state={state}
          selectedEventId={selectedEventId}
          onSelect={toggleSelect}
        />
      </div>

      {/* Browser-side traces (fixture, replay-without-a-trace) can't be
          answered by the collector — the bar stays disabled for them.
          Replaying a real collector trace keeps the assistant enabled. */}
      <Assistant traceId={traceId === DEMO_TRACE_ID ? undefined : traceId} />
    </div>
  );
}
