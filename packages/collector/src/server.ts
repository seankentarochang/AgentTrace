/**
 * Trace collector (spec §13).
 *
 *   POST /v1/events                      ingest one TraceEvent
 *   GET  /v1/traces                      list trace summaries
 *   GET  /v1/traces/:traceId             events + reduced TraceState
 *   GET  /v1/traces/:traceId/summary     deterministic queries (spec §19)
 *   GET  /v1/traces/:traceId/agents/:agentId/activity
 *   GET  /v1/traces/:traceId/tools?name=
 *   GET  /v1/traces/:traceId/failures
 *   GET  /v1/traces/:traceId/critical-path
 *   GET  /v1/traces/:traceId/duplicates
 *   GET  /v1/traces/:traceId/events?from&to | ?before=<eventId>&count=
 *   POST /v1/assistant                   Gemini NL query (Track 3)
 *   WS   /v1/live                        live broadcast of every event
 *
 * Ingestion pipeline: validate -> assign id -> persist -> metrics ->
 * broadcast. No LLM participates.
 */
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import websocketPlugin from "@fastify/websocket";
import {
  reduceEvents,
  validateTraceEvent,
  type TraceEvent,
} from "@agenttrace/protocol";
import { EventStore } from "./event-store.js";
import { LiveHub } from "./websocket.js";
import {
  getAgentActivity,
  getCriticalPath,
  getExactDuplicateCalls,
  getFailures,
  getToolCalls,
  getTraceSummary,
} from "./analysis/queries.js";
import { getEventsBefore, getEventsBetween } from "./analysis/timings.js";

const PORT = Number(process.env.COLLECTOR_PORT ?? 8787);
const DATA_DIR = process.env.AGENTTRACE_DATA_DIR; // unset => memory only

const app = Fastify({ logger: true });
await app.register(websocketPlugin);

const store = new EventStore(DATA_DIR);
const hub = new LiveHub();

function stateFor(traceId: string) {
  return reduceEvents(store.getTrace(traceId), traceId);
}

// --- ingestion -----------------------------------------------------------

app.post("/v1/events", async (request, reply) => {
  const body = request.body as { event?: unknown } | undefined;
  const raw = body && "event" in body ? body.event : body;

  const candidate =
    raw && typeof raw === "object" && !("eventId" in raw)
      ? { ...(raw as object), eventId: `evt_${randomUUID()}` }
      : raw;

  const result = validateTraceEvent(candidate);
  if (!result.ok) {
    return reply.code(400).send({ error: "invalid TraceEvent", details: result.errors });
  }

  const event = result.event as TraceEvent;
  store.add(event);
  hub.broadcast({ kind: "event", event });
  return reply.code(202).send({ accepted: true, eventId: event.eventId });
});

// --- reads ---------------------------------------------------------------

app.get("/v1/traces", async () => ({ traces: store.listTraces() }));

app.get("/v1/traces/:traceId", async (request, reply) => {
  const { traceId } = request.params as { traceId: string };
  const events = store.getTrace(traceId);
  if (events.length === 0) return reply.code(404).send({ error: "trace not found" });
  return { traceId, events, state: stateFor(traceId) };
});

// --- deterministic query endpoints (spec §19) ----------------------------

app.get("/v1/traces/:traceId/summary", async (request) => {
  const { traceId } = request.params as { traceId: string };
  return getTraceSummary(stateFor(traceId));
});

app.get("/v1/traces/:traceId/agents/:agentId/activity", async (request) => {
  const { traceId, agentId } = request.params as { traceId: string; agentId: string };
  return { events: getAgentActivity(stateFor(traceId), agentId) };
});

app.get("/v1/traces/:traceId/tools", async (request) => {
  const { traceId } = request.params as { traceId: string };
  const { name } = request.query as { name?: string };
  return { events: getToolCalls(stateFor(traceId), name) };
});

app.get("/v1/traces/:traceId/failures", async (request) => {
  const { traceId } = request.params as { traceId: string };
  return getFailures(stateFor(traceId));
});

app.get("/v1/traces/:traceId/critical-path", async (request) => {
  const { traceId } = request.params as { traceId: string };
  return getCriticalPath(stateFor(traceId));
});

app.get("/v1/traces/:traceId/duplicates", async (request) => {
  const { traceId } = request.params as { traceId: string };
  return { duplicates: getExactDuplicateCalls(stateFor(traceId).events) };
});

app.get("/v1/traces/:traceId/events", async (request) => {
  const { traceId } = request.params as { traceId: string };
  const query = request.query as Record<string, string | undefined>;
  const events = store.getTrace(traceId);
  if (query.before) {
    return { events: getEventsBefore(events, query.before, Number(query.count ?? 10)) };
  }
  if (query.from && query.to) {
    return { events: getEventsBetween(events, query.from, query.to) };
  }
  return { events };
});

// --- assistant (Track 3 wires packages/gemini behind this route) ---------

app.post("/v1/assistant", async (request, reply) => {
  const { question, traceId } = request.body as { question?: string; traceId?: string };
  if (!question || !traceId) {
    return reply.code(400).send({ error: "question and traceId are required" });
  }
  try {
    // Lazy import so the collector runs fine without the gemini package/key.
    // Indirect specifier: optional plugin, resolved from workspace root at
    // runtime, and invisible to this package's typecheck.
    const geminiModule = "@agenttrace/gemini";
    const { ask } = (await import(geminiModule)) as {
      ask: (
        question: string,
        traceId: string,
      ) => Promise<{ answer: string; functionsCalled?: string[] }>;
    };
    const result = await ask(question, traceId);
    return { answer: result.answer, functionsCalled: result.functionsCalled ?? [] };
  } catch (err) {
    request.log.warn(err);
    return reply.code(501).send({ error: "assistant unavailable (Gemini not configured?)" });
  }
});

// --- live websocket ------------------------------------------------------

app.get("/v1/live", { websocket: true }, (socket) => {
  hub.add(socket);
});

// --- dev helpers ---------------------------------------------------------

app.get("/v1/health", async () => ({ ok: true, clients: hub.size }));

app.listen({ port: PORT, host: "127.0.0.1" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
