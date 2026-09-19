/**
 * Trace data hook: loads the latest trace snapshot, subscribes to /v1/live
 * for live events, and reduces everything through the shared protocol
 * reducer. `useFixture` swaps in the demo fixture so UI work never blocks
 * on the collector.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEMO_TRACE_ID,
  demoTraceEvents,
  reduceEvents,
  type TraceEvent,
  type TraceState,
} from "@agenttrace/protocol";

export interface TraceHandle {
  state: TraceState;
  events: TraceEvent[];
  connected: boolean;
  useFixture: boolean;
  setUseFixture: (v: boolean) => void;
}

export function useTrace(): TraceHandle {
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [useFixture, setUseFixture] = useState(false);
  const seen = useRef(new Set<string>());

  // Initial snapshot: latest trace, if any.
  useEffect(() => {
    (async () => {
      try {
        const list = (await fetch("/v1/traces").then((r) => r.json())) as {
          traces: { traceId: string }[];
        };
        const latest = list.traces[0];
        if (!latest) return;
        const detail = (await fetch(`/v1/traces/${latest.traceId}`).then((r) =>
          r.json(),
        )) as { events: TraceEvent[] };
        for (const e of detail.events) seen.current.add(e.eventId);
        setEvents(detail.events);
      } catch {
        // Collector not running — fine, fixture mode still works.
      }
    })();
  }, []);

  // Live stream.
  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/v1/live`);
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (m) => {
      try {
        const msg = JSON.parse(m.data as string) as
          | { kind: "event"; event: TraceEvent }
          | { kind: "reset" };
        if (msg.kind === "reset") {
          seen.current.clear();
          setEvents([]);
        } else if (!seen.current.has(msg.event.eventId)) {
          seen.current.add(msg.event.eventId);
          setEvents((prev) => [...prev, msg.event]);
        }
      } catch {
        // Ignore malformed frames.
      }
    };
    return () => ws.close();
  }, []);

  const effective = useFixture ? demoTraceEvents : events;
  const state = useMemo(
    () => reduceEvents(effective, useFixture ? DEMO_TRACE_ID : undefined),
    [effective, useFixture],
  );

  const setUseFixtureCb = useCallback(setUseFixture, []);
  return { state, events: effective, connected, useFixture, setUseFixture: setUseFixtureCb };
}
