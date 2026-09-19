/**
 * Deterministic failure analysis (spec §14).
 */
import type { TraceState } from "@agenttrace/protocol";

export interface FailureReport {
  failureCount: number;
  firstFailure?: {
    eventId: string;
    entityId: string;
    ownerAgentId?: string;
    toolId?: string;
    timestamp: string;
    message?: string;
    /** Last successful event anywhere in the trace before this failure. */
    lastSuccessfulEventBefore?: string;
  };
  failures: {
    eventId: string;
    entityId: string;
    ownerAgentId?: string;
    toolId?: string;
    timestamp: string;
    message?: string;
  }[];
}

export function getFailures(state: TraceState): FailureReport {
  const first = state.errors[0];
  let lastSuccessBefore: string | undefined;
  if (first) {
    // state.events is already in compareEvents order.
    const failedAt = Date.parse(first.timestamp);
    lastSuccessBefore = [...state.events].reverse().find(
      (e) => Date.parse(e.timestamp) < failedAt && e.status === "success",
    )?.eventId;
  }
  return {
    failureCount: state.errors.length,
    firstFailure: first
      ? { ...first, lastSuccessfulEventBefore: lastSuccessBefore }
      : undefined,
    failures: state.errors.map((e) => ({ ...e })),
  };
}
