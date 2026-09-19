/**
 * Claude Code lifecycle hook -> TraceEvent mapping (spec §11).
 *
 * Documented input fields (stdin JSON): `session_id`, `transcript_path`,
 * `cwd`, `permission_mode`, `hook_event_name`; tool events add `tool_name`,
 * `tool_input`, `tool_use_id`, and PostToolUse adds `tool_response`.
 * UserPromptSubmit: `prompt`. SessionStart: `source`. SessionEnd: `reason`.
 * Stop/SubagentStop: `stop_hook_active`. Only documented fields are mapped;
 * unknown hooks -> [] — never invent canonical events.
 */
import type { EntityRef, TraceEvent } from "@agenttrace/protocol";
import { nextEventId } from "../emit.js";

const PROVIDER = { adapter: "claude", adapterVersion: "0.1" } as const;

type HookPayload = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function validTimestamp(value: unknown): string | undefined {
  const ts = str(value);
  return ts && !Number.isNaN(Date.parse(ts)) ? ts : undefined;
}

const MAIN: EntityRef = {
  id: "agent_claude_main",
  kind: "agent",
  name: "Claude",
  subtype: "claude_code",
};

function subagentRef(payload: HookPayload): EntityRef {
  const name =
    str(payload.subagent_type) ?? str(payload.agent_type) ?? "subagent";
  const id = str(payload.agent_id) ?? `agent_claude_sub_${name}`;
  return { id, kind: "agent", name, subtype: "claude_code" };
}

function toolRef(payload: HookPayload): EntityRef {
  const name = str(payload.tool_name) ?? "unknown_tool";
  return { id: `tool_${name}`, kind: "tool", name };
}

function base(payload: HookPayload) {
  return {
    schemaVersion: 1 as const,
    eventId: nextEventId(),
    traceId: str(payload.session_id) ?? "trace_claude_unknown",
    // A non-ISO hook timestamp would yield NaN in the reducer's span math.
    timestamp: validTimestamp(payload.timestamp) ?? new Date().toISOString(),
    visibility: "structured_event" as const,
    provider: {
      ...PROVIDER,
      rawEventType: str(payload.hook_event_name),
    },
  };
}

// PostToolUse failure detection: only explicit error signals count.
function toolFailed(payload: HookPayload): boolean {
  const res = payload.tool_response as HookPayload | undefined;
  if (payload.error || res?.error || res?.is_error === true) return true;
  const code = res?.exit_code ?? res?.exitCode;
  return typeof code === "number" && code !== 0;
}

export function mapClaudeHook(payload: unknown): TraceEvent[] {
  if (!payload || typeof payload !== "object") return [];
  const p = payload as HookPayload;
  const hookName = str(p.hook_event_name) ?? "";
  const callId = str(p.tool_use_id);

  switch (hookName) {
    case "SessionStart":
      return [{
        ...base(p), source: MAIN, category: "system", type: "session_start",
        status: "started", payload: p,
      }];
    case "SessionEnd":
      return [{
        ...base(p), source: MAIN, category: "system", type: "session_end",
        status: "success", payload: p,
      }];
    case "Stop":
      // Main agent finished responding — a turn boundary, not a session end.
      return [{
        ...base(p), source: MAIN, category: "system", type: "status_change",
        status: "success", payload: p,
      }];
    case "SubagentStop":
      return [{
        ...base(p), source: subagentRef(p),
        category: "agent", type: "agent_stop",
        status: str(p.status) === "failure" ? "failure" : "success",
        payload: p,
      }];
    case "PreToolUse": {
      const tool = toolRef(p);
      return [{
        ...base(p), source: MAIN, destination: tool,
        category: "tool", type: "tool_call", status: "started",
        correlationId: callId,
        payload: { arguments: p.tool_input, raw: p },
      }];
    }
    case "PostToolUse": {
      const tool = toolRef(p);
      return [{
        ...base(p), source: tool, destination: MAIN,
        category: "tool", type: "tool_result",
        status: toolFailed(p) ? "failure" : "success",
        correlationId: callId,
        payload: { result: p.tool_response, raw: p },
      }];
    }
    case "UserPromptSubmit":
      return [{
        ...base(p),
        source: { id: "user", kind: "agent", name: "User" },
        destination: MAIN,
        category: "agent", type: "agent_message", status: "success",
        payload: { prompt: str(p.prompt), raw: p },
      }];
    case "Notification":
    case "PermissionRequest":
    case "PreCompact":
    case "PostCompact":
      return [{
        ...base(p), source: MAIN, category: "system", type: "status_change",
        status: "started", payload: p,
      }];
    default:
      // Unknown hooks are ignored — never invent canonical events.
      return [];
  }
}
