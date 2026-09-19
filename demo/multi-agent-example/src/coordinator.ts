/**
 * Coordinator (spec §25 demo). Fans out one A2A message/send request to
 * each worker THROUGH the AgentTrace proxies — so every hop is observed.
 *
 *   coordinator --> proxy :8800 --> researcher :9101
 *   coordinator --> proxy :8801 --> reviewer  :9102
 *
 * run-demo calls runCoordinator() in-process (possibly repeatedly); this
 * file also runs standalone via `npm run coordinator`.
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { emit, eventId } from "./emit.js";

const RESEARCHER_PROXY = process.env.RESEARCHER_PROXY_URL ?? "http://localhost:8800";
const REVIEWER_PROXY = process.env.REVIEWER_PROXY_URL ?? "http://localhost:8801";

const me = { id: "agent_coordinator", kind: "agent", name: "Coordinator" } as const;
const provider = { adapter: "custom", adapterVersion: "0.1" } as const;

function a2aRequest(traceId: string, taskId: string, text: string) {
  return {
    jsonrpc: "2.0",
    id: eventId("req"),
    method: "message/send",
    params: {
      message: {
        messageId: eventId("msg"),
        taskId,
        contextId: traceId,
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

/** Runs one coordinator fan-out. Returns the trace id it produced. */
export async function runCoordinator(): Promise<string> {
  const traceId = `trace_demo_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`;

  await emit({
    schemaVersion: 1,
    eventId: eventId(),
    traceId,
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
      a2aRequest(traceId, "task_research", "Search the repo for recent changes to auth tests."),
      { id: "agent_researcher", name: "Researcher" },
    ),
    send(
      REVIEWER_PROXY,
      a2aRequest(traceId, "task_review", "Re-run the auth test suite and report failures."),
      { id: "agent_reviewer", name: "Reviewer" },
    ),
  ]);

  console.log("researcher:", JSON.stringify(research.result?.status ?? research));
  console.log("reviewer: ", JSON.stringify(review.result?.status ?? review));

  const failed = review?.result?.status?.state === "failed";
  await emit({
    schemaVersion: 1,
    eventId: eventId(),
    traceId,
    timestamp: new Date().toISOString(),
    source: me,
    category: "agent",
    type: "agent_stop",
    status: failed ? "failure" : "success",
    visibility: "structured_event",
    provider,
  });

  console.log(`\ntrace: ${traceId}`);
  return traceId;
}

// Standalone entry (`npm run coordinator`) — skipped when imported by run-demo.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCoordinator();
}
