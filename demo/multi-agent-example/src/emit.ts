/**
 * Demo agents self-report tool activity as structured events — the same
 * way a framework's hooks would. Provider adapter is "custom": these are
 * demo-owned emitters, not protocol traffic.
 */
import type { TraceEvent } from "@agenttrace/protocol";

const COLLECTOR = process.env.AGENTTRACE_COLLECTOR_URL ?? "http://localhost:8787";

let counter = 0;

export async function emit(event: TraceEvent): Promise<void> {
  try {
    await fetch(`${COLLECTOR}/v1/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event }),
    });
  } catch {
    // Demo agents must run even with the collector down.
  }
}

export function eventId(prefix = "demo"): string {
  return `${prefix}_${Date.now().toString(36)}_${counter++}`;
}
