/**
 * Deterministic ask() fallback used when GEMINI_API_KEY is unset
 * (PLAN-integrations Phase 2). Rule-based keyword dispatch over the same
 * executeTraceFunction path Gemini uses — zero LLM, zero fabrication.
 * This is the demo safety net: judges must never see a 501.
 */
import type { Span, TraceEvent, TraceState } from "@agenttrace/protocol";
import { COLLECTOR_URL, executeTraceFunction } from "./query.js";
import type { AssistantAnswer } from "./chat.js";

// Minimal shapes of the collector's deterministic query results.
interface TraceSummary {
  total_ms: number;
  agents: string[];
  event_count: number;
  tool_calls: number;
  messages: number;
  errors: number;
  status: string;
}
interface FailureReport {
  failureCount: number;
  firstFailure?: {
    eventId: string;
    entityId: string;
    timestamp: string;
    message?: string;
  };
}
interface CriticalPath {
  total_ms: number;
  critical_path: { entity: string; durationMs: number }[];
}
interface DuplicateGroup {
  tool: string;
  count: number;
}

type QueryResult<T> = T | { error: string };
type Call = (name: string, args?: Record<string, unknown>) => Promise<unknown>;

function isError(result: unknown): result is { error: string } {
  return typeof result === "object" && result !== null && "error" in result;
}

const seconds = (ms: number) => Math.round(ms / 100) / 10;

function spansOverlap(a: Span, b: Span): boolean {
  if (!a.endTime || !b.endTime) return false;
  const aStart = Date.parse(a.startTime);
  const aEnd = Date.parse(a.endTime);
  const bStart = Date.parse(b.startTime);
  const bEnd = Date.parse(b.endTime);
  if ([aStart, aEnd, bStart, bEnd].some(Number.isNaN)) return false;
  return aStart < bEnd && bStart < aEnd;
}

/** Raw trace read for span timing, which no declared query function exposes. */
async function fetchState(traceId: string): Promise<QueryResult<TraceState>> {
  try {
    const res = await fetch(
      `${COLLECTOR_URL}/v1/traces/${encodeURIComponent(traceId)}`,
    );
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const body = (await res.json()) as { state?: TraceState };
    return body.state ?? { error: "empty trace" };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function failureAnswer(call: Call, traceId: string): Promise<string> {
  const report = (await call("getFailures")) as QueryResult<FailureReport>;
  if (isError(report)) return "Failure data wasn't available for this trace.";
  const first = report.firstFailure;
  if (report.failureCount === 0 || !first) {
    return "No failures were recorded in this trace.";
  }
  let answer = `The first failure occurred in ${first.entityId}`;
  const state = await fetchState(traceId);
  if (!isError(state) && state.events.length > 0) {
    // Ingest order isn't guaranteed chronological — use the earliest event.
    const start = Math.min(
      ...state.events.map((e) => Date.parse(e.timestamp)),
    );
    const t = seconds(Date.parse(first.timestamp) - start);
    if (Number.isFinite(t) && t >= 0) answer += ` at ${t}s`;
  }
  answer += ".";
  if (first.message) answer += ` ${first.message}.`;
  return `${answer} ${report.failureCount} failure(s) total.`;
}

async function latencyAnswer(call: Call): Promise<string> {
  const cp = (await call("getCriticalPath")) as QueryResult<CriticalPath>;
  if (isError(cp)) return "Timing data wasn't available for this trace.";
  const answer = `The run took ${seconds(cp.total_ms)}s.`;
  const top = cp.critical_path.slice(0, 3);
  if (top.length === 0) return `${answer} No finished spans were recorded.`;
  const list = top.map((s) => `${s.entity} (${s.durationMs}ms)`).join(", ");
  return `${answer} Longest spans: ${list}.`;
}

async function parallelAnswer(call: Call, traceId: string): Promise<string> {
  const summary = (await call("getTraceSummary")) as QueryResult<TraceSummary>;
  if (isError(summary)) return "Trace data wasn't available for this trace.";
  const agents = summary.agents;
  if (agents.length <= 1) {
    return `Only ${agents.length} agent(s) ran (${agents[0] ?? "none"}); no parallel agent work.`;
  }
  const ran = `${agents.length} agents ran: ${agents.join(", ")}.`;
  const state = await fetchState(traceId);
  if (isError(state)) {
    return `${ran} Span timing wasn't available to check overlap.`;
  }
  const spans = state.spans.filter((s) => s.kind === "agent");
  const pairs = new Set<string>();
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      if (spans[i].entityId !== spans[j].entityId && spansOverlap(spans[i], spans[j])) {
        pairs.add(`${spans[i].name} + ${spans[j].name}`);
      }
    }
  }
  return pairs.size
    ? `${ran} Overlapping agent spans: ${[...pairs].join(", ")}.`
    : `${ran} No finished agent spans overlapped.`;
}

