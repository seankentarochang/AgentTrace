/**
 * Primary screen layout (spec §15): header stats, live graph + inspector
 * split, execution timeline, assistant bar, voice bar.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { DEMO_TRACE_ID } from "@agenttrace/protocol";
import { useTrace, type SourceMode } from "./lib/useTrace";
import { LiveGraph } from "./graph/LiveGraph";
import { Legend } from "./graph/Legend";
import { Timeline } from "./timeline/Timeline";
import { EventInspector } from "./inspector/EventInspector";
import { Assistant } from "./assistant/Assistant";
import { ReplayControls } from "./replay/ReplayControls";
import { VoiceBar } from "./voice/VoiceBar";
import { useVoice } from "./voice/useVoice";
import type { UiActions } from "./voice/uiTools";
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
    events,
    traces,
    traceId,
    selectTrace,
    connection,
    mode,
    setMode,
    restartReplay,
    refreshTraces,
    replay,
    viewUntilMs,
    setViewUntilMs,
  } = useTrace();
  const [selectedEventId, setSelectedEventId] = useState<string>();
  const [highlightIds, setHighlightIds] = useState<string[]>([]);
  const [isolateId, setIsolateId] = useState<string>();
  /** Last few selections — lets voice resolve "this", "these two", "the other". */
  const [recentSelections, setRecentSelections] = useState<string[]>([]);

  const recordSelection = (eventId: string) =>
    setRecentSelections((prev) =>
      [eventId, ...prev.filter((id) => id !== eventId)].slice(0, 5),
    );

  // Clicking the already-selected event (node, span bar, inspector link)
  // deselects it; undefined clears the selection (pane click).
  const toggleSelect = (eventId?: string) => {
    setSelectedEventId((prev) => (prev === eventId ? undefined : eventId));
    if (eventId) recordSelection(eventId);
  };

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

  /** Highlighted event ids -> the entities behind them (deterministic map). */
  const highlightEntityIds = useMemo(() => {
    if (!highlightIds.length) return undefined;
    const set = new Set<string>();
    for (const e of events) {
      if (highlightIds.includes(e.eventId)) {
        set.add(e.source.id);
        if (e.destination) set.add(e.destination.id);
      }
    }
    return set.size ? set : undefined;
  }, [highlightIds, events]);

  /** Voice UI tools — the only way the model changes the screen. */
  const uiActions = useMemo<UiActions>(
    () => ({
      selectEvent: (eventId) => {
        setSelectedEventId(eventId);
        recordSelection(eventId);
      },
      selectAgent: (agentId) => {
        const last = events.findLast(
          (e) => e.source.id === agentId || e.destination?.id === agentId,
        );
        if (!last) return { ok: false, error: `no events for ${agentId}` };
        setSelectedEventId(last.eventId);
        recordSelection(last.eventId);
        return { ok: true, eventId: last.eventId };
      },
      highlightEvents: (eventIds) => {
        const valid = eventIds.filter((id) =>
          events.some((e) => e.eventId === id),
        );
        if (!valid.length) return { ok: false, error: "no known event ids" };
        setHighlightIds(valid);
        return { ok: true };
      },
      isolateEntity: (entityId) => {
        if (!state.entities[entityId])
          return { ok: false, error: `unknown entity ${entityId}` };
        setIsolateId(entityId);
        return { ok: true };
      },
      setViewUntil: ({ eventId, seconds }) => {
        const base = Date.parse(events[0]?.timestamp ?? "");
        if (eventId) {
          const ev = events.find((e) => e.eventId === eventId);
          if (!ev) return { ok: false, error: `unknown event ${eventId}` };
          setViewUntilMs(Date.parse(ev.timestamp) - base);
          return { ok: true };
        }
        if (typeof seconds === "number") {
          setViewUntilMs(seconds * 1000);
          return { ok: true };
        }
        return { ok: false, error: "eventId or seconds required" };
      },
      showFailures: () => {
        const ids = events
          .filter((e) => e.status === "failure")
          .map((e) => e.eventId);
        setHighlightIds(ids);
        return { ok: true, count: ids.length };
      },
      clearView: () => {
        setSelectedEventId(undefined);
        setHighlightIds([]);
        setIsolateId(undefined);
        setViewUntilMs(undefined);
      },
    }),
    [events, state.entities, setViewUntilMs],
  );

  /** Compact UI state the model reads to resolve deictic references. */
  const contextJson = useMemo(() => {
    const selected = events.find((e) => e.eventId === selectedEventId);
    const base = Date.parse(events[0]?.timestamp ?? "");
    const entity = (kind: string) =>
      Object.values(state.entities)
        .filter((en) => en.ref.kind === kind)
        .map((en) => ({ id: en.ref.id, name: en.ref.name, status: en.status }));
    return JSON.stringify({
      traceId: traceId ?? null,
      mode,
      selectedEvent: selected
        ? {
            id: selected.eventId,
            type: selected.type,
            source: selected.source.id,
            destination: selected.destination?.id ?? null,
            msFromStart: Date.parse(selected.timestamp) - base,
          }
        : null,
      recentSelections,
      highlightedEventIds: highlightIds,
      isolatedEntityId: isolateId ?? null,
      viewUntilMs: viewUntilMs ?? null,
      agents: entity("agent"),
      tools: entity("tool"),
    });
  }, [
    events,
    state.entities,
    traceId,
    mode,
    selectedEventId,
    recentSelections,
    highlightIds,
    isolateId,
    viewUntilMs,
  ]);

  const voice = useVoice({
    contextJson: useCallback(() => contextJson, [contextJson]),
    actions: uiActions,
  });
  // Every UI-state change reaches the session (debounced inside the hook).
  useEffect(() => {
    voice.pushContext();
  }, [contextJson, voice.pushContext]);

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
      {mode !== "replay" && viewUntilMs != null && (
        <div className="replay-controls">
          <span className="replay-time">
            viewing first {formatMs(viewUntilMs)} of the trace
          </span>
          <button className="replay-btn" onClick={() => setViewUntilMs(undefined)}>
            clear
          </button>
        </div>
      )}

      <div
        className="app-main"
        style={{ gridTemplateColumns: `1fr auto ${inspectorWidth}px` }}
      >
        <div className="panel graph-panel">
          <LiveGraph
            state={state}
            selectedEventId={selectedEventId}
            highlightEntityIds={highlightEntityIds}
            isolateEntityId={isolateId}
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
      <VoiceBar voice={voice} />
    </div>
  );
}
