/**
 * Primary screen layout (spec §15): header stats, live graph + inspector
 * split, execution timeline, assistant bar.
 */
import { useRef, useState, type PointerEvent } from "react";
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

/** Drag handle; reports pointer delta along its axis since drag start. */
function Splitter({
  axis,
  onDrag,
}: {
  axis: "x" | "y";
  onDrag: (delta: number, done: boolean) => void;
}) {
  const pos = (e: PointerEvent) => (axis === "x" ? e.clientX : e.clientY);
  const start = useRef(0);
  return (
    <div
      className={`splitter splitter-${axis}`}
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      onPointerDown={(e) => {
        start.current = pos(e);
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          onDrag(pos(e) - start.current, false);
      }}
      onPointerUp={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          onDrag(pos(e) - start.current, true);
      }}
    />
  );
}

/** Panel size that follows a Splitter drag, clamped to [min, max]. */
function useDragSize(initial: number, min: number, max: () => number) {
  const [size, setSize] = useState(initial);
  const [base, setBase] = useState(initial);
  const onDrag = (delta: number, done: boolean) => {
    // Splitters sit before the panel they size, so dragging toward the
    // panel (positive delta) shrinks it.
    const next = Math.min(max(), Math.max(min, base - delta));
    setSize(next);
    if (done) setBase(next);
  };
  return [size, onDrag] as const;
}

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
  const [inspectorWidth, dragInspector] = useDragSize(
    380,
    240,
    () => window.innerWidth - 300,
  );
  const [timelineHeight, dragTimeline] = useDragSize(
    210,
    60,
    () => window.innerHeight - 260,
  );

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

      <div
        className="app-main"
        style={{ gridTemplateColumns: `1fr auto ${inspectorWidth}px` }}
      >
        <div className="panel graph-panel">
          <LiveGraph
            state={state}
            selectedEventId={selectedEventId}
            onSelect={toggleSelect}
          />
          <Legend />
        </div>
        <Splitter axis="x" onDrag={dragInspector} />
        <div className="panel inspector-panel">
          <EventInspector
            state={state}
            eventId={selectedEventId}
            onSelect={toggleSelect}
          />
        </div>
      </div>

      <Splitter axis="y" onDrag={dragTimeline} />
      <div className="timeline-panel" style={{ height: timelineHeight }}>
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
