/**
 * Trace data hook: lists traces, loads a snapshot, subscribes to /v1/live
 * and reduces everything through the shared protocol reducer.
 *
 * Fixture mode swaps in the demo fixture so UI work never blocks on the
 * collector; "replay" feeds that same fixture in over wall-clock time so
 * live behaviour (animated edges, growing timeline) is visible offline.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEMO_TRACE_ID,
  demoTraceEvents,
  reduceEvents,
  type TraceEvent,
  type TraceState,
} from "@agenttrace/protocol";
import { getTrace, listTraces, type TraceSummary } from "./api";

export type ConnectionState = "connecting" | "live" | "offline";
export type SourceMode = "live" | "fixture" | "replay";

export interface TraceHandle {
  state: TraceState;
  events: TraceEvent[];
  traces: TraceSummary[];
  traceId?: string;
  selectTrace: (traceId: string) => void;
  connection: ConnectionState;
  mode: SourceMode;
  setMode: (mode: SourceMode) => void;
  /** Restart the fixture replay from t=0. */
  restartReplay: () => void;
  refreshTraces: () => void;
}

const REPLAY_SPEED = 1; // 1 = real fixture timing
const MAX_BACKOFF_MS = 10_000;

export function useTrace(): TraceHandle {
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [traceId, setTraceId] = useState<string>();
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [mode, setMode] = useState<SourceMode>("live");
  const [replayCount, setReplayCount] = useState(0);
  const [replayNonce, setReplayNonce] = useState(0);

  const seen = useRef(new Set<string>());
  const traceIdRef = useRef<string | undefined>(undefined);
  traceIdRef.current = traceId;

  const refreshTraces = useCallback(() => {
    listTraces()
      .then(({ traces: list }) => {
        setTraces(list);
        if (!traceIdRef.current && list[0]) setTraceId(list[0].traceId);
      })
      .catch(() => {
        // Collector not running — fixture mode still works.
      });
  }, []);

  useEffect(refreshTraces, [refreshTraces]);

  // Snapshot for the selected trace.
  useEffect(() => {
    if (!traceId) return;
    let cancelled = false;
    getTrace(traceId)
      .then((detail) => {
        if (cancelled) return;
        seen.current = new Set(detail.events.map((e) => e.eventId));
        setEvents(detail.events);
      })
      .catch(() => {
        if (!cancelled) setEvents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [traceId]);

  // Live stream with exponential backoff reconnect.
  useEffect(() => {
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let closed = false;

    const connect = () => {
      if (closed) return;
      setConnection(attempt === 0 ? "connecting" : "offline");
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${proto}//${location.host}/v1/live`);

      socket.onopen = () => {
        attempt = 0;
        setConnection("live");
        refreshTraces();
      };

      socket.onclose = () => {
        if (closed) return;
        setConnection("offline");
        const delay = Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);
        attempt += 1;
        retry = setTimeout(connect, delay);
      };

      socket.onerror = () => socket?.close();

      socket.onmessage = (message) => {
        let msg:
          | { kind: "event"; event: TraceEvent }
          | { kind: "reset" }
          | undefined;
        try {
          msg = JSON.parse(message.data as string);
        } catch {
          return; // Ignore malformed frames.
        }
        if (!msg) return;

        if (msg.kind === "reset") {
          seen.current.clear();
          setEvents([]);
          refreshTraces();
          return;
        }
        if (msg.kind !== "event") return;

        const event = msg.event;
        // First trace we ever see becomes the selection.
        if (!traceIdRef.current) {
          traceIdRef.current = event.traceId;
          setTraceId(event.traceId);
          refreshTraces(); // It is new to the collector too — list it.
        }
        if (event.traceId !== traceIdRef.current) {
          refreshTraces(); // Another trace is running; surface it in the picker.
          return;
        }
        if (seen.current.has(event.eventId)) return;
        seen.current.add(event.eventId);
        setEvents((prev) => [...prev, event]);
      };
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [refreshTraces]);

  // Fixture replay: reveal fixture events at their recorded offsets.
  useEffect(() => {
    if (mode !== "replay") return;
    setReplayCount(0);
    const base = Date.parse(demoTraceEvents[0]?.timestamp ?? "");
    const timers = demoTraceEvents.map((event, i) =>
      setTimeout(
        () => setReplayCount(i + 1),
        (Date.parse(event.timestamp) - base) / REPLAY_SPEED,
      ),
    );
    return () => timers.forEach(clearTimeout);
  }, [mode, replayNonce]);

  const restartReplay = useCallback(() => {
    setMode("replay");
    setReplayNonce((n) => n + 1);
  }, []);

  const effective = useMemo(() => {
    if (mode === "fixture") return demoTraceEvents;
    if (mode === "replay") return demoTraceEvents.slice(0, replayCount);
    return events;
  }, [mode, replayCount, events]);

  const state = useMemo(
    () => reduceEvents(effective, mode === "live" ? traceId : DEMO_TRACE_ID),
    [effective, mode, traceId],
  );

  return {
    state,
    events: effective,
    traces,
    traceId: mode === "live" ? traceId : DEMO_TRACE_ID,
    selectTrace: setTraceId,
    connection,
    mode,
    setMode,
    restartReplay,
    refreshTraces,
  };
}
