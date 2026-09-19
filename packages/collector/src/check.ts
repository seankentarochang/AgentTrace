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

// A correlated result must not close an uncorrelated span of the same tool.
const [call] = demoTraceEvents.filter((e) => e.eventId === "evt_06");
const stray: TraceEvent = { ...call!, eventId: "x_result", type: "tool_result", correlationId: "call_other", timestamp: "2026-09-19T15:40:00.300Z" };
const s = reduceEvents([{ ...call!, correlationId: undefined }, stray]);
assert.equal(s.spans[0]!.status, "started");

console.log("backend check: ok");