async function beforeAnswer(call: Call): Promise<string> {
  const report = (await call("getFailures")) as QueryResult<FailureReport>;
  if (isError(report)) return "Failure data wasn't available for this trace.";
  const first = report.firstFailure;
  if (!first) return "No failures were recorded in this trace.";
  const before = (await call("getEventsBefore", {
    eventId: first.eventId,
    count: 5,
  })) as QueryResult<{ events: TraceEvent[] }>;
  if (isError(before)) {
    return "Events preceding the first failure weren't available.";
  }
  if (before.events.length === 0) {
    return `Nothing was recorded before the first failure (${first.entityId}).`;
  }
  const list = before.events
    .map((e) => `${e.type} from ${e.source.name}`)
    .join(", ");
  return `${before.events.length} event(s) preceded the first failure in ${first.entityId}: ${list}.`;
}

async function duplicatesAnswer(call: Call): Promise<string> {
  const result = (await call("getExactDuplicateCalls")) as QueryResult<{
    duplicates: DuplicateGroup[];
  }>;
  if (isError(result)) {
    return "Duplicate-call data wasn't available for this trace.";
  }
  if (result.duplicates.length === 0) {
    return "No exact duplicate tool calls were found.";
  }
  const list = result.duplicates
    .slice(0, 3)
    .map((g) => `${g.tool} called ${g.count} times`)
    .join(", ");
  return `${result.duplicates.length} duplicate call group(s): ${list}.`;
}

async function summaryAnswer(call: Call): Promise<string> {
  const s = (await call("getTraceSummary")) as QueryResult<TraceSummary>;
  if (isError(s)) return "Trace data wasn't available for this trace.";
  const agents = s.agents.length ? s.agents.join(", ") : "none";
  return `Status ${s.status}: ${s.event_count} events, ${s.tool_calls} tool calls, ${s.messages} messages, ${s.errors} error(s), ${seconds(s.total_ms)}s total, agents: ${agents}.`;
}

export async function mockAsk(
  question: string,
  traceId: string,
): Promise<AssistantAnswer> {
  const q = question.toLowerCase();
  const functionsCalled: string[] = [];
  const call: Call = async (name, args = {}) => {
    if (!functionsCalled.includes(name)) functionsCalled.push(name);
    return executeTraceFunction(name, { ...args, traceId });
  };

  let answer: string;
  if (q.includes("before") || q.includes("preced") || q.includes("led up")) {
    answer = await beforeAnswer(call);
  } else if (q.includes("fail") || q.includes("error") || q.includes("wrong")) {
    answer = await failureAnswer(call, traceId);
  } else if (
    q.includes("slow") ||
    q.includes("long") ||
    q.includes("latency") ||
    q.includes("bottleneck") ||
    q.includes("critical")
  ) {
    answer = await latencyAnswer(call);
  } else if (
    q.includes("parallel") ||
    q.includes("concurrent") ||
    q.includes("same time")
  ) {
    answer = await parallelAnswer(call, traceId);
  } else if (
    q.includes("duplicate") ||
    q.includes("redundant") ||
    q.includes("repeated")
  ) {
    answer = await duplicatesAnswer(call);
  } else if (
    q.includes("summary") ||
    q.includes("what happened") ||
    q.includes("overview") ||
    q.includes("status")
  ) {
    answer = await summaryAnswer(call);
  } else {
    answer = `${await summaryAnswer(call)} Ask me about failures, timing, parallelism, or duplicates.`;
  }
  return { answer, functionsCalled };
}
