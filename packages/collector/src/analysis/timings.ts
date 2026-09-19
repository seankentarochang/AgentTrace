/**
 * Deterministic timing analysis. No LLM anywhere in this pipeline.
 */
import type { Span, TraceEvent, TraceState } from "@agenttrace/protocol";

export interface CriticalPathEntry {
  entity: string;
  spanId: string;
  durationMs: number;
}

/**
 * MVP version: returns the longest finished spans, ordered by duration.
 * TODO(track-1): compute a true critical path over the dependency DAG
 * (parent/child spans via correlationId) instead of top-N spans.
 */
export function getCriticalPath(state: TraceState): {
  total_ms: number;
  critical_path: CriticalPathEntry[];
} {
  const finished = state.spans
    .filter((s) => s.durationMs !== undefined)
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0));
  return {
    total_ms: state.metrics.totalDurationMs ?? 0,
    critical_path: finished.map((s) => ({
      entity: s.entityId,
      spanId: s.id,
      durationMs: s.durationMs ?? 0,
    })),
  };
}

export function getEventsBetween(
  events: TraceEvent[],
  start: string,
  end: string,
): TraceEvent[] {
  return events
    .filter((e) => e.timestamp >= start && e.timestamp <= end)
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
}

export function getEventsBefore(
  events: TraceEvent[],
  eventId: string,
  count: number,
): TraceEvent[] {
  const ordered = [...events].sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : 1,
  );
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
