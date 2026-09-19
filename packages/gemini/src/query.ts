/**
 * Executes Gemini-requested function calls against the collector's
 * deterministic REST API. The model never touches raw events directly —
 * it only receives these structured results.
 */

const COLLECTOR_URL =
  process.env.AGENTTRACE_COLLECTOR_URL ?? "http://localhost:8787";

function pathFor(name: string, args: Record<string, unknown>): string {
  const traceId = encodeURIComponent(String(args.traceId));
  switch (name) {
    case "getTraceSummary":
      return `/v1/traces/${traceId}/summary`;
    case "getAgentActivity":
      return `/v1/traces/${traceId}/agents/${encodeURIComponent(String(args.agentId))}/activity`;
    case "getToolCalls":
      return `/v1/traces/${traceId}/tools${args.toolName ? `?name=${encodeURIComponent(String(args.toolName))}` : ""}`;
    case "getFailures":
      return `/v1/traces/${traceId}/failures`;
    case "getCriticalPath":
      return `/v1/traces/${traceId}/critical-path`;
    case "getEventsBetween":
      return `/v1/traces/${traceId}/events?from=${encodeURIComponent(String(args.start))}&to=${encodeURIComponent(String(args.end))}`;
    case "getEventsBefore":
      return `/v1/traces/${traceId}/events?before=${encodeURIComponent(String(args.eventId))}&count=${Number(args.count ?? 10)}`;
    case "getExactDuplicateCalls":
      return `/v1/traces/${traceId}/duplicates`;
    default:
      throw new Error(`Unknown function: ${name}`);
  }
}

export async function executeTraceFunction(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${COLLECTOR_URL}${pathFor(name, args)}`);
  if (!res.ok) {
    return { error: `query ${name} failed: HTTP ${res.status}` };
  }
  return res.json();
}
