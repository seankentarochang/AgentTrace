/**
 * Deterministic reducer: TraceEvent[] -> TraceState.
 *
 * Given the same ordered event stream this must always produce the same
 * graph, timeline and metrics (spec §23). No provider semantics below this
 * line — only canonical events.
 */
import type {
  EntityRef,
  EventStatus,
  TraceEvent,
  Visibility,
} from "./trace-event.js";

export interface Entity {
  ref: EntityRef;
  firstSeen: string;
  lastSeen: string;
  eventCount: number;
  /** Derived from the latest lifecycle/result event involving this entity. */
  status: EventStatus | "active" | "idle";
}

export type EdgeKind = "message" | "tool_call" | "lifecycle";

export interface Edge {
  id: string;
  sourceId: string;
  destinationId: string;
  kind: EdgeKind;
  eventIds: string[];
  status?: EventStatus;
  /** Lowest visibility observed on this edge — never claim more than this. */
  visibility: Visibility;
}

export type SpanKind = "session" | "agent" | "tool" | "model";

export interface Span {
  id: string;
  /** Entity shown as the timeline row (the tool for tool calls, else the agent). */
  entityId: string;
  /** Agent that initiated the operation. */
  ownerId: string;
  name: string;
  kind: SpanKind;
  startEventId: string;
  endEventId?: string;
  startTime: string;
  endTime?: string;
  durationMs?: number;
  status: EventStatus;
  correlationId?: string;
}

export interface TraceMetrics {
  eventCount: number;
  entityCount: number;
  agentCount: number;
  toolCallCount: number;
  messageCount: number;
  delegationCount: number;
  failureCount: number;
  startedAt?: string;
  endedAt?: string;
  totalDurationMs?: number;
}

export interface TraceError {
  eventId: string;
  entityId: string;
  timestamp: string;
  message?: string;
}

export interface TraceState {
  traceId?: string;
  entities: Record<string, Entity>;
  edges: Record<string, Edge>;
  spans: Span[];
  metrics: TraceMetrics;
  errors: TraceError[];
  /** Raw events, kept so the inspector can show payloads without a second fetch. */
  events: TraceEvent[];
}

export function createTraceState(traceId?: string): TraceState {
  return {
    traceId,
    entities: {},
    edges: {},
    spans: [],
    metrics: {
      eventCount: 0,
      entityCount: 0,
      agentCount: 0,
      toolCallCount: 0,
      messageCount: 0,
      delegationCount: 0,
      failureCount: 0,
    },
    errors: [],
    events: [],
  };
}

const VISIBILITY_RANK: Record<Visibility, number> = {
  full_protocol: 2,
  structured_event: 1,
  lifecycle_only: 0,
};

function upsertEntity(state: TraceState, ref: EntityRef, ts: string): Entity {
  const existing = state.entities[ref.id];
  if (existing) {
    existing.lastSeen = ts;
    existing.eventCount += 1;
    return existing;
  }
  const entity: Entity = {
    ref,
    firstSeen: ts,
    lastSeen: ts,
    eventCount: 1,
    status: "idle",
  };
  state.entities[ref.id] = entity;
  return entity;
}

function edgeKind(event: TraceEvent): EdgeKind | null {
  switch (event.type) {
    case "agent_message":
      return "message";
    case "tool_call":
    case "tool_result":
      return "tool_call";
    case "agent_start":
    case "agent_stop":
      return "lifecycle";
    default:
      return null;
  }
}

function upsertEdge(state: TraceState, event: TraceEvent): void {
  if (!event.destination) return;
  const kind = edgeKind(event);
  if (!kind) return;

  const id = `${event.source.id}->${event.destination.id}:${kind}`;
  const existing = state.edges[id];
  if (existing) {
    existing.eventIds.push(event.eventId);
    if (event.status) existing.status = event.status;
    if (VISIBILITY_RANK[event.visibility] < VISIBILITY_RANK[existing.visibility]) {
      existing.visibility = event.visibility;
    }
    return;
  }
  state.edges[id] = {
    id,
    sourceId: event.source.id,
    destinationId: event.destination.id,
    kind,
    eventIds: [event.eventId],
    status: event.status,
    visibility: event.visibility,
  };
}

