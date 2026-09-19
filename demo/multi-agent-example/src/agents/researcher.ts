/**
 * Researcher agent (spec §25 demo). Receives an A2A-style message/send
 * request via the proxy, self-reports a file_search tool call, and returns
 * a completed task with an artifact.
 */
import Fastify from "fastify";
import { emit, eventId } from "../emit.js";

const PORT = Number(process.env.RESEARCHER_PORT ?? 9101);
const app = Fastify({ logger: true });

const me = { id: "agent_researcher", kind: "agent", name: "Researcher" } as const;
const fileSearch = { id: "tool_file_search", kind: "tool", name: "file_search" } as const;
const provider = { adapter: "custom", adapterVersion: "0.1" } as const;

app.post("/a2a", async (request) => {
  const body = request.body as Record<string, unknown>;
  const params = body.params as Record<string, unknown> | undefined;
  const message = params?.message as Record<string, unknown> | undefined;
  const taskId = (message?.taskId as string) ?? "task_research";
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

  // Self-reported tool activity.
  const callId = eventId("call");
  await emit({
    ...base, eventId: eventId(), timestamp: new Date().toISOString(),
    source: me, destination: fileSearch, category: "tool", type: "tool_call",
    status: "started", correlationId: callId,
    payload: { arguments: { pattern: "auth*.test.ts", path: "tests/" } },
  });
  await new Promise((r) => setTimeout(r, 900));
  await emit({
    ...base, eventId: eventId(), timestamp: new Date().toISOString(),
    source: fileSearch, destination: me, category: "tool", type: "tool_result",
    status: "success", correlationId: callId,
    payload: { result: ["tests/auth-login.test.ts", "tests/auth-token.test.ts"] },
  });

  await emit({
    ...base, eventId: eventId(), timestamp: new Date().toISOString(),
    source: me, category: "agent", type: "agent_stop",
    status: "success", correlationId: taskId,
  });

  return {
    jsonrpc: "2.0",
    id: body.id,
    result: {
      taskId,
      status: { state: "completed" },
      artifacts: [
        {
          artifactId: eventId("artifact"),
          name: "research_findings",
          parts: [{ kind: "text", text: "Found 2 auth test files; token-expiry test changed yesterday." }],
        },
      ],
    },
  };
});

app.listen({ port: PORT, host: "127.0.0.1" }).then(() => {
  app.log.info(`Researcher listening on :${PORT}`);
});
