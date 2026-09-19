/**
 * A2A observability proxy (spec §9) — the highest-fidelity integration.
 *
 *   Agent A --> AgentTrace proxy --> Agent B
 *
 * The proxy receives a request, records metadata, forwards it unchanged,
 * observes the response, emits normalized events, and returns the response
 * unchanged. It must not modify semantic behavior.
 *
 * Emitted per request: agent_message (request), agent_message (response),
 * status_change from result.status.state, artifact_created per
 * result.artifacts[] entry (spec §9 event list). Non-2xx upstreams record
 * only httpStatus + failure — no fabricated task states.
 *
 * SSE streaming is CUT for MVP: the demo uses message/send only, and
 * upstream.text() buffers the whole stream anyway (PLAN-integrations cut 1).
 */
import Fastify from "fastify";
import type { EntityRef, EventStatus } from "@agenttrace/protocol";
import { emitEventSafe, nextEventId } from "../emit.js";

const PORT = Number(process.env.A2A_PROXY_PORT ?? 8800);
const TARGET = process.env.A2A_TARGET_URL ?? "http://localhost:9101";

const PROVIDER = { adapter: "a2a", adapterVersion: "0.1" } as const;

const app = Fastify({ logger: true });
app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) =>
  done(null, body),
);

// JSON-RPC/A2A ids may be numbers — coerce; empty strings fall through to
// the fallback rather than producing invalid EntityRefs/correlationIds.
function sid(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function callerRef(request: { headers: Record<string, unknown> }): EntityRef {
  const id = sid(request.headers["x-agent-id"]) ?? "unknown_agent";
  return { id, kind: "agent", name: sid(request.headers["x-agent-name"]) ?? id };
}

function targetRef(request: { headers: Record<string, unknown> }): EntityRef {
  // Callers declare the intended destination agent so the graph shows real
  // agent identities instead of proxy URLs. Fallback: the upstream URL.
  const id =
    sid(request.headers["x-target-agent-id"]) ?? `a2a_target:${TARGET}`;
  return {
    id,
    kind: "agent",
    name: sid(request.headers["x-target-agent-name"]) ?? id,
  };
}

function base(traceId: string, timestamp = new Date().toISOString()) {
  return {
    schemaVersion: 1 as const,
    eventId: nextEventId("a2a"),
    traceId,
    timestamp,
    visibility: "full_protocol" as const,
    provider: PROVIDER,
  };
}

// A2A TaskState -> canonical status. Unknown states stay unmapped (undefined)
// rather than guessing.
function a2aStateStatus(state: string): EventStatus | undefined {
  switch (state) {
    case "submitted":
    case "working":
    case "input-required":
    case "auth-required":
      return "started";
    case "completed":
      return "success";
    case "failed":
    case "rejected":
      return "failure";
    case "canceled":
      return "cancelled";
    default:
      return undefined;
  }
}

// Local health endpoint — not forwarded, used by run-demo readiness checks.
app.get("/healthz", async () => ({ ok: true, target: TARGET }));

app.all("/*", async (request, reply) => {
  // Fastify's built-in parser yields an object for application/json; the "*"
  // parser yields strings for everything else. Handle both.
  const raw = request.body;
  const json: Record<string, unknown> | undefined =
    raw && typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : (() => {
          try {
            return typeof raw === "string" && raw
              ? (JSON.parse(raw) as Record<string, unknown>)
              : undefined;
          } catch {
            return undefined;
          }
        })();
  const body =
    typeof raw === "string" ? raw : raw === undefined ? "" : JSON.stringify(raw);

  // A2A requests carry task/context ids we map straight into correlation.
  const params = json?.params as Record<string, unknown> | undefined;
  const message = params?.message as Record<string, unknown> | undefined;
  const taskId =
    sid(params?.taskId) ??
    sid(message?.taskId) ??
    sid(json?.id) ??
    nextEventId("task");
  const traceId =
    sid(message?.contextId) ?? sid(params?.contextId) ?? taskId;

  const caller = callerRef(request);
  const target = targetRef(request);

  // 1. Record the inbound message.
  const startedAt = Date.now();
  emitEventSafe({
    ...base(traceId),
    source: caller,
    destination: target,
    category: "agent",
    type: "agent_message",
    status: "started",
    correlationId: taskId,
    payload: { method: json?.method ?? request.method, params: params ?? json },
  });

  // 2. Forward unchanged — inbound headers pass through except hop-by-hop
  // and the x-target-agent-* control headers; the proxy injects the caller
  // identity headers itself.
  const FWD_STRIP = new Set([
    "host",
    "content-length",
    "connection",
    "keep-alive",
    "te",
    "trailer",
    "upgrade",
    "x-target-agent-id",
    "x-target-agent-name",
  ]);
  const fwdHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (FWD_STRIP.has(key.toLowerCase()) || value === undefined) continue;
    fwdHeaders[key] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  fwdHeaders["x-agent-id"] = caller.id;
  fwdHeaders["x-agent-name"] = caller.name;

  let upstream: Response;
  try {
    upstream = await fetch(`${TARGET}${request.url}`, {
      method: request.method,
      headers: fwdHeaders,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : body,
    });
  } catch {
    emitEventSafe({
      ...base(traceId),
      source: target,
      destination: caller,
      category: "agent",
      type: "agent_message",
      status: "failure",
      correlationId: taskId,
      durationMs: Date.now() - startedAt,
      payload: { error: "a2a upstream unreachable", target: TARGET },
    });
    return reply.code(502).send({ error: "a2a upstream unreachable", target: TARGET });
  }
  const responseBody = await upstream.text();
  const durationMs = Date.now() - startedAt;

  // 3. Observe the response for task lifecycle.
  let responseJson: Record<string, unknown> | undefined;
  try {
    responseJson = JSON.parse(responseBody) as Record<string, unknown>;
  } catch {
    responseJson = undefined;
  }
  const result = responseJson?.result as Record<string, unknown> | undefined;
  const rpcError = responseJson?.error;
  const status = result?.status as Record<string, unknown> | undefined;
  const state = status?.state as string | undefined;
  const artifacts = Array.isArray(result?.artifacts) ? result.artifacts : [];

  emitEventSafe({
    ...base(traceId),
    source: target,
    destination: caller,
    category: "agent",
    type: "agent_message",
    status: upstream.ok && !rpcError ? "success" : "failure",
    correlationId: taskId,
    durationMs,
    payload: { httpStatus: upstream.status, taskState: state, result: responseJson },
  });

  // Task lifecycle — only on a healthy upstream with a real result. A2A's
  // status.timestamp is the observed state-change time; prefer it over
  // now(), but only when it actually parses (a bad string would corrupt
  // the reducer's duration math).
  const stateTs =
    typeof status?.timestamp === "string" &&
    status.timestamp &&
    !Number.isNaN(Date.parse(status.timestamp))
      ? status.timestamp
      : undefined;
  if (upstream.ok && result) {
    if (state) {
      emitEventSafe({
        ...base(traceId, stateTs),
        source: target,
        category: "agent",
        type: "status_change",
        status: a2aStateStatus(state),
        correlationId: taskId,
        payload: { taskId: result.id ?? taskId, taskState: state },
      });
    }
    for (const artifact of artifacts) {
      emitEventSafe({
        ...base(traceId),
        source: target,
        category: "artifact",
        type: "artifact_created",
        status: "success",
        correlationId: taskId,
        payload: artifact,
      });
    }
  }

  // 4. Return the response unchanged. fetch() already decompressed the
  // body — forwarding content-encoding would double-decode downstream;
  // hop-by-hop headers must not cross the proxy either.
  const STRIP_HEADERS = new Set([
    "content-length",
    "content-encoding",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "te",
    "trailer",
    "upgrade",
  ]);
  reply.code(upstream.status);
  upstream.headers.forEach((value, key) => {
    if (!STRIP_HEADERS.has(key.toLowerCase())) {
      reply.header(key, value);
    }
  });
  return reply.send(responseBody);
});

app.listen({ port: PORT, host: "127.0.0.1" }).then(() => {
  app.log.info(`A2A proxy listening on :${PORT}, forwarding to ${TARGET}`);
});
