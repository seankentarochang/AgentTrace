/**
 * Executes Gemini-requested function calls against the collector's
 * deterministic REST API. The model never touches raw events directly —
 * it only receives these structured results.
 *
 * Args are validated app-side before dispatch (spec §19). Validation and
 * HTTP failures come back as { error } so they can be fed to the model as
 * a normal function response instead of throwing.
 */

/** Lazy env read — this module also ships to the dashboard, where `process`
 *  doesn't exist at import time. */
export function collectorUrl(): string {
  return process.env.AGENTTRACE_COLLECTOR_URL ?? "http://localhost:8787";
}

const KNOWN_FUNCTIONS = new Set([
  "getTraceSummary",
  "getAgentActivity",
  "getToolCalls",
  "getFailures",
  "getCriticalPath",
  "getConcurrency",
  "getEventsBetween",
  "getEventsBefore",
  "getExactDuplicateCalls",
]);

export function pathFor(name: string, args: Record<string, unknown>): string {
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
    case "getConcurrency":
      return `/v1/traces/${traceId}/concurrency`;
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Semantic validation of model-produced args (spec §19). */
export function validateArgs(
  name: string,
  args: Record<string, unknown>,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  if (!KNOWN_FUNCTIONS.has(name)) {
    return { ok: false, error: `unknown function: ${name}` };
  }
  if (!isNonEmptyString(args.traceId)) {
    return { ok: false, error: `${name}: traceId must be a non-empty string` };
  }
  switch (name) {
    case "getAgentActivity":
      if (!isNonEmptyString(args.agentId)) {
        return { ok: false, error: "getAgentActivity: agentId must be a non-empty string" };
      }
      break;
    case "getToolCalls":
      if (args.toolName !== undefined && typeof args.toolName !== "string") {
        return { ok: false, error: "getToolCalls: toolName must be a string" };
      }
      break;
    case "getEventsBetween": {
      const normalized = { ...args };
      for (const key of ["start", "end"] as const) {
        const value = args[key];
        if (!isNonEmptyString(value) || Number.isNaN(Date.parse(value))) {
          return { ok: false, error: `getEventsBetween: ${key} must be a valid date string` };
        }
        // Normalize to ISO — the endpoint compares lexically against ISO
        // timestamps, so "2026-09-19" would silently miss same-day events.
        normalized[key] = new Date(Date.parse(value)).toISOString();
      }
      args = normalized;
      break;
    }
    case "getEventsBefore": {
      if (!isNonEmptyString(args.eventId)) {
        return { ok: false, error: "getEventsBefore: eventId must be a non-empty string" };
      }
      if (args.count !== undefined) {
        const count = Number(args.count);
        if (!Number.isFinite(count)) {
          return { ok: false, error: "getEventsBefore: count must be a number" };
        }
        args = { ...args, count: Math.min(50, Math.max(1, Math.round(count))) };
      }
      break;
    }
  }
  return { ok: true, args };
}

export async function executeTraceFunction(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const validated = validateArgs(name, args);
  if (!validated.ok) return { error: validated.error };
  try {
    const res = await fetch(`${collectorUrl()}${pathFor(name, validated.args)}`);
    if (!res.ok) {
      return { error: `query ${name} failed: HTTP ${res.status}` };
    }
    return await res.json();
  } catch (err) {
    return { error: `query ${name} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