function openSpan(
  state: TraceState,
  key: string,
  event: TraceEvent,
  kind: SpanKind,
): void {
  const rowEntity =
    kind === "tool" && event.destination ? event.destination : event.source;
  state.spans.push({
    id: `${key}:${event.eventId}`,
    entityId: rowEntity.id,
    ownerId: event.source.id,
    name: rowEntity.name,
    kind,
    startEventId: event.eventId,
    startTime: event.timestamp,
    status: "started",
    correlationId: event.correlationId,
  });
}

function closeSpan(
  state: TraceState,
  event: TraceEvent,
  spanKind: SpanKind,
): void {
  // Match by correlationId first, else fall back to the owning entity.
  const candidate = [...state.spans].reverse().find((span) => {
    if (span.status !== "started" || span.kind !== spanKind) return false;
    if (event.correlationId && span.correlationId) {
      return span.correlationId === event.correlationId;
    }
    return span.ownerId === event.source.id || span.entityId === event.source.id;
  });
  if (!candidate) return;

  candidate.endEventId = event.eventId;
  candidate.endTime = event.timestamp;
  candidate.durationMs =
    event.durationMs ??
    Date.parse(event.timestamp) - Date.parse(candidate.startTime);
  candidate.status = event.status ?? "success";
}

function extractErrorMessage(event: TraceEvent): string | undefined {
  const payload = event.payload;
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const candidate = record.error ?? record.message ?? record.stderr;
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

/** Mutates `state` in place. Returns the same state for convenience. */
export function applyEvent(state: TraceState, event: TraceEvent): TraceState {
  state.traceId ??= event.traceId;
  state.events.push(event);

  const source = upsertEntity(state, event.source, event.timestamp);
  if (event.destination) {
    upsertEntity(state, event.destination, event.timestamp);
  }
  upsertEdge(state, event);

  const m = state.metrics;
  m.eventCount += 1;

  switch (event.type) {
    case "session_start":
      openSpan(state, "session", event, "session");
      source.status = "active";
      break;
    case "session_end":
      closeSpan(state, event, "session");
      source.status = event.status ?? "success";
      break;
    case "agent_start":
      openSpan(state, `agent:${event.source.id}`, event, "agent");
      source.status = "active";
      m.agentCount = Object.values(state.entities).filter(
        (e) => e.ref.kind === "agent",
      ).length;
      if (event.destination) m.delegationCount += 1;
      break;
    case "agent_stop":
      closeSpan(state, event, "agent");
      source.status = event.status ?? "success";
      break;
    case "agent_message":
      m.messageCount += 1;
      break;
    case "tool_call":
      openSpan(state, `tool:${event.correlationId ?? event.eventId}`, event, "tool");
      m.toolCallCount += 1;
      break;
    case "tool_result":
      closeSpan(state, event, "tool");
      break;
    case "error":
    case "status_change":
      if (event.status === "failure") {
        m.failureCount += 1;
        source.status = "failure";
        state.errors.push({
          eventId: event.eventId,
          entityId: event.source.id,
          timestamp: event.timestamp,
          message: extractErrorMessage(event),
        });
      }
      break;
  }

  if (event.status === "failure" && event.type !== "status_change" && event.type !== "error") {
    m.failureCount += 1;
    source.status = "failure";
    state.errors.push({
      eventId: event.eventId,
      entityId: event.source.id,
      timestamp: event.timestamp,
      message: extractErrorMessage(event),
    });
  }

  const ts = event.timestamp;
  if (!m.startedAt || ts < m.startedAt) m.startedAt = ts;
  if (!m.endedAt || ts > m.endedAt) m.endedAt = ts;
  m.totalDurationMs = Date.parse(m.endedAt) - Date.parse(m.startedAt);
  m.entityCount = Object.keys(state.entities).length;

  return state;
}

export function reduceEvents(events: TraceEvent[], traceId?: string): TraceState {
  const state = createTraceState(traceId);
  const ordered = [...events].sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
  );
  for (const event of ordered) applyEvent(state, event);
  return state;
}
