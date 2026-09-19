/** Regression checks for PR #1: real emitters, concurrency boundaries, seed HTTP. */
import assert from "node:assert/strict";
import { mock } from "node:test";
import { demoTraceEvents, reduceEvents, type TraceEvent } from "@agenttrace/protocol";
import { emitEvent } from "../../adapters/src/emit.js";
import { emit } from "../../../demo/multi-agent-example/src/emit.js";

const at = (ms: number) => new Date(Date.UTC(2026, 0, 1) + ms).toISOString();
const agent = { id: "agent_a", kind: "agent" as const, name: "A" };
const tool = { id: "tool_a", kind: "tool" as const, name: "Tool" };
const event = (overrides: Partial<TraceEvent>): TraceEvent => ({
  ...demoTraceEvents[0]!,
  timestamp: at(0),
  source: agent,
  ...overrides,
});

// Adversarial UUID order: the closer sorts before the opener without a clock.
for (const send of [emitEvent, emit]) {
  const sent: TraceEvent[] = [];
  const fetchMock = mock.method(globalThis, "fetch", async (...[_url, options]: Parameters<typeof fetch>) => {
    sent.push(JSON.parse(String(options?.body)).event);
    return new Response(null, { status: 202 });
  });
  try {
    for (const [open, close, category] of [
      ["agent_start", "agent_stop", "agent"],
      ["session_start", "session_end", "system"],
      ["tool_call", "tool_result", "tool"],
    ] as const) {
      sent.length = 0;
      const start = event({
        eventId: "ffffffff-ffff-4fff-8fff-ffffffffffff", type: open, category,
        destination: category === "tool" ? tool : undefined, correlationId: "pair",
      });
      const end = event({
        eventId: "00000000-0000-4000-8000-000000000000", type: close, category,
        source: category === "tool" ? tool : agent,
        destination: category === "tool" ? agent : undefined,
        correlationId: "pair", status: "success",
      });
      await Promise.all([send(start), send(end)]);
      assert.ok(sent[0]!.monotonicNs! < sent[1]!.monotonicNs!);
      assert.equal(start.monotonicNs, undefined, "emitter must not mutate caller's event");
      const state = reduceEvents(sent);
      assert.equal(state.spans.length, 1);
      assert.equal(state.spans[0]!.status, "success");
      assert.equal(state.spans[0]!.durationMs, 0);
      assert.deepEqual(reduceEvents([...sent].reverse()), state);
    }
    sent.length = 0;
    await send(event({ monotonicNs: 123 }));
    assert.equal(sent[0]!.monotonicNs, 123, "preserve an upstream clock");
    fetchMock.mock.mockImplementation(async () => { throw new Error("offline"); });
    await send(event({})); // Both helpers remain best-effort when offline.
  } finally {
    fetchMock.mock.restore();
  }
}

const agentStart = event({ eventId: "a_start" });
const toolStart = event({ eventId: "t_start", type: "tool_call", category: "tool", destination: tool });
assert.equal(reduceEvents([agentStart]).metrics.concurrency!.maxConcurrentAgents, 1);
assert.equal(reduceEvents([toolStart]).metrics.concurrency!.maxConcurrentToolCalls, 1);

// Newly opened work counts alongside older work still open at traceEnd.
const anotherAgent = event({
  eventId: "b_start", timestamp: at(10), source: { ...agent, id: "agent_b" },
});
const anotherTool = { ...toolStart, eventId: "t_start_2", timestamp: at(10) };
const live = reduceEvents([agentStart, toolStart, anotherAgent, anotherTool]).metrics.concurrency!;
assert.equal(live.maxConcurrentAgents, 2);
assert.equal(live.maxConcurrentToolCalls, 2);
assert.equal(reduceEvents([agentStart, { ...anotherAgent, source: agent }]).metrics.concurrency!.maxConcurrentAgents, 1);

