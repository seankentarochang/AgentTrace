/**
 * View-model derivation: TraceState -> what the screen draws.
 *
 * Everything here is a pure function of observed events. It aggregates and
 * re-shapes; it never invents an edge, a message or a span (spec §3, §4).
 */
import type {
  Edge,
  Entity,
  EventStatus,
  Span,
  TraceEvent,
  TraceState,
  Visibility,
} from "@agenttrace/protocol";

export const VISIBILITY_RANK: Record<Visibility, number> = {
  full_protocol: 2,
  structured_event: 1,
  lifecycle_only: 0,
};

export const VISIBILITY_LABEL: Record<Visibility, string> = {
  full_protocol: "full protocol",
  structured_event: "structured events",
  lifecycle_only: "lifecycle only",
};

/** Compact form for the graph node badge; the full label stays in the title. */
export const VISIBILITY_SHORT: Record<Visibility, string> = {
  full_protocol: "full",
  structured_event: "structured",
  lifecycle_only: "lifecycle",
};

const LIFECYCLE_TYPES = new Set([
  "agent_start",
  "agent_stop",
  "session_start",
  "session_end",
]);

/**
 * An entity's own start/stop — as opposed to something it did. A lifecycle
 * event that carries a destination is a spawn performed by the source, so
 * it counts as observed activity, not as the source merely existing.
 */
function isOwnLifecycle(event: TraceEvent): boolean {
  return LIFECYCLE_TYPES.has(event.type) && event.destination === undefined;
}

/**
 * One drawn edge per entity pair + kind. The reducer keys edges by
 * direction, so a tool call and its result — or a request and its reply —
 * arrive as two opposing edges. Drawing them as one bidirectional link is
 * aggregation, not invention: every underlying eventId is kept.
 */
export interface ViewEdge {
  id: string;
  sourceId: string;
  targetId: string;
  kind: Edge["kind"];
  /** True when traffic was observed in both directions. */
  bidirectional: boolean;
  /** Chronological, across both directions. */
  eventIds: string[];
  /** Lowest visibility observed — never claim more than this. */
  visibility: Visibility;
  status?: EventStatus;
  /** An operation on this edge is still open. */
  active: boolean;
}

function worseStatus(
  a: EventStatus | undefined,
  b: EventStatus | undefined,
): EventStatus | undefined {
  const rank: Record<EventStatus, number> = {
    failure: 3,
    cancelled: 2,
    started: 1,
    success: 0,
  };
  if (!a) return b;
  if (!b) return a;
  return rank[a] >= rank[b] ? a : b;
}

export function viewEdges(state: TraceState): ViewEdge[] {
  const order = new Map(state.events.map((e, i) => [e.eventId, i]));
  const byPair = new Map<string, ViewEdge>();

  for (const edge of Object.values(state.edges)) {
    const [a, b] = [edge.sourceId, edge.destinationId].sort();
    const key = `${a}|${b}|${edge.kind}`;
    const existing = byPair.get(key);
    if (!existing) {
      byPair.set(key, {
        id: key,
        sourceId: edge.sourceId,
        targetId: edge.destinationId,
        kind: edge.kind,
        bidirectional: false,
        eventIds: [...edge.eventIds],
        visibility: edge.visibility,
        status: edge.status,
        active: false,
      });
      continue;
    }
    // Opposing direction for a pair we already have.
    if (existing.sourceId !== edge.sourceId) existing.bidirectional = true;
    existing.eventIds.push(...edge.eventIds);
    if (VISIBILITY_RANK[edge.visibility] < VISIBILITY_RANK[existing.visibility]) {
      existing.visibility = edge.visibility;
    }
    existing.status = worseStatus(existing.status, edge.status);
  }

  const events = new Map(state.events.map((e) => [e.eventId, e]));
  for (const edge of byPair.values()) {
    edge.eventIds.sort((x, y) => (order.get(x) ?? 0) - (order.get(y) ?? 0));
    const last = events.get(edge.eventIds[edge.eventIds.length - 1] ?? "");
    edge.active = last?.status === "started";
    if (edge.eventIds.some((id) => events.get(id)?.status === "failure")) {
      edge.status = "failure";
    } else if (edge.active) {
      edge.status = "started";
    }
    // Point a merged edge the way the first observed event pointed.
    const first = events.get(edge.eventIds[0] ?? "");
    if (first?.destination) {
      edge.sourceId = first.source.id;
      edge.targetId = first.destination.id;
    }
  }

  return [...byPair.values()];
}

export interface EntityView {
  entity: Entity;
  /** Highest visibility observed on events this entity originated. */
  visibility?: Visibility;
  /**
   * The entity was observed running, but nothing it did in between was
   * captured. Rendered as an explicit "?" boundary (spec §4 UNOBSERVABLE)
   * rather than a blank the viewer might read as "did nothing".
   */
  interiorUnobserved: boolean;
  spanCount: number;
}

