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
  /** Explicit causal parent from the event that opened this span. */
  parentEventId?: string;
}

export interface AgentOverlap {
  agentIds: [string, string];
  agentNames: [string, string];
  start: string;
  end: string;
  overlapMs: number;
}

export interface IdleInterval {
  start: string;
  end: string;
  durationMs: number;
}

/** Timestamp-derived concurrency (spec §14). Unfinished spans run to trace end. */
export interface ConcurrencyMetrics {
  maxConcurrentAgents: number;
  maxConcurrentToolCalls: number;
  overlappingAgents: AgentOverlap[];
  /**
   * Trace-wide gaps where no span of any kind was open. A root session/agent
   * span covers gaps beneath it; this does not measure an agent waiting on
   * delegated work, which lifecycle events alone cannot establish.
   */
  idleIntervals: IdleInterval[];
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
  /** Filled by reduceEvents (needs the whole span set, not one event). */
  concurrency?: ConcurrencyMetrics;
}

export interface TraceError {
  eventId: string;
  entityId: string;
  /** Agent that owned the failed operation (e.g. the caller of a failed tool). */
  ownerAgentId?: string;
  /** Tool that produced the failure, when a tool was involved. */
  toolId?: string;
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
    parentEventId: event.parentEventId,
  });
}

function closeSpan(
  state: TraceState,
  event: TraceEvent,
  spanKind: SpanKind,
): Span | undefined {
  // Correlated events only pair with the same correlationId; uncorrelated
  // events fall back to the most recent open span of the same entity.
  const candidate = [...state.spans].reverse().find((span) => {
    if (span.status !== "started" || span.kind !== spanKind) return false;
    if (event.correlationId) return span.correlationId === event.correlationId;
    return span.ownerId === event.source.id || span.entityId === event.source.id;
  });
  if (!candidate) return undefined;

  candidate.endEventId = event.eventId;
  candidate.endTime = event.timestamp;
  candidate.durationMs =
    event.durationMs ??
    Date.parse(event.timestamp) - Date.parse(candidate.startTime);
  candidate.status = event.status ?? "success";
  return candidate;
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

function failureOwner(event: TraceEvent, closed?: Span): string | undefined {
  if (event.source.kind === "agent") return event.source.id;
  if (closed) return closed.ownerId;
  return event.destination?.kind === "agent" ? event.destination.id : undefined;
}

/**
 * Total order for events: wall-clock time, then monotonic clock, then
 * eventId. Arrival order never matters, so shuffled input reduces identically.
 */
export function compareEvents(a: TraceEvent, b: TraceEvent): number {
  return (
    Date.parse(a.timestamp) - Date.parse(b.timestamp) ||
    (a.monotonicNs ?? 0) - (b.monotonicNs ?? 0) ||
    (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0)
  );
}

function spanEnd(span: Span, traceEnd: number): number {
  return span.endTime ? Date.parse(span.endTime) : traceEnd;
}

/**
 * Closed spans are [start, end), except zero-length spans count at their
 * instant. Unfinished spans remain active at the last observed timestamp.
 */
function overlapPoints(spans: Span[], traceEnd: number) {
  const points = spans.flatMap((span) => {
    const start = Date.parse(span.startTime);
    const end = spanEnd(span, traceEnd);
    if (end < start) return [];
    const points = [{ t: start, d: 1, order: 1, entityId: span.entityId }];
    if (span.endTime) {
      points.push({ t: end, d: -1, order: end === start ? 2 : 0, entityId: span.entityId });
    }
    return points;
  });
  // Regular ends, then all starts, then instantaneous ends at a timestamp.
  return points.sort((a, b) => a.t - b.t || a.order - b.order);
}

/** Max number of simultaneously open spans (sweep line). */
function maxOverlap(spans: Span[], traceEnd: number): number {
  let open = 0;
  let max = 0;
  for (const p of overlapPoints(spans, traceEnd)) {
    open += p.d;
    max = Math.max(max, open);
  }
  return max;
}

/** Max number of distinct entities active at once, even with nested spans. */
function maxDistinctEntityOverlap(spans: Span[], traceEnd: number): number {
  const activeSpansByEntity = new Map<string, number>();
  let max = 0;
  for (const point of overlapPoints(spans, traceEnd)) {
    const next = (activeSpansByEntity.get(point.entityId) ?? 0) + point.d;
    if (next > 0) activeSpansByEntity.set(point.entityId, next);
    else activeSpansByEntity.delete(point.entityId);
    max = Math.max(max, activeSpansByEntity.size);
  }
  return max;
}

export function computeConcurrency(state: TraceState): ConcurrencyMetrics {
  const { startedAt, endedAt } = state.metrics;
  const traceEnd = endedAt ? Date.parse(endedAt) : 0;
  const iso = (t: number) => new Date(t).toISOString();
  const agents = state.spans.filter((s) => s.kind === "agent");
  const tools = state.spans.filter((s) => s.kind === "tool");

  const overlappingAgents: AgentOverlap[] = [];
  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      const a = agents[i]!;
      const b = agents[j]!;
      if (a.entityId === b.entityId) continue;
      const start = Math.max(Date.parse(a.startTime), Date.parse(b.startTime));
      const end = Math.min(spanEnd(a, traceEnd), spanEnd(b, traceEnd));
      if (end <= start) continue;
      overlappingAgents.push({
        agentIds: [a.entityId, b.entityId],
        agentNames: [a.name, b.name],
        start: iso(start),
        end: iso(end),
        overlapMs: end - start,
      });
    }
  }

  const idleIntervals: IdleInterval[] = [];
  if (startedAt) {
    let cursor = Date.parse(startedAt);
    const ordered = [...state.spans].sort(
      (a, b) => Date.parse(a.startTime) - Date.parse(b.startTime),
    );
    for (const span of ordered) {
      const start = Date.parse(span.startTime);
      if (start > cursor) {
        idleIntervals.push({ start: iso(cursor), end: iso(start), durationMs: start - cursor });
      }
      cursor = Math.max(cursor, spanEnd(span, traceEnd));
    }
    if (traceEnd > cursor) {
      idleIntervals.push({ start: iso(cursor), end: iso(traceEnd), durationMs: traceEnd - cursor });
    }
  }

  return {
    maxConcurrentAgents: maxDistinctEntityOverlap(agents, traceEnd),
    maxConcurrentToolCalls: maxOverlap(tools, traceEnd),
    overlappingAgents,
    idleIntervals,
  };
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
  let closed: Span | undefined;

  switch (event.type) {
    case "session_start":
      openSpan(state, "session", event, "session");
      source.status = "active";
      break;
    case "session_end":
      closed = closeSpan(state, event, "session");
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
      closed = closeSpan(state, event, "agent");
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
      closed = closeSpan(state, event, "tool");
      break;
    case "error":
    case "status_change":
      break;
  }

  if (event.status === "failure") {
    m.failureCount += 1;
    source.status = "failure";
    state.errors.push({
      eventId: event.eventId,
      entityId: event.source.id,
      ownerAgentId: failureOwner(event, closed),
      toolId: [event.source, event.destination].find((e) => e?.kind === "tool")?.id,
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
  for (const event of [...events].sort(compareEvents)) applyEvent(state, event);
  // Performance: O(agent spans²) pair scan; fine for small traces.
  state.metrics.concurrency = computeConcurrency(state);
  return state;
}
