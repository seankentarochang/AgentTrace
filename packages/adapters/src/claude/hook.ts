/**
 * Claude Code lifecycle hook -> TraceEvent mapping (spec §11).
 *
 * TODO(track-3): implement after the Codex adapter works — Claude hook
 * payloads use different field names (`hook_event_name`, `tool_name`,
 * `tool_input`, `session_id`, `transcript_path`). Same pattern as
 * codex/hook.ts; map only documented fields.
 */
import type { TraceEvent } from "@agenttrace/protocol";

export function mapClaudeHook(_payload: unknown): TraceEvent[] {
  return [];
}