export function entityViews(state: TraceState): EntityView[] {
  const originated = new Map<string, TraceEvent[]>();
  for (const event of state.events) {
    const list = originated.get(event.source.id) ?? [];
    list.push(event);
    originated.set(event.source.id, list);
  }

  return Object.values(state.entities).map((entity) => {
    const own = originated.get(entity.ref.id) ?? [];
    const visibility = own.reduce<Visibility | undefined>(
      (best, e) =>
        best === undefined || VISIBILITY_RANK[e.visibility] > VISIBILITY_RANK[best]
          ? e.visibility
          : best,
      undefined,
    );
    const hasLifecycle = own.some(
      (e) =>
        (e.type === "agent_start" || e.type === "session_start") &&
        e.destination === undefined,
    );
    // Anything that is not this entity's own start/stop is observed activity.
    const hasInterior = own.some((e) => !isOwnLifecycle(e));
    return {
      entity,
      visibility,
      interiorUnobserved:
        entity.ref.kind === "agent" && hasLifecycle && !hasInterior,
      spanCount: state.spans.filter((s) => s.entityId === entity.ref.id).length,
    };
  });
}

/** Timeline rows: each agent followed by the tool spans it owns. */
export interface TimelineRow {
  key: string;
  entityId: string;
  label: string;
  kind: Span["kind"];
  /** Nesting depth — session 0, agent 1, tool 2. */
  depth: number;
  spans: Span[];
}

export function timelineRows(state: TraceState): TimelineRow[] {
  const firstSeen = (id: string) => state.entities[id]?.firstSeen ?? "";
  const name = (id: string) => state.entities[id]?.ref.name ?? id;

  const sessions = state.spans.filter((s) => s.kind === "session");
  const agentSpans = state.spans.filter((s) => s.kind === "agent");
  const other = state.spans.filter(
    (s) => s.kind !== "session" && s.kind !== "agent",
  );

  const rows: TimelineRow[] = [];

  for (const session of sessions) {
    rows.push({
      key: `session:${session.id}`,
      entityId: session.entityId,
      label: session.name,
      kind: "session",
      depth: 0,
      spans: [session],
    });
  }

  const agentIds = [...new Set(agentSpans.map((s) => s.entityId))].sort((a, b) =>
    firstSeen(a) < firstSeen(b) ? -1 : 1,
  );

  const claimed = new Set<string>();
  for (const agentId of agentIds) {
    rows.push({
      key: `agent:${agentId}`,
      entityId: agentId,
      label: name(agentId),
      kind: "agent",
      depth: 1,
      spans: agentSpans.filter((s) => s.entityId === agentId),
    });

    // Tool/model spans this agent initiated, one row per callee.
    const owned = other.filter((s) => s.ownerId === agentId);
    const calleeIds = [...new Set(owned.map((s) => s.entityId))].sort((a, b) =>
      firstSeen(a) < firstSeen(b) ? -1 : 1,
    );
    for (const calleeId of calleeIds) {
      const spans = owned.filter((s) => s.entityId === calleeId);
      for (const s of spans) claimed.add(s.id);
      rows.push({
        key: `tool:${agentId}:${calleeId}`,
        entityId: calleeId,
        label: name(calleeId),
        kind: spans[0]?.kind ?? "tool",
        depth: 2,
        spans,
      });
    }
  }

  // Spans whose owner never produced an agent span still deserve a row.
  const orphans = other.filter((s) => !claimed.has(s.id));
  const orphanIds = [...new Set(orphans.map((s) => s.entityId))].sort((a, b) =>
    firstSeen(a) < firstSeen(b) ? -1 : 1,
  );
  for (const entityId of orphanIds) {
    rows.push({
      key: `orphan:${entityId}`,
      entityId,
      label: name(entityId),
      kind: "tool",
      depth: 1,
      spans: orphans.filter((s) => s.entityId === entityId),
    });
  }

  return rows;
}

/** Other events sharing this event's correlationId, in order. */
export function relatedEvents(
  state: TraceState,
  event: TraceEvent,
): TraceEvent[] {
  if (!event.correlationId) return [];
  return state.events.filter(
    (e) => e.correlationId === event.correlationId && e.eventId !== event.eventId,
  );
}

/** The span an event opened or closed, if any. */
export function spanForEvent(state: TraceState, eventId: string): Span | undefined {
  return state.spans.find(
    (s) => s.startEventId === eventId || s.endEventId === eventId,
  );
}

/** Milliseconds from the start of the trace. */
export function offsetMs(state: TraceState, timestamp: string): number {
  const start = state.metrics.startedAt;
  if (!start) return 0;
  return Date.parse(timestamp) - Date.parse(start);
}

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return "?";
  if (Math.abs(ms) < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
