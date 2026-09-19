/**
 * A2A observability proxy (spec §9) — the highest-fidelity integration.
 *
 *   Agent A --> AgentTrace proxy --> Agent B
 *
 * The proxy receives a request, records metadata, forwards it unchanged,
 * observes the response, emits normalized events, and returns the response
 * unchanged. It must not modify semantic behavior.
 *
 * TODO(track-3): task lifecycle events (task created/status changed/
 * artifact emitted), streaming (SSE) pass-through with ordered events.
 */
import Fastify from "fastify";
import type { EntityRef, TraceEvent } from "@agenttrace/protocol";
import { emitEventSafe, nextEventId } from "../emit.js";

const PORT = Number(process.env.A2A_PROXY_PORT ?? 8800);
const TARGET = process.env.A2A_TARGET_URL ?? "http://localhost:9101";

const PROVIDER = { adapter: "a2a", adapterVersion: "0.1" } as const;

const app = Fastify({ logger: true });
app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) =>
  done(null, body),
);

function callerRef(request: { headers: Record<string, unknown> }): EntityRef {
  const id = String(request.headers["x-agent-id"] ?? "unknown_agent");
  return { id, kind: "agent", name: String(request.headers["x-agent-name"] ?? id) };
}

function targetRef(request: { headers: Record<string, unknown> }): EntityRef {
  // Callers declare the intended destination agent so the graph shows real
  // agent identities instead of proxy URLs. Fallback: the upstream URL.
  const id = String(
    request.headers["x-target-agent-id"] ?? `a2a_target:${TARGET}`,
  );
  return {
    id,
    kind: "agent",
    name: String(request.headers["x-target-agent-name"] ?? id),
  };
}

function base(traceId: string) {
  return {
    schemaVersion: 1 as const,
    eventId: nextEventId("a2a"),
    traceId,
    timestamp: new Date().toISOString(),
    visibility: "full_protocol" as const,
    provider: PROVIDER,
  };
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
    (params?.taskId as string) ??
    (message?.taskId as string) ??
    (json?.id as string) ??
    nextEventId("task");
  const traceId =
    (message?.contextId as string) ?? (params?.contextId as string) ?? taskId;

  const caller = callerRef(request);
  const target = targetRef(request);

  // 1. Record the inbound message.
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

  // 2. Forward unchanged.
  const upstream = await fetch(`${TARGET}${request.url}`, {
    method: request.method,
    headers: {
      "content-type": request.headers["content-type"] ?? "application/json",
      "x-agent-id": caller.id,
      "x-agent-name": caller.name,
    },
    body: request.method === "GET" || request.method === "HEAD" ? undefined : body,
  });
  const responseBody = await upstream.text();

  // 3. Observe the response for task lifecycle.
  let responseJson: Record<string, unknown> | undefined;
  try {
    responseJson = JSON.parse(responseBody) as Record<string, unknown>;
  } catch {
    responseJson = undefined;
  }
  const result = responseJson?.result as Record<string, unknown> | undefined;
  const status = result?.status as Record<string, unknown> | undefined;
  const state = status?.state as string | undefined;

  emitEventSafe({
    ...base(traceId),
    source: target,
    destination: caller,
    category: "agent",
    type: "agent_message",
    status: upstream.ok ? "success" : "failure",
    correlationId: taskId,
    durationMs: undefined,
    payload: { httpStatus: upstream.status, taskState: state, result: responseJson },
  });

  // TODO(track-3): emit artifact_created for result.artifacts entries and
  // handle SSE streams (message/stream) event-by-event.

  // 4. Return the response unchanged.
  reply.code(upstream.status);
  upstream.headers.forEach((value, key) => {
    if (key !== "content-length" && key !== "transfer-encoding") {
      reply.header(key, value);
    }
  });
  return reply.send(responseBody);
});

app.listen({ port: PORT, host: "127.0.0.1" }).then(() => {
  app.log.info(`A2A proxy listening on :${PORT}, forwarding to ${TARGET}`);
});
