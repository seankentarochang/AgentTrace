/**
 * Codex lifecycle hook -> TraceEvent mapping (spec §10).
 *
 * TODO(track-3): verify field names against a real Codex hook payload —
 * `hook_event_name`, `session_id`, `turn_id`, `tool.name`, `tool.call_id`,
 * `agent.id` are best-guess names and must be corrected on first real
 * capture. Map only documented fields; never invent events.
 */
import type { EntityRef, TraceEvent } from "@agenttrace/protocol";
import { nextEventId } from "../emit.js";

const PROVIDER = { adapter: "codex", adapterVersion: "0.1" } as const;

type HookPayload = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function agentRef(payload: HookPayload, fallback: string): EntityRef {
  const agent = payload.agent as HookPayload | undefined;
  const id = str(agent?.id) ?? str(payload.agent_id) ?? fallback;
  return {
    id,
    kind: "agent",
    name: str(agent?.name) ?? id,
    subtype: "codex",
  };
}

function toolRef(payload: HookPayload): EntityRef {
  const tool = payload.tool as HookPayload | undefined;
  const name = str(tool?.name) ?? str(payload.tool_name) ?? "unknown_tool";
  return { id: `tool_${name}`, kind: "tool", name };
}

function base(payload: HookPayload) {
  return {
    schemaVersion: 1 as const,
    eventId: nextEventId(),
    traceId: str(payload.session_id) ?? "trace_codex_unknown",
    timestamp: str(payload.timestamp) ?? new Date().toISOString(),
    visibility: "structured_event" as const,
    provider: {
      ...PROVIDER,
      rawEventType: str(payload.hook_event_name) ?? str(payload.event_name),
    },
  };
}

function correlationId(payload: HookPayload): string | undefined {
  const tool = payload.tool as HookPayload | undefined;
  return (
    str(tool?.call_id) ??
    str(payload.tool_call_id) ??
    str(payload.task_id) ??
    str(payload.turn_id)
  );
}

export function mapCodexHook(payload: unknown): TraceEvent[] {
  if (!payload || typeof payload !== "object") return [];
  const p = payload as HookPayload;
  const hookName = str(p.hook_event_name) ?? str(p.event_name) ?? "";
  const source = agentRef(p, "codex_main");

  switch (hookName) {
    case "SessionStart":
      return [{
        ...base(p), source, category: "system", type: "session_start",
        status: "started", payload: p,
      }];
    case "SessionEnd":
    case "Stop":
      return [{
        ...base(p), source, category: "system", type: "session_end",
        status: "success", payload: p,
      }];
    case "SubagentStart":
      return [{
        ...base(p), source: agentRef(p, "codex_subagent"), destination: source,
        category: "agent", type: "agent_start", status: "started",
        correlationId: correlationId(p), payload: p,
      }];
    case "SubagentStop":
      return [{
        ...base(p), source: agentRef(p, "codex_subagent"),
        category: "agent", type: "agent_stop",
        status: str(p.status) === "failure" ? "failure" : "success",
        correlationId: correlationId(p), payload: p,
      }];
    case "PreToolUse": {
      const tool = toolRef(p);
      return [{
        ...base(p), source, destination: tool,
        category: "tool", type: "tool_call", status: "started",
        correlationId: correlationId(p), payload: p,
      }];
    }
    case "PostToolUse": {
      const tool = toolRef(p);
      return [{
        ...base(p), source: tool, destination: source,
        category: "tool", type: "tool_result",
        status: p.error ? "failure" : "success",
        correlationId: correlationId(p), payload: p,
      }];
    }
    case "UserPromptSubmit":
      return [{
        ...base(p),
        source: { id: "user", kind: "agent", name: "User" },
        destination: source,
        category: "agent", type: "agent_message", status: "success",
        payload: p,
      }];
    case "PermissionRequest":
      return [{
        ...base(p), source, category: "system", type: "status_change",
        status: "started", payload: p,
      }];
    default:
      // Unknown hooks are ignored — never invent canonical events.
      return [];
  }
}
