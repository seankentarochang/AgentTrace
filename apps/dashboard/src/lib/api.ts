/** REST helpers for the collector API. Shapes mirror the frozen contract. */
import type { TraceEvent, TraceState } from "@agenttrace/protocol";

export interface TraceSummary {
  traceId: string;
  providers: string[];
  eventCount: number;
  startedAt?: string;
  endedAt?: string;
  status: "running" | "success" | "failure";
}

export interface AssistantResult {
  answer: string;
  /** Deterministic query functions Gemini called (Track 3 populates this). */
  functionsCalled?: string[];
  error?: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return (await res.json()) as T;
}

export function listTraces(): Promise<{ traces: TraceSummary[] }> {
  return getJson("/v1/traces");
}

export function getTrace(
  traceId: string,
): Promise<{ traceId: string; events: TraceEvent[]; state: TraceState }> {
  return getJson(`/v1/traces/${encodeURIComponent(traceId)}`);
}

export async function askAssistant(
  question: string,
  traceId: string,
): Promise<AssistantResult> {
  const res = await fetch("/v1/assistant", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question, traceId }),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<AssistantResult>;
  if (!res.ok) {
    return {
      answer: "",
      error: body.error ?? `assistant unavailable (HTTP ${res.status})`,
    };
  }
  return {
    answer: body.answer ?? "(empty answer)",
    functionsCalled: body.functionsCalled,
  };
}
