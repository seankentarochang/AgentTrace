/**
 * Reviewer agent (spec §25 demo). Receives a task via the proxy, runs a
 * (simulated) shell test command that FAILS at ~1.9s — the failure Gemini
 * later explains from deterministic data.
 */
import Fastify from "fastify";
import { emit, eventId } from "../emit.js";

const PORT = Number(process.env.REVIEWER_PORT ?? 9102);
const SHELL_MS = Number(process.env.REVIEWER_SHELL_MS ?? 1500);
const app = Fastify({ logger: true });

const me = { id: "agent_reviewer", kind: "agent", name: "Reviewer" } as const;
const shell = { id: "tool_shell", kind: "tool", name: "shell" } as const;
const provider = { adapter: "custom", adapterVersion: "0.1" } as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

app.post("/a2a", async (request) => {
  const body = request.body as Record<string, unknown>;
  const params = body.params as Record<string, unknown> | undefined;
  const message = params?.message as Record<string, unknown> | undefined;
  const taskId = (message?.taskId as string) ?? "task_review";
  const traceId = (message?.contextId as string) ?? "trace_demo_live";

  const base = {
    schemaVersion: 1 as const,
    traceId,
    visibility: "structured_event" as const,
    provider,
  };

  await emit({
    ...base, eventId: eventId(), timestamp: new Date().toISOString(),
    source: me, category: "agent", type: "agent_start",
    status: "started", correlationId: taskId,
  });

  await sleep(320);
  const callId = eventId("call");
  await emit({
    ...base, eventId: eventId(), timestamp: new Date().toISOString(),
    source: me, destination: shell, category: "tool", type: "tool_call",
    status: "started", correlationId: callId,
    payload: { arguments: { command: "npm test -- auth" } },
  });
  await sleep(SHELL_MS);
  await emit({
    ...base, eventId: eventId(), timestamp: new Date().toISOString(),
    source: shell, destination: me, category: "tool", type: "tool_result",
    status: "failure", correlationId: callId,
    payload: { error: "exit code 1", stderr: "2 failing: auth-token expiry, login lockout" },
  });

  await emit({
    ...base, eventId: eventId(), timestamp: new Date().toISOString(),
    source: me, category: "agent", type: "agent_stop",
    status: "failure", correlationId: taskId,
  });

  return {
    jsonrpc: "2.0",
    id: body.id,
    result: {
      taskId,
      status: { state: "failed", timestamp: new Date().toISOString() },
      artifacts: [
        {
          artifactId: eventId("artifact"),
          name: "test_report",
          parts: [{ kind: "text", text: "npm test -- auth failed: exit code 1 (2 tests)." }],
        },
      ],
    },
  };
});

app.listen({ port: PORT, host: "127.0.0.1" }).then(() => {
  app.log.info(`Reviewer listening on :${PORT}`);
});
