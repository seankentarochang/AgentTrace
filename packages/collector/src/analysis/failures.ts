/**
 * Deterministic failure analysis (spec §14).
 */
import type { TraceState } from "@agenttrace/protocol";

export interface FailureReport {
  failureCount: number;
  firstFailure?: {
    eventId: string;
    entityId: string;
    timestamp: string;
    message?: string;
    /** Last successful event anywhere in the trace before this failure. */
    lastSuccessfulEventBefore?: string;
  };
  failures: {
    eventId: string;
    entityId: string;
    timestamp: string;
    message?: string;
  }[];
}

export function getFailures(state: TraceState): FailureReport {
  const first = state.errors[0];
  let lastSuccessBefore: string | undefined;
  if (first) {
    const prior = state.events
      .filter((e) => e.timestamp < first.timestamp && e.status === "success")
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
    lastSuccessBefore = prior[0]?.eventId;
  }
  return {
    failureCount: state.errors.length,
    firstFailure: first
      ? { ...first, lastSuccessfulEventBefore: lastSuccessBefore }
      : undefined,
    failures: state.errors.map((e) => ({ ...e })),
  };
}
