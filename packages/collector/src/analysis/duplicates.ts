/**
 * Exact-duplicate detection only (spec §14): same tool + canonicalized
 * arguments + same trace. Semantic similarity is never asserted here —
 * Gemini may flag it later, labelled as inference.
 */
import type { TraceEvent } from "@agenttrace/protocol";

export interface DuplicateGroup {
  tool: string;
  argumentsKey: string;
  eventIds: string[];
  count: number;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
}

export function getExactDuplicateCalls(events: TraceEvent[]): DuplicateGroup[] {
  const groups = new Map<string, DuplicateGroup>();
  for (const event of events) {
    if (event.type !== "tool_call" || !event.destination) continue;
    const payload = event.payload as Record<string, unknown> | undefined;
    const argsKey = stableStringify(payload?.arguments ?? payload ?? null);
    const key = `${event.destination.id}::${argsKey}`;
    const group = groups.get(key) ?? {
      tool: event.destination.name,
      argumentsKey: argsKey,
      eventIds: [],
      count: 0,
    };
    group.eventIds.push(event.eventId);
    group.count += 1;
    groups.set(key, group);
  }
  return [...groups.values()].filter((g) => g.count > 1);
}
