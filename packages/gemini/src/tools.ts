/**
 * Gemini function declarations (spec §19). Gemini selects a function and
 * produces structured arguments — the application, not the model, executes
 * them against the deterministic trace API.
 *
 * Names must match runQuery() in packages/collector/src/analysis/queries.ts.
 */
import { Type, type FunctionDeclaration } from "@google/genai";

const traceIdParam = {
  name: "traceId",
  type: Type.STRING,
  description: "ID of the trace to query",
};

export const traceToolDeclarations: FunctionDeclaration[] = [
  {
    name: "getTraceSummary",
    description: "High-level metrics for a trace: duration, agents, counts, status.",
    parameters: {
      type: Type.OBJECT,
      properties: { traceId: traceIdParam },
      required: ["traceId"],
    },
  },
  {
    name: "getAgentActivity",
    description: "All events where the given agent was source or destination.",
    parameters: {
      type: Type.OBJECT,
      properties: { traceId: traceIdParam, agentId: { type: Type.STRING } },
      required: ["traceId", "agentId"],
    },
  },
  {
    name: "getToolCalls",
    description: "Tool call/result events, optionally filtered by tool name.",
    parameters: {
      type: Type.OBJECT,
      properties: { traceId: traceIdParam, toolName: { type: Type.STRING } },
      required: ["traceId"],
    },
  },
  {
    name: "getFailures",
    description: "Failure report: first failure, owning entity, preceding success.",
    parameters: {
      type: Type.OBJECT,
      properties: { traceId: traceIdParam },
      required: ["traceId"],
    },
  },
  {
    name: "getCriticalPath",
    description: "Longest-duration spans contributing to total latency.",
    parameters: {
      type: Type.OBJECT,
      properties: { traceId: traceIdParam },
      required: ["traceId"],
    },
  },
  {
    name: "getEventsBetween",
    description: "Events within an ISO-8601 time window.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        traceId: traceIdParam,
        start: { type: Type.STRING },
        end: { type: Type.STRING },
      },
      required: ["traceId", "start", "end"],
    },
  },
  {
    name: "getEventsBefore",
    description: "The N events immediately preceding a given event.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        traceId: traceIdParam,
        eventId: { type: Type.STRING },
        count: { type: Type.NUMBER },
      },
      required: ["traceId", "eventId"],
    },
  },
  {
    name: "getExactDuplicateCalls",
    description: "Exact duplicate tool calls (same tool + identical arguments).",
    parameters: {
      type: Type.OBJECT,
      properties: { traceId: traceIdParam },
      required: ["traceId"],
    },
  },
];
