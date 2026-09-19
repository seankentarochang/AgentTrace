/**
 * In-memory event store with optional JSONL persistence.
 * The event log is the source of truth (spec §22) — derived state is
 * always rebuilt from it via the protocol reducer.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compareEvents, type TraceEvent } from "@agenttrace/protocol";

export interface TraceSummary {
  traceId: string;
  providers: string[];
  eventCount: number;
  startedAt?: string;
  endedAt?: string;
  status: "running" | "success" | "failure";
}

export class EventStore {
  private events = new Map<string, TraceEvent[]>();
  /** eventIds already stored — makes ingest idempotent under adapter retries. */
  private seen = new Set<string>();
  private file?: string;

  constructor(dataDir?: string) {
    if (dataDir) {
      mkdirSync(dataDir, { recursive: true });
      this.file = join(dataDir, "events.jsonl");
      this.load();
    }
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    const lines = readFileSync(this.file, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as TraceEvent;
        this.addToMemory(event);
      } catch {
        // Skip corrupt lines rather than failing boot.
      }
    }
  }

  private addToMemory(event: TraceEvent): boolean {
    if (this.seen.has(event.eventId)) return false;
    this.seen.add(event.eventId);
    const list = this.events.get(event.traceId) ?? [];
    list.push(event);
    this.events.set(event.traceId, list);
    return true;
  }

  /** Returns false (and stores nothing) if the eventId was already ingested. */
  add(event: TraceEvent): boolean {
    if (!this.addToMemory(event)) return false;
    if (this.file) {
      appendFileSync(this.file, JSON.stringify(event) + "\n");
    }
    return true;
  }

  getTrace(traceId: string): TraceEvent[] {
    return this.events.get(traceId) ?? [];
  }

  listTraces(): TraceSummary[] {
    const summaries: TraceSummary[] = [];
    for (const [traceId, events] of this.events) {
      const ordered = [...events].sort(compareEvents);
      const last = ordered[ordered.length - 1];
      const hasFailure = ordered.some((e) => e.status === "failure");
      const ended = ordered.some(
        (e) => e.type === "session_end" || e.type === "agent_stop",
      );
      summaries.push({
        traceId,
        providers: [...new Set(ordered.map((e) => e.provider.adapter))],
        eventCount: ordered.length,
        startedAt: ordered[0]?.timestamp,
        endedAt: ended ? last?.timestamp : undefined,
        status: hasFailure ? "failure" : ended ? "success" : "running",
      });
    }
    // Newest first.
    return summaries.sort(
      (a, b) => Date.parse(b.startedAt ?? "") - Date.parse(a.startedAt ?? "") || 0,
    );
  }

  traceIds(): string[] {
    return [...this.events.keys()];
  }
}
