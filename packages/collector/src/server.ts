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
 *   GET  /v1/traces/:traceId/concurrency
 *   GET  /v1/traces/:traceId/duplicates
 *   GET  /v1/traces/:traceId/events?from&to | ?before=<eventId>&count=
 *   POST /v1/assistant                   Gemini NL query (Track 3)
 *   WS   /v1/live                        live broadcast of every event
 *   POST /v1/dev/seed[?realtime=1]       replay the demo fixture through ingest
 *
 * Ingestion pipeline: assign id -> validate -> cap payload -> dedupe ->
 * persist -> broadcast. No LLM participates.
 */
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import websocketPlugin from "@fastify/websocket";
import {
  demoTraceEvents,
  reduceEvents,
  validateTraceEvent,
  type TraceEvent,
} from "@agenttrace/protocol";
import { EventStore } from "./event-store.js";
import { LiveHub } from "./websocket.js";
import {
  getAgentActivity,
  getConcurrency,
  getCriticalPath,
  getExactDuplicateCalls,
  getFailures,
  getToolCalls,
  getTraceSummary,
} from "./analysis/queries.js";
import { getEventsBefore, getEventsBetween } from "./analysis/timings.js";

const PORT = Number(process.env.COLLECTOR_PORT ?? 8787);
const DATA_DIR = process.env.AGENTTRACE_DATA_DIR; // unset => memory only
const MAX_PAYLOAD_BYTES = Number(process.env.AGENTTRACE_MAX_PAYLOAD_BYTES ?? 64 * 1024);

const app = Fastify({ logger: true });
await app.register(websocketPlugin);

const store = new EventStore(DATA_DIR);
const hub = new LiveHub();

function stateFor(traceId: string) {
  return reduceEvents(store.getTrace(traceId), traceId);
}

// Unknown traceId -> 404 on every per-trace route, so queries (and Gemini)
// never report an empty-but-"ok" result for a typo'd id.
app.addHook("preHandler", async (request, reply) => {
  const { traceId } = (request.params ?? {}) as { traceId?: string };
  if (traceId !== undefined && store.getTrace(traceId).length === 0) {
    return reply.code(404).send({ error: "trace not found" });
  }
});

// --- ingestion -----------------------------------------------------------

/**
 * Oversized payloads are replaced before persist/broadcast, so the JSONL log,
 * the live stream and every read agree on the same (capped) event.
 */
function capPayload(event: TraceEvent): TraceEvent {
  if (event.payload === undefined) return event;
  const json = JSON.stringify(event.payload);
  const bytes = Buffer.byteLength(json);
  if (bytes <= MAX_PAYLOAD_BYTES) return event;
  return {
    ...event,
    payload: { truncated: true, originalBytes: bytes, preview: json.slice(0, 2048) },
  };
}

type IngestResult =
  | { ok: true; eventId: string; duplicate: boolean }
  | { ok: false; errors: string[] };

/** The one ingest pipeline — HTTP and the dev seed route both go through it. */
function ingest(raw: unknown): IngestResult {
  const candidate =
    raw && typeof raw === "object" && !("eventId" in raw)
      ? { ...(raw as object), eventId: `evt_${randomUUID()}` }
      : raw;

  const result = validateTraceEvent(candidate);
  if (!result.ok) return { ok: false, errors: result.errors };

  const event = capPayload(result.event);
  const stored = store.add(event);
  if (stored) hub.broadcast({ kind: "event", event });
  return { ok: true, eventId: event.eventId, duplicate: !stored };
}

app.post("/v1/events", async (request, reply) => {
  const body = request.body as { event?: unknown } | undefined;
  const raw = body && typeof body === "object" && "event" in body ? body.event : body;
  const result = ingest(raw);
  if (!result.ok) {
    return reply.code(400).send({ error: "invalid TraceEvent", details: result.errors });
  }
  return reply
    .code(202)
    .send({ accepted: true, eventId: result.eventId, duplicate: result.duplicate });
});

// --- reads ---------------------------------------------------------------

app.get("/v1/traces", async () => ({ traces: store.listTraces() }));

app.get("/v1/traces/:traceId", async (request) => {
  const { traceId } = request.params as { traceId: string };
  return { traceId, events: store.getTrace(traceId), state: stateFor(traceId) };
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

app.get("/v1/traces/:traceId/concurrency", async (request) => {
  const { traceId } = request.params as { traceId: string };
  return getConcurrency(stateFor(traceId));
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
      ask: (question: string, traceId: string) => Promise<string>;
    };
    const answer = await ask(question, traceId);
    return { answer };
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

/**
 * Replays the demo fixture as a fresh trace (new traceId/eventIds, timestamps
 * shifted to now) through the real ingest pipeline. `?realtime=1` paces the
 * events by their original offsets so the dashboard animates live.
 */
app.post("/v1/dev/seed", async (request, reply) => {
  const { realtime } = request.query as { realtime?: string };
  const traceId = `trace_seed_${Date.now()}`;
  // The dashboard reduces every live event together; clear it so a second
  // seed doesn't merge into the first (same entity ids, new traceId).
  hub.broadcast({ kind: "reset" });
  const base = Date.parse(demoTraceEvents[0]!.timestamp);
  const now = Date.now();

  const events = demoTraceEvents.map((e) => {
    const offset = Date.parse(e.timestamp) - base;
    return {
      offset,
      event: {
        ...e,
        traceId,
        eventId: `${traceId}_${e.eventId}`,
        timestamp: new Date(now + offset).toISOString(),
      },
    };
  });

  if (realtime === "1" || realtime === "true") {
    for (const { offset, event } of events) setTimeout(() => ingest(event), offset);
    return reply.code(202).send({ traceId, scheduled: events.length });
  }
  for (const { event } of events) ingest(event);
  return reply.code(202).send({ traceId, accepted: events.length });
});

app.listen({ port: PORT, host: "127.0.0.1" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
