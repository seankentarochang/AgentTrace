/**
 * Shared helper every adapter uses to push a normalized TraceEvent into
 * the collector. Adapters own provider->canonical translation only.
 */
import { randomUUID } from "node:crypto";
import type { TraceEvent } from "@agenttrace/protocol";

export const COLLECTOR_URL =
  process.env.AGENTTRACE_COLLECTOR_URL ?? "http://localhost:8787";

const clockOrigin = process.hrtime.bigint();
let lastMonotonicNs = 0;

/** Globally unique: several adapter processes emit concurrently and the collector dedupes by eventId. */
export function nextEventId(prefix = "evt"): string {
  return `${prefix}_${randomUUID()}`;
}

/** Fire-and-forget by default; adapters must never break the host tool. */
export async function emitEvent(event: TraceEvent): Promise<boolean> {
  try {
    // Stamp before the first await so same-ms causal pairs keep emission order.
    lastMonotonicNs = Math.max(Number(process.hrtime.bigint() - clockOrigin), lastMonotonicNs + 1);
    const stamped = { ...event, monotonicNs: event.monotonicNs ?? lastMonotonicNs };
    const res = await fetch(`${COLLECTOR_URL}/v1/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: stamped }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Best-effort emit that never throws — safe for hook processes. */
export function emitEventSafe(event: TraceEvent): void {
  void emitEvent(event).catch(() => {});
}
