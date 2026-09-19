/**
 * Researcher agent (spec §25 demo). Receives an A2A-style message/send
 * request via the proxy, self-reports file_search + file_read tool calls,
 * and returns a completed task with an artifact. Total work lands ~3.4s —
 * still running when the Reviewer's shell fails at ~1.9s.
 */
import Fastify from "fastify";
import { emit, eventId } from "../emit.js";

const PORT = Number(process.env.RESEARCHER_PORT ?? 9101);
const SEARCH_MS = Number(process.env.RESEARCHER_SEARCH_MS ?? 800);
const READ_MS = Number(process.env.RESEARCHER_READ_MS ?? 2200);
const app = Fastify({ logger: true });

const me = { id: "agent_researcher", kind: "agent", name: "Researcher" } as const;
const fileSearch = { id: "tool_file_search", kind: "tool", name: "file_search" } as const;
const fileRead = { id: "tool_file_read", kind: "tool", name: "file_read" } as const;
const provider = { adapter: "custom", adapterVersion: "0.1" } as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  await sleep(150);
  const searchCall = eventId("call");
  await emit({
    ...base, eventId: eventId(), timestamp: new Date().toISOString(),
    source: me, destination: fileSearch, category: "tool", type: "tool_call",
    status: "started", correlationId: searchCall,
    payload: { arguments: { pattern: "auth*.test.ts", path: "tests/" } },
  });
  await sleep(SEARCH_MS);
  await emit({
    ...base, eventId: eventId(), timestamp: new Date().toISOString(),
    source: fileSearch, destination: me, category: "tool", type: "tool_result",
    status: "success", correlationId: searchCall,
    payload: { result: ["tests/auth-login.test.ts", "tests/auth-token.test.ts"] },
  });

  await sleep(120);
  const readCall = eventId("call");
  await emit({
    ...base, eventId: eventId(), timestamp: new Date().toISOString(),
    source: me, destination: fileRead, category: "tool", type: "tool_call",
    status: "started", correlationId: readCall,
    payload: { arguments: { path: "tests/auth-token.test.ts" } },
  });
  await sleep(READ_MS);
  await emit({
    ...base, eventId: eventId(), timestamp: new Date().toISOString(),
    source: fileRead, destination: me, category: "tool", type: "tool_result",
    status: "success", correlationId: readCall,
    payload: { result: "token expiry test asserts Date.now() + ttl < exp — broke when ttl changed to seconds" },
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
      status: { state: "completed", timestamp: new Date().toISOString() },
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
