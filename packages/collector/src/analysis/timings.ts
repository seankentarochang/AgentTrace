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
 * - a tool span belongs to the owning agent's span that was open when it started;
 * - an agent span started under task X belongs to whichever agent sent the
 *   agent_message carrying correlationId X (the delegation).
 * Anything else is a root.
 */
function parentOf(span: Span, state: TraceState): Span | undefined {
  const start = Date.parse(span.startTime);
  const openAgentSpan = (agentId: string) =>
    state.spans.find(
      (s) =>
        s !== span &&
        s.kind === "agent" &&
        s.entityId === agentId &&
        Date.parse(s.startTime) <= start &&
        (!s.endTime || Date.parse(s.endTime) >= start),
    );

  if (span.kind === "tool") return openAgentSpan(span.ownerId);
  if (span.kind === "agent" && span.correlationId) {
    const delegation = state.events.find(
      (e) =>
        e.type === "agent_message" &&
        e.correlationId === span.correlationId &&
        e.destination?.id === span.entityId &&
        e.source.id !== span.entityId,
    );
    if (delegation) return openAgentSpan(delegation.source.id);
  }
  return undefined;
}

/**
 * Critical path over the span tree: start at the root that ends last, then
 * repeatedly descend into the child that ends last before the current cursor
 * (the classic "what was the parent actually waiting on" walk).
 * Unfinished spans are treated as running until the end of the trace.
 */
export function getCriticalPath(state: TraceState): {
  total_ms: number;
  critical_path: CriticalPathEntry[];
} {
  const traceEnd = state.metrics.endedAt ? Date.parse(state.metrics.endedAt) : 0;
  const end = (s: Span) => (s.endTime ? Date.parse(s.endTime) : traceEnd);
  const byEndDesc = (a: Span, b: Span) => end(b) - end(a);

  const children = new Map<Span | undefined, Span[]>();
  for (const span of state.spans) {
    const parent = parentOf(span, state);
    children.set(parent, [...(children.get(parent) ?? []), span]);
  }

  const path: Span[] = [];
  const walk = (span: Span) => {
    path.push(span);
    let cursor = end(span);
    for (const child of [...(children.get(span) ?? [])].sort(byEndDesc)) {
      if (end(child) > cursor) continue;
      walk(child);
      cursor = Date.parse(child.startTime);
    }
  };
  const root = [...(children.get(undefined) ?? [])].sort(byEndDesc)[0];
  if (root) walk(root);

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
