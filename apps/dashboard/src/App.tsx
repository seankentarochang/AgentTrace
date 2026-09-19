/**
 * Primary screen layout (spec §15): header stats, live graph + inspector
 * split, timeline, assistant bar.
 */
import { useState } from "react";
import { useTrace } from "./lib/useTrace";
import { LiveGraph } from "./graph/LiveGraph";
import { Timeline } from "./timeline/Timeline";
import { EventInspector } from "./inspector/EventInspector";
import { Assistant } from "./assistant/Assistant";

export function App() {
  const { state, connected, useFixture, setUseFixture } = useTrace();
  const [selectedEventId, setSelectedEventId] = useState<string>();
  const m = state.metrics;

  return (
    <div className="app">
      <header className="app-header">
        <h1>AgentTrace</h1>
        <span className="stats">
          {state.traceId ?? "no trace"} · <b>{m.agentCount}</b> agents ·{" "}
          <b>{m.toolCallCount}</b> calls · <b>{m.totalDurationMs ?? 0}</b>ms ·{" "}
          <b>{m.failureCount}</b> errors
        </span>
        <button
          className={useFixture ? "active" : ""}
          onClick={() => setUseFixture(!useFixture)}
        >
          fixture
        </button>
        <span className={`conn ${connected ? "live" : "off"}`}>
          {connected ? "● live" : "○ offline"}
        </span>
      </header>

      <div className="app-main">
        <div className="panel graph-panel">
          <LiveGraph state={state} onSelect={setSelectedEventId} />
        </div>
        <div className="panel">
          <EventInspector state={state} eventId={selectedEventId} />
        </div>
      </div>

      <div className="timeline-panel">
        <Timeline state={state} onSelect={setSelectedEventId} />
      </div>

      <Assistant traceId={state.traceId} />
    </div>
  );
}
