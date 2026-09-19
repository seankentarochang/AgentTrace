/**
 * Canonical event schema — the most important architectural component.
 * Mirrors tech spec §6. Provider-specific semantics must stop at the
 * adapter boundary; everything downstream consumes only these types.
 */

export interface EntityRef {
  id: string;
  kind: "agent" | "tool" | "model" | "external_service";
  name: string;
  subtype?: string;
}

export type Visibility =
  | "full_protocol"
  | "structured_event"
  | "lifecycle_only";

export interface ProviderMetadata {
  adapter: "a2a" | "codex" | "claude" | "mcp" | "custom";
  rawEventType?: string;
  adapterVersion: string;
}

export type EventCategory = "agent" | "tool" | "model" | "artifact" | "system";

export type EventType =
  | "session_start"
  | "session_end"
  | "agent_start"
  | "agent_stop"
  | "agent_message"
  | "tool_call"
  | "tool_result"
  | "artifact_created"
  | "status_change"
  | "error";

export type EventStatus = "started" | "success" | "failure" | "cancelled";

export interface TraceEvent {
  schemaVersion: 1;

  eventId: string;
  traceId: string;

  /** ISO 8601 timestamp. */
  timestamp: string;
  monotonicNs?: number;

  source: EntityRef;
  destination?: EntityRef;

  category: EventCategory;
  type: EventType;

  /** Correlates related events, e.g. A2A task id or tool call id. */
  correlationId?: string;
  parentEventId?: string;

  status?: EventStatus;

  payload?: unknown;

  durationMs?: number;

  visibility: Visibility;

  provider: ProviderMetadata;
}
