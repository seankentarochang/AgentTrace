/**
 * Codex lifecycle hook -> TraceEvent mapping (spec §10).
 *
 * Field names sourced from codex-rs/hooks/src/schema.rs +
 * codex-rs/hooks/src/lib.rs (openai/codex). Hook stdin payloads carry:
 *   common:  session_id, turn_id, transcript_path, cwd, hook_event_name,
 *            model, permission_mode
 *   tool:    tool_name, tool_use_id, tool_input (Pre) + tool_response (Post)
 *   subagent: agent_id (child thread id), agent_type
 *   prompt:  UserPromptSubmit.prompt
 *   session: SessionStart.source
 *
 * TODO(phase-3): verify against a real dumped payload — in particular
 * whether subagent hook payloads keep the parent's session_id (they must,
 * or subagent events split into a second trace).
 */
import type { EntityRef, TraceEvent } from "@agenttrace/protocol";
import { nextEventId } from "../emit.js";

const PROVIDER = { adapter: "codex", adapterVersion: "0.1" } as const;

type HookPayload = Record<string, unknown>;

const MAIN: EntityRef = { id: "codex_main", kind: "agent", name: "Codex" };
const USER: EntityRef = { id: "user", kind: "agent", name: "User" };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The agent a hook fired for: the subagent when ids are present, else main. */
function agentRef(payload: HookPayload): EntityRef {
  const id = str(payload.agent_id);
  if (!id) return MAIN;
  return {
    id,
    kind: "agent",
    name: str(payload.agent_type) ?? id,
    subtype: "codex_subagent",
  };
}

function toolRef(payload: HookPayload): EntityRef {
  const name = str(payload.tool_name) ?? "unknown_tool";
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
      rawEventType: str(payload.hook_event_name),
    },
  };
}

function toolCorrelation(payload: HookPayload): string | undefined {
  return str(payload.tool_use_id) ?? str(payload.turn_id);
}

export function mapCodexHook(payload: unknown): TraceEvent[] {
  if (!payload || typeof payload !== "object") return [];
  const p = payload as HookPayload;
  const hookName = str(p.hook_event_name) ?? "";
  const agent = agentRef(p);

  switch (hookName) {
    case "SessionStart":
      return [{
        ...base(p), source: agent, category: "system", type: "session_start",
        status: "started",
        payload: { source: p.source, model: p.model, cwd: p.cwd },
      }];
    case "SessionEnd":
      return [{
        ...base(p), source: agent, category: "system", type: "session_end",
        status: "success", payload: p,
      }];
    case "UserPromptSubmit":
      return [{
        ...base(p), source: USER, destination: agent,
        category: "agent", type: "agent_message", status: "success",
        correlationId: str(p.turn_id),
        payload: { prompt: p.prompt },
      }];
    case "SubagentStart":
      // Parent -> child delegation edge: the hook fires on the child with
      // agent_id (child thread id) + agent_type.
      return [{
        ...base(p), source: MAIN, destination: agentRef(p),
        category: "agent", type: "agent_start", status: "started",
        correlationId: str(p.agent_id) ?? str(p.turn_id),
        payload: { agent_type: p.agent_type },
      }];
    case "SubagentStop":
      return [{
        ...base(p), source: agent,
        category: "agent", type: "agent_stop",
        status: "success",
        correlationId: str(p.agent_id) ?? str(p.turn_id),
        payload: { last_assistant_message: p.last_assistant_message },
      }];
    case "PreToolUse": {
      const tool = toolRef(p);
      return [{
        ...base(p), source: agent, destination: tool,
        category: "tool", type: "tool_call", status: "started",
        correlationId: toolCorrelation(p),
        payload: { tool_input: p.tool_input },
      }];
    }
    case "PostToolUse": {
      const tool = toolRef(p);
      return [{
        ...base(p), source: tool, destination: agent,
        category: "tool", type: "tool_result",
        // TODO(phase-3): confirm the failure marker inside tool_response.
        status: "success",
        correlationId: toolCorrelation(p),
        payload: { tool_response: p.tool_response },
      }];
    }
    case "Stop":
      return [{
        ...base(p), source: agent, category: "agent", type: "agent_stop",
        status: "success", correlationId: str(p.turn_id),
      }];
    case "PermissionRequest":
    case "PreCompact":
    case "PostCompact":
      return [{
        ...base(p), source: agent, category: "system", type: "status_change",
        status: "started", payload: p,
      }];
    default:
      // Unknown hooks are ignored — never invent canonical events.
      return [];
  }
}
