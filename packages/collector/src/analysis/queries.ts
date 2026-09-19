/**
 * The deterministic query API — the exact functions Gemini is allowed to
 * call (spec §19). REST routes and the Gemini module both dispatch through
 * here so there is one implementation.
 */
import type { TraceEvent, TraceState } from "@agenttrace/protocol";
import { getCriticalPath, getEventsBefore, getEventsBetween } from "./timings.js";
import { getFailures } from "./failures.js";
import { getExactDuplicateCalls } from "./duplicates.js";

export function getTraceSummary(state: TraceState) {
  return {
    traceId: state.traceId,
    total_ms: state.metrics.totalDurationMs ?? 0,
    agents: Object.values(state.entities)
      .filter((e) => e.ref.kind === "agent")
      .map((e) => e.ref.name),
    event_count: state.metrics.eventCount,
    tool_calls: state.metrics.toolCallCount,
    messages: state.metrics.messageCount,
    errors: state.metrics.failureCount,
    status: state.metrics.failureCount > 0 ? "failure" : "ok",
  };
}

export function getAgentActivity(state: TraceState, agentId: string) {
  return state.events.filter(
    (e) => e.source.id === agentId || e.destination?.id === agentId,
  );
}

export function getToolCalls(state: TraceState, toolName?: string) {
  return state.events.filter(
    (e) =>
      (e.type === "tool_call" || e.type === "tool_result") &&
      (!toolName || e.source.name === toolName || e.destination?.name === toolName),
  );
}

export { getCriticalPath, getFailures, getEventsBefore, getExactDuplicateCalls };

export function getEventsBetweenIds(
  events: TraceEvent[],
  start: string,
  end: string,
) {
  return getEventsBetween(events, start, end);
}

/**
 * Name-based dispatch used by the Gemini function-calling layer.
 * Names must match the declarations in packages/gemini/src/tools.ts.
 */
export function runQuery(
  name: string,
  args: Record<string, unknown>,
  state: TraceState,
): unknown {
  switch (name) {
    case "getTraceSummary":
      return getTraceSummary(state);
    case "getAgentActivity":
      return getAgentActivity(state, String(args.agentId));
    case "getToolCalls":
      return getToolCalls(state, args.toolName as string | undefined);
    case "getFailures":
      return getFailures(state);
    case "getCriticalPath":
      return getCriticalPath(state);
    case "getEventsBetween":
      return getEventsBetween(state.events, String(args.start), String(args.end));
    case "getEventsBefore":
      return getEventsBefore(
        state.events,
        String(args.eventId),
        Number(args.count ?? 10),
      );
    case "getExactDuplicateCalls":
      return getExactDuplicateCalls(state.events);
    default:
      throw new Error(`Unknown query function: ${name}`);
  }
}
