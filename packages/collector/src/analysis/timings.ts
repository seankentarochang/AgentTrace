/**
 * Deterministic timing analysis. No LLM anywhere in this pipeline.
 */
import {
  compareEvents,
  type Span,
  type TraceEvent,
  type TraceState,
} from "@agenttrace/protocol";

export interface CriticalPathEntry {
  entity: string;
  spanId: string;
  durationMs: number;
  startTime: string;
  endTime?: string;
}

/**
 * Parent of each span, from explicit IDs only (invariant 5):
 * - parentEventId links directly to the span opened by that event, or to the
 *   agent span containing a non-span event such as a delegation message;
 * - correlationId links a delegated agent span to the observed sender;
 * - a tool span falls back to its explicit owner agent when no parent event
 *   was captured.
 * Anything else is a root.
 */
function parentOf(span: Span, state: TraceState): Span | undefined {
  const start = Date.parse(span.startTime);
  const containingAgentSpan = (agentId: string, at: number) =>
    state.spans
      .filter(
        (candidate) =>
          candidate !== span &&
          candidate.kind === "agent" &&
          candidate.entityId === agentId &&
          Date.parse(candidate.startTime) <= at &&
          (!candidate.endTime || Date.parse(candidate.endTime) >= at),
      )
      .sort(
        (a, b) =>
          Date.parse(b.startTime) - Date.parse(a.startTime) ||
          a.id.localeCompare(b.id),
      )[0];

  if (span.parentEventId) {
    const directParent = state.spans.find(
      (candidate) =>
        candidate !== span &&
        (candidate.startEventId === span.parentEventId ||
          candidate.endEventId === span.parentEventId) &&
        Date.parse(candidate.startTime) <= start,
    );
    if (directParent) return directParent;

    const parentEvent = state.events.find(
      (event) => event.eventId === span.parentEventId,
    );
    if (parentEvent) {
      const containing = containingAgentSpan(
        parentEvent.source.id,
        Date.parse(parentEvent.timestamp),
      );
      if (containing) return containing;
    }
  }

  if (span.kind === "agent" && span.correlationId) {
    const delegation = state.events.find(
      (e) =>
        e.type === "agent_message" &&
        e.correlationId === span.correlationId &&
        e.destination?.id === span.entityId &&
        e.source.id !== span.entityId,
    );
    if (delegation) {
      return containingAgentSpan(
        delegation.source.id,
        Date.parse(delegation.timestamp),
      );
    }
  }
  if (span.kind === "tool") return containingAgentSpan(span.ownerId, start);
  return undefined;
}

/**
 * Critical path over the explicit span dependency forest: start at the root
 * that ends last, then repeatedly descend into its latest-ending child. Only
 * one child is selected at each branch; siblings are not treated as causally
 * dependent on one another.
 * Unfinished spans are treated as running until the end of the trace.
 */
export function getCriticalPath(state: TraceState): {
  total_ms: number;
  critical_path: CriticalPathEntry[];
} {
  const traceEnd = state.metrics.endedAt ? Date.parse(state.metrics.endedAt) : 0;
  const end = (s: Span) => (s.endTime ? Date.parse(s.endTime) : traceEnd);
  const byEndDesc = (a: Span, b: Span) =>
    end(b) - end(a) ||
    Date.parse(a.startTime) - Date.parse(b.startTime) ||
    a.id.localeCompare(b.id);

  const children = new Map<Span | undefined, Span[]>();
  for (const span of state.spans) {
    const parent = parentOf(span, state);
    children.set(parent, [...(children.get(parent) ?? []), span]);
  }

  const path: Span[] = [];
  let current = [...(children.get(undefined) ?? [])].sort(byEndDesc)[0];
  const visited = new Set<Span>();
  while (current && !visited.has(current)) {
    path.push(current);
    visited.add(current);
    current = [...(children.get(current) ?? [])].sort(byEndDesc)[0];
  }

  return {
    total_ms: state.metrics.totalDurationMs ?? 0,
    critical_path: path
      .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime))
      .map((s) => ({
        entity: s.entityId,
        spanId: s.id,
        durationMs: s.durationMs ?? end(s) - Date.parse(s.startTime),
        startTime: s.startTime,
        endTime: s.endTime,
      })),
  };
}

export function getEventsBetween(
  events: TraceEvent[],
  start: string,
  end: string,
): TraceEvent[] {
  const from = Date.parse(start);
  const to = Date.parse(end);
  return events
    .filter((e) => {
      const t = Date.parse(e.timestamp);
      return t >= from && t <= to;
    })
    .sort(compareEvents);
}

export function getEventsBefore(
  events: TraceEvent[],
  eventId: string,
  count: number,
): TraceEvent[] {
  const ordered = [...events].sort(compareEvents);
  const index = ordered.findIndex((e) => e.eventId === eventId);
  if (index === -1) return [];
  return ordered.slice(Math.max(0, index - count), index);
}

export function durationByEntity(spans: Span[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const span of spans) {
    if (span.durationMs === undefined) continue;
    result[span.entityId] = (result[span.entityId] ?? 0) + span.durationMs;
  }
  return result;
}