// Completed instantaneous spans count at their instant; touching positive
// intervals do not overlap. Exercise both the entity and tool sweeps.
for (const start of [agentStart, toolStart]) {
  const isTool = start.type === "tool_call";
  const peak = (events: TraceEvent[]) => {
    const c = reduceEvents(events).metrics.concurrency!;
    return isTool ? c.maxConcurrentToolCalls : c.maxConcurrentAgents;
  };
  const stop = {
    ...start, eventId: "stop", type: isTool ? "tool_result" as const : "agent_stop" as const,
    status: "success" as const, monotonicNs: 2,
  };
  const first = { ...start, monotonicNs: 1, correlationId: "first" };
  const second = {
    ...first, eventId: "second", timestamp: at(10), correlationId: "second",
    source: { ...agent, id: "agent_b" },
  };
  assert.equal(peak([first, { ...stop, correlationId: "first" }]), 1);
  assert.equal(peak([
    first, { ...stop, correlationId: "first", timestamp: at(10) },
    second, { ...stop, eventId: "second_stop", correlationId: "second", timestamp: at(20) },
  ]), 1);
  assert.equal(peak([
    first, { ...stop, correlationId: "first", timestamp: at(20) },
    second, { ...stop, eventId: "second_stop", correlationId: "second", timestamp: at(10) },
  ]), 2);
}

// Idle is explicitly trace-wide, not inferred waiting time under a root span.
assert.deepEqual(reduceEvents(demoTraceEvents).metrics.concurrency!.idleIntervals, []);
const gapEvents = [
  agentStart,
  event({ eventId: "a_stop", type: "agent_stop", timestamp: at(10), status: "success" }),
  { ...anotherAgent, timestamp: at(20) },
  event({ eventId: "later", type: "status_change", timestamp: at(30) }),
];
assert.deepEqual(reduceEvents(gapEvents).metrics.concurrency!.idleIntervals, [
  { start: at(10), end: at(20), durationMs: 10 },
]);

// Use the actual HTTP routes and ingest pipeline, in memory only.
delete process.env.AGENTTRACE_DATA_DIR;
const { app } = await import("./server.js");
app.log.level = "silent";
await app.ready();
const seed = async (realtime = false) => {
  const response = await app.inject({ method: "POST", url: `/v1/dev/seed${realtime ? "?realtime=1" : ""}` });
  assert.equal(response.statusCode, 202);
  return response.json();
};
const read = async (traceId: string) => {
  const response = await app.inject({ method: "GET", url: `/v1/traces/${traceId}` });
  assert.equal(response.statusCode, 200);
  return response.json() as { events: TraceEvent[] };
};
try {
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.UTC(2026, 0, 1) });
  const first = await seed();
  const second = await seed();
  assert.notEqual(first.traceId, second.traceId, "same-ms seeds must be independent");
  const firstEvents = (await read(first.traceId)).events;
  const secondEvents = (await read(second.traceId)).events;
  assert.equal(first.accepted, demoTraceEvents.length);
  assert.equal(first.accepted, firstEvents.length);
  assert.equal(second.accepted, secondEvents.length);
  assert.equal(new Set([...firstEvents, ...secondEvents].map((e) => e.eventId)).size, 28);

  // If the fixture contains a duplicate, accepted must reflect stored events.
  const originalLength = demoTraceEvents.length;
  demoTraceEvents.push(demoTraceEvents[0]!);
  try {
    const deduped = await seed();
    assert.equal(deduped.accepted, originalLength);
    assert.equal((await read(deduped.traceId)).events.length, originalLength);
  } finally {
    demoTraceEvents.length = originalLength;
  }

  const oldReplay = await seed(true);
  mock.timers.tick(1);
  assert.equal((await read(oldReplay.traceId)).events.length, 1);
  const newReplay = await seed(true);
  mock.timers.tick(4000);
  assert.equal((await read(oldReplay.traceId)).events.length, 1, "reseed cancels previous timers");
  assert.equal((await read(newReplay.traceId)).events.length, newReplay.scheduled);

  const interrupted = await seed(true);
  mock.timers.tick(1);
  await seed();
  mock.timers.tick(4000);
  assert.equal((await read(interrupted.traceId)).events.length, 1, "immediate seed also cancels replay");
} finally {
  await app.close();
  mock.timers.reset();
}
console.log("PR review regression checks: ok");
