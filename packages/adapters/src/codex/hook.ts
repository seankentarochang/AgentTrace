/**
 * Codex lifecycle hook -> TraceEvent mapping (spec §10).
 *
 * Field names verified against codex-rs/hooks schema (codex-cli >=0.120):
 * flat, Claude-style — `session_id`, `turn_id`, `agent_id`, `agent_type`,
 * `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`,
 * `tool_name`, `tool_input`, `tool_use_id`, `tool_response`, `prompt`,
 * `source`, `stop_hook_active`. Nested `tool.*`/`agent.*` fallbacks are kept
 * for tolerance; unknown hooks map to [] — never invent canonical events.
 *
 * Hooks require `[features] codex_hooks = true` plus .codex/hooks.json —
 * see packages/adapters/HOOKS.md.
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
  const id =
    str(agent?.id) ??
    str(payload.agent_id) ??
    str(payload.subagent_id) ??
    fallback;
  return {
    id,
    kind: "agent",
    name: str(agent?.name) ?? str(payload.agent_type) ?? id,
    subtype: "codex",
  };
}

function toolRef(payload: HookPayload): EntityRef {
  const tool = payload.tool as HookPayload | undefined;
  const name = str(tool?.name) ?? str(payload.tool_name) ?? "unknown_tool";
  return { id: `tool_${name}`, kind: "tool", name };
}

function toolInput(payload: HookPayload): unknown {
  const tool = payload.tool as HookPayload | undefined;
  return tool?.input ?? payload.tool_input;
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

// §8 priority: tool call ID -> task ID -> turn ID.
function correlationId(payload: HookPayload): string | undefined {
  const tool = payload.tool as HookPayload | undefined;
  return (
    str(payload.tool_use_id) ??
    str(tool?.call_id) ??
    str(payload.tool_call_id) ??
    str(payload.call_id) ??
    str(payload.task_id) ??
    str(payload.turn_id)
  );
}

// PostToolUse failure detection: only explicit error signals count.
function toolFailed(payload: HookPayload): boolean {
  const res = payload.tool_response as HookPayload | undefined;
  if (payload.error || res?.error || res?.is_error === true) return true;
  const code = res?.exit_code ?? res?.exitCode;
  return typeof code === "number" && code !== 0;
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
      return [{
        ...base(p), source, category: "system", type: "session_end",
        status: "success", payload: p,
      }];
    case "Stop":
      // A turn completed — not a session end.
      return [{
        ...base(p), source, category: "system", type: "status_change",
        status: "success", correlationId: correlationId(p), payload: p,
      }];
    case "SubagentStart":
      // agent_id is the CHILD's id in subagent context — using `source`
      // (which resolves to the child) as destination would self-loop. The
      // span must live on the child, so the edge is child -> parent.
      return [{
        ...base(p), source: agentRef(p, "codex_subagent"),
        destination: { id: "codex_main", kind: "agent", name: "Codex", subtype: "codex" },
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
        correlationId: correlationId(p),
        payload: { arguments: toolInput(p), raw: p },
      }];
    }
    case "PostToolUse": {
      const tool = toolRef(p);
      const res = p.tool_response as HookPayload | undefined;
      return [{
        ...base(p), source: tool, destination: source,
        category: "tool", type: "tool_result",
        status: toolFailed(p) ? "failure" : "success",
        correlationId: correlationId(p),
        payload: { result: res ?? p.tool_response, raw: p },
      }];
    }
    case "UserPromptSubmit":
      return [{
        ...base(p),
        source: { id: "user", kind: "agent", name: "User" },
        destination: source,
        category: "agent", type: "agent_message", status: "success",
        payload: { prompt: str(p.prompt), raw: p },
      }];
    case "PermissionRequest":
    case "PreCompact":
    case "PostCompact":
      return [{
        ...base(p), source, category: "system", type: "status_change",
        status: "started", correlationId: correlationId(p), payload: p,
      }];
    default:
      // Unknown hooks are ignored — never invent canonical events.
      return [];
  }
}
