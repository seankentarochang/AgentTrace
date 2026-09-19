/**
 * Coordinator (spec §25 demo). Fans out one A2A message/send request to
 * each worker THROUGH the AgentTrace proxies — so every hop is observed.
 *
 *   coordinator --> proxy :8800 --> researcher :9101
 *   coordinator --> proxy :8801 --> reviewer  :9102
 */
import { emit, eventId } from "./emit.js";

const RESEARCHER_PROXY = process.env.RESEARCHER_PROXY_URL ?? "http://localhost:8800";
const REVIEWER_PROXY = process.env.REVIEWER_PROXY_URL ?? "http://localhost:8801";
const TRACE_ID = `trace_demo_${Date.now().toString(36)}`;

const me = { id: "agent_coordinator", kind: "agent", name: "Coordinator" } as const;
const provider = { adapter: "custom", adapterVersion: "0.1" } as const;

function a2aRequest(taskId: string, text: string) {
  return {
    jsonrpc: "2.0",
    id: eventId("req"),
    method: "message/send",
    params: {
      message: {
        messageId: eventId("msg"),
        taskId,
        contextId: TRACE_ID,
        role: "user",
        parts: [{ kind: "text", text }],
      },
    },
  };
}

interface A2AResponse {
  result?: { status?: { state?: string } };
}

async function send(
  proxyUrl: string,
  request: unknown,
  target: { id: string; name: string },
): Promise<A2AResponse> {
  const res = await fetch(`${proxyUrl}/a2a`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-id": me.id,
      "x-agent-name": me.name,
      "x-target-agent-id": target.id,
      "x-target-agent-name": target.name,
    },
    body: JSON.stringify(request),
  });
  return (await res.json()) as A2AResponse;
}

async function main() {
  await emit({
    schemaVersion: 1,
    eventId: eventId(),
    traceId: TRACE_ID,
    timestamp: new Date().toISOString(),
    source: me,
    category: "agent",
    type: "agent_start",
    status: "started",
    visibility: "structured_event",
    provider,
    payload: { prompt: "Investigate why authentication tests started failing." },
  });

  const [research, review] = await Promise.all([
    send(
      RESEARCHER_PROXY,
      a2aRequest("task_research", "Search the repo for recent changes to auth tests."),
      { id: "agent_researcher", name: "Researcher" },
    ),
    send(
      REVIEWER_PROXY,
      a2aRequest("task_review", "Re-run the auth test suite and report failures."),
      { id: "agent_reviewer", name: "Reviewer" },
    ),
  ]);

  console.log("researcher:", JSON.stringify(research.result?.status ?? research));
  console.log("reviewer: ", JSON.stringify(review.result?.status ?? review));

  const failed = review?.result?.status?.state === "failed";
  await emit({
    schemaVersion: 1,
    eventId: eventId(),
    traceId: TRACE_ID,
    timestamp: new Date().toISOString(),
    source: me,
    category: "agent",
    type: "agent_stop",
    status: failed ? "failure" : "success",
    visibility: "structured_event",
    provider,
  });

  console.log(`\ntrace: ${TRACE_ID}`);
}

main();
