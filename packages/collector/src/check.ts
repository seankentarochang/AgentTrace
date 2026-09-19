/**
 * Backend self-check: `npm run check -w @agenttrace/collector`.
 * Asserts the Track 1 done-criteria against the demo fixture.
 */
import assert from "node:assert/strict";
import { demoTraceEvents, reduceEvents, type TraceEvent } from "@agenttrace/protocol";
import { getFailures } from "./analysis/failures.js";
import { getCriticalPath } from "./analysis/timings.js";

const a = reduceEvents(demoTraceEvents);
const b = reduceEvents(demoTraceEvents);
assert.deepEqual(a, b, "same stream -> identical state");

// Arrival order must not matter — reversing also flips every timestamp tie.
assert.deepEqual(reduceEvents([...demoTraceEvents].reverse()), a, "reversed stream -> identical state");

const failures = getFailures(a);
assert.equal(failures.firstFailure?.eventId, "evt_09");
assert.equal(failures.firstFailure?.ownerAgentId, "agent_reviewer");
assert.equal(failures.firstFailure?.toolId, "tool_shell");
assert.equal(failures.firstFailure?.lastSuccessfulEventBefore, "evt_08");

const c = a.metrics.concurrency!;
assert.equal(c.maxConcurrentAgents, 3);
assert.equal(c.maxConcurrentToolCalls, 2);
const rr = c.overlappingAgents.find((o) => o.agentIds.includes("agent_researcher") && o.agentIds.includes("agent_reviewer"));
assert.equal(rr?.overlapMs, 2112 - 52);

assert.deepEqual(
  getCriticalPath(a).critical_path.map((e) => e.entity),
  ["agent_coordinator", "agent_researcher", "tool_file_search"],
);

const makeEvent = (
  event: Partial<TraceEvent> &
    Pick<TraceEvent, "eventId" | "timestamp" | "source" | "category" | "type">,
): TraceEvent => ({
  schemaVersion: 1,
  traceId: "trace_regression",
  visibility: "structured_event",
  provider: { adapter: "custom", adapterVersion: "1" },
  ...event,
});

// parentEventId must connect session -> agent -> tool into one causal path.
const causalAgent = { id: "agent_causal", kind: "agent" as const, name: "Causal" };
const causalTool = { id: "tool_causal", kind: "tool" as const, name: "shell" };
const causalState = reduceEvents([
  makeEvent({
    eventId: "causal_session_start",
    timestamp: "2026-01-01T00:00:00.000Z",
    source: causalAgent,
    category: "system",
    type: "session_start",
    status: "started",
  }),
  makeEvent({
    eventId: "causal_agent_start",
    timestamp: "2026-01-01T00:00:00.100Z",
    source: causalAgent,
    category: "agent",
    type: "agent_start",
    parentEventId: "causal_session_start",
    status: "started",
  }),
  makeEvent({
    eventId: "causal_tool_call",
    timestamp: "2026-01-01T00:00:00.200Z",
    source: causalAgent,
    destination: causalTool,
    category: "tool",
    type: "tool_call",
    correlationId: "causal_call",
    parentEventId: "causal_agent_start",
    status: "started",
  }),
  makeEvent({
    eventId: "causal_tool_result",
    timestamp: "2026-01-01T00:00:00.800Z",
    source: causalTool,
    destination: causalAgent,
    category: "tool",
    type: "tool_result",
    correlationId: "causal_call",
    parentEventId: "causal_tool_call",
    status: "success",
  }),
  makeEvent({
    eventId: "causal_agent_stop",
    timestamp: "2026-01-01T00:00:00.900Z",
    source: causalAgent,
    category: "agent",
    type: "agent_stop",
    status: "success",
  }),
  makeEvent({
    eventId: "causal_session_end",
    timestamp: "2026-01-01T00:00:01.000Z",
    source: causalAgent,
    category: "system",
    type: "session_end",
    status: "success",
  }),
]);
assert.deepEqual(
  getCriticalPath(causalState).critical_path.map((entry) => entry.spanId),
  [
    "session:causal_session_start",
    "agent:agent_causal:causal_agent_start",
    "tool:causal_call:causal_tool_call",
  ],
);

// Concurrent spans from one agent still represent one concurrent agent.
const repeatedAgentEvents: TraceEvent[] = [
  makeEvent({
    eventId: "repeat_start_1",
    timestamp: "2026-01-01T00:00:00.000Z",
    source: causalAgent,
    category: "agent",
    type: "agent_start",
    correlationId: "repeat_1",
    status: "started",
  }),
  makeEvent({
    eventId: "repeat_start_2",
    timestamp: "2026-01-01T00:00:00.100Z",
    source: causalAgent,
    category: "agent",
    type: "agent_start",
    correlationId: "repeat_2",
    status: "started",
  }),
  makeEvent({
    eventId: "repeat_stop_1",
    timestamp: "2026-01-01T00:00:01.000Z",
    source: causalAgent,
    category: "agent",
    type: "agent_stop",
    correlationId: "repeat_1",
    status: "success",
  }),
  makeEvent({
    eventId: "repeat_stop_2",
    timestamp: "2026-01-01T00:00:01.100Z",
    source: causalAgent,
    category: "agent",
    type: "agent_stop",
    correlationId: "repeat_2",
    status: "success",
  }),
];
const repeatedAgentState = reduceEvents(repeatedAgentEvents);
assert.equal(repeatedAgentState.metrics.concurrency?.maxConcurrentAgents, 1);
assert.deepEqual(repeatedAgentState.metrics.concurrency?.overlappingAgents, []);

// A correlated result must not close an uncorrelated span of the same tool.
const [call] = demoTraceEvents.filter((e) => e.eventId === "evt_06");
const stray: TraceEvent = { ...call!, eventId: "x_result", type: "tool_result", correlationId: "call_other", timestamp: "2026-09-19T15:40:00.300Z" };
const s = reduceEvents([{ ...call!, correlationId: undefined }, stray]);
assert.equal(s.spans[0]!.status, "started");

console.log("backend check: ok");
