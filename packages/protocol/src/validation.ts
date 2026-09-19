import { z } from "zod";
import type { TraceEvent } from "./trace-event.js";

const EntityRefSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["agent", "tool", "model", "external_service"]),
  name: z.string().min(1),
  subtype: z.string().optional(),
});

const ProviderMetadataSchema = z.object({
  adapter: z.enum(["a2a", "codex", "claude", "mcp", "custom"]),
  rawEventType: z.string().optional(),
  adapterVersion: z.string().min(1),
});

export const TraceEventSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().min(1),
  traceId: z.string().min(1),
  timestamp: z.string().min(1),
  monotonicNs: z.number().optional(),
  source: EntityRefSchema,
  destination: EntityRefSchema.optional(),
  category: z.enum(["agent", "tool", "model", "artifact", "system"]),
  type: z.enum([
    "session_start",
    "session_end",
    "agent_start",
    "agent_stop",
    "agent_message",
    "tool_call",
    "tool_result",
    "artifact_created",
    "status_change",
    "error",
  ]),
  correlationId: z.string().optional(),
  parentEventId: z.string().optional(),
  status: z.enum(["started", "success", "failure", "cancelled"]).optional(),
  payload: z.unknown().optional(),
  durationMs: z.number().optional(),
  visibility: z.enum(["full_protocol", "structured_event", "lifecycle_only"]),
  provider: ProviderMetadataSchema,
}) satisfies z.ZodType<TraceEvent>;

export type ValidationResult =
  | { ok: true; event: TraceEvent }
  | { ok: false; errors: string[] };

export function validateTraceEvent(input: unknown): ValidationResult {
  const result = TraceEventSchema.safeParse(input);
  if (result.success) {
    return { ok: true, event: result.data as TraceEvent };
  }
  return {
    ok: false,
    errors: result.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    ),
  };
}
