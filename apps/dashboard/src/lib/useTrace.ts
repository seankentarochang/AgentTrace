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
  compareEvents,
  DEMO_TRACE_ID,
  demoTraceEvents,
  reduceEvents,
  type TraceEvent,
  type TraceState,
} from "@agenttrace/protocol";
import { getTrace, listTraces, type TraceSummary } from "./api";

export type ConnectionState = "connecting" | "live" | "offline";
export type SourceMode = "live" | "fixture" | "replay";

export interface ReplayHandle {
  /** Playback position within the replayed timeline, ms. */
  positionMs: number;
  /** Total duration of the trace being replayed, ms. */
  totalMs: number;
  /** True when replaying the bundled fixture (no trace selected). */
  isFixture: boolean;
  paused: boolean;
  speed: number;
  setPaused: (v: boolean) => void;
  setSpeed: (v: number) => void;
  /** Jump to a position; works while playing or paused. */
  seek: (ms: number) => void;
  /** Back to t=0 and playing — what "play" does once the run has ended. */
  restart: () => void;
}

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
  replay: ReplayHandle;
}

const REPLAY_TICK_MS = 50;
const MAX_BACKOFF_MS = 10_000;

const offsetsOf = (events: TraceEvent[]): number[] => {
  const base = events[0] ? Date.parse(events[0].timestamp) : 0;
  return events.map((e) => Date.parse(e.timestamp) - base);
};

const countAt = (offsets: number[], posMs: number) => {
  let n = 0;
  while (n < offsets.length && offsets[n] <= posMs) n++;
  return n;
};

/** Union by eventId; the reducer sorts by timestamp, so order is free here. */
function mergeEvents(a: TraceEvent[], b: TraceEvent[]): TraceEvent[] {
  const byId = new Map<string, TraceEvent>();
  for (const event of a) byId.set(event.eventId, event);
  for (const event of b) byId.set(event.eventId, event);
  return [...byId.values()];
}

export function useTrace(): TraceHandle {
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [traceId, setTraceId] = useState<string>();
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [mode, setMode] = useState<SourceMode>("live");
  const [replayNonce, setReplayNonce] = useState(0);
  const [replayPosition, setReplayPosition] = useState(0);
  const [replayPaused, setReplayPaused] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState(1);

  const seen = useRef(new Set<string>());
  /**
   * Bumped whenever the visible event set is deliberately discarded (trace
   * switch, reset). A snapshot that resolves against an older generation is
   * stale and must not repopulate the list.
   */
  const generation = useRef(0);
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
    // Drop the previous trace's events up front, then merge the snapshot in
    // rather than replacing: events that stream in over the WS while this
    // fetch is in flight belong to the same trace and must survive it.
    const gen = ++generation.current;
    seen.current = new Set();
    setEvents([]);

    getTrace(traceId)
      .then((detail) => {
        if (gen !== generation.current) return; // Superseded.
        for (const event of detail.events) seen.current.add(event.eventId);
        setEvents((prev) => mergeEvents(prev, detail.events));
      })
      .catch(() => {
        // Collector unreachable — keep whatever the live stream has given us.
      });
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
          generation.current += 1; // Invalidate any in-flight snapshot.
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

  // Replay: a position clock drives how many of the target trace's events
  // are revealed — pause/speed/seek are all just math on the same position.
  // The target is the selected trace's events; DEMO_TRACE_ID selects the
  // bundled fixture explicitly, and it's also the offline fallback.
  const bundled = traceId === DEMO_TRACE_ID;
  const replaySource = useMemo(() => {
    if (mode !== "replay") return [];
    const source = bundled || events.length === 0 ? demoTraceEvents : events;
    return [...source].sort(compareEvents);
  }, [mode, events, bundled]);
  const replayOffsets = useMemo(() => offsetsOf(replaySource), [replaySource]);
  const replayTotalMs = replayOffsets.at(-1) ?? 0;
  const replayIsFixture =
    mode === "replay" && (bundled || events.length === 0);

  useEffect(() => {
    if (mode !== "replay") return;
    setReplayPosition(0);
  }, [mode, replayNonce, traceId]);

  useEffect(() => {
    if (mode !== "replay" || replayPaused) return;
    const tick = setInterval(
      () =>
        setReplayPosition((pos) =>
          Math.min(pos + REPLAY_TICK_MS * replaySpeed, replayTotalMs),
        ),
      REPLAY_TICK_MS,
    );
    return () => clearInterval(tick);
  }, [mode, replayPaused, replaySpeed, replayTotalMs]);

  const restartReplay = useCallback(() => {
    setReplayPaused(false);
    setMode("replay");
    setReplayNonce((n) => n + 1);
  }, []);

  const seekReplay = useCallback(
    (ms: number) => setReplayPosition(Math.max(0, Math.min(ms, replayTotalMs))),
    [replayTotalMs],
  );

  const restartPlayback = useCallback(() => {
    setReplayPosition(0);
    setReplayPaused(false);
  }, []);

  const effective = useMemo(() => {
    if (bundled) return demoTraceEvents;
    if (mode === "fixture") return events.length ? events : demoTraceEvents;
    if (mode === "replay")
      return replaySource.slice(0, countAt(replayOffsets, replayPosition));
    return events;
  }, [mode, replaySource, replayOffsets, replayPosition, events, bundled]);

  // The dropdown selects a data source; the mode only changes how it plays.
  // With nothing selected, non-live tabs imply the bundled fixture.
  const shownTraceId =
    traceId ?? (mode === "live" ? undefined : DEMO_TRACE_ID);

  const state = useMemo(
    () => reduceEvents(effective, shownTraceId),
    [effective, shownTraceId],
  );

  return {
    state,
    events: effective,
    traces,
    traceId: shownTraceId,
    selectTrace: setTraceId,
    connection,
    mode,
    setMode,
    restartReplay,
    refreshTraces,
    replay: {
      positionMs: replayPosition,
      totalMs: replayTotalMs,
      isFixture: replayIsFixture,
      paused: replayPaused,
      speed: replaySpeed,
      setPaused: setReplayPaused,
      setSpeed: setReplaySpeed,
      seek: seekReplay,
      restart: restartPlayback,
    },
  };
}
