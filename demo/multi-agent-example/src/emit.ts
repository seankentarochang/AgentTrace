/**
 * Demo agents self-report tool activity as structured events — the same
 * way a framework's hooks would. Provider adapter is "custom": these are
 * demo-owned emitters, not protocol traffic.
 */
import { randomUUID } from "node:crypto";
import type { TraceEvent } from "@agenttrace/protocol";

const COLLECTOR = process.env.AGENTTRACE_COLLECTOR_URL ?? "http://localhost:8787";
const clockOrigin = process.hrtime.bigint();
let lastMonotonicNs = 0;

export async function emit(event: TraceEvent): Promise<void> {
  try {
    // Stamp before the first await so same-ms causal pairs keep emission order.
    lastMonotonicNs = Math.max(Number(process.hrtime.bigint() - clockOrigin), lastMonotonicNs + 1);
    const stamped = { ...event, monotonicNs: event.monotonicNs ?? lastMonotonicNs };
    await fetch(`${COLLECTOR}/v1/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: stamped }),
    });
  } catch {
    // Demo agents must run even with the collector down.
  }
}

/** Globally unique: agents run as separate processes and the collector dedupes by eventId. */
export function eventId(prefix = "demo"): string {
  return `${prefix}_${randomUUID()}`;
}
