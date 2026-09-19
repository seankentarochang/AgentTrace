/**
 * Gemini function declarations (spec §19). Gemini selects a function and
 * produces structured arguments — the application, not the model, executes
 * them against the deterministic trace API.
 *
 * Names must match runQuery() in packages/collector/src/analysis/queries.ts.
 */
import { Behavior, Type, type FunctionDeclaration } from "@google/genai";

const traceIdParam = {
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
    description:
      "Critical path through the span tree: the chain of agent/tool spans the run was actually waiting on.",
    parameters: {
      type: Type.OBJECT,
      properties: { traceId: traceIdParam },
      required: ["traceId"],
    },
  },
  {
    name: "getConcurrency",
    description:
      "Which agents worked in parallel: max concurrent agents/tool calls, overlapping agent pairs with overlap ms, idle intervals.",
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

/**
 * Voice UI tools — declared to Gemini but EXECUTED in the dashboard, not the
 * collector. They change what the user sees; every answer about the trace
 * still comes from the deterministic query functions above.
 *
 * Gemini 3.8 Live function calls are async-only, so these are NON_BLOCKING —
 * the model keeps talking while the UI applies the change.
 */
const entityIdParam = {
  type: Type.STRING,
  description: "Entity id, e.g. agent_researcher or tool_shell (from UI_CONTEXT)",
};

export const voiceUiToolDeclarations: FunctionDeclaration[] = [
  {
    name: "selectEvent",
    behavior: Behavior.NON_BLOCKING,
    description:
      "Open/focus an event in the inspector. Use when the user says open/show/look at an event.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        eventId: { type: Type.STRING, description: "Event id to select" },
      },
      required: ["eventId"],
    },
  },
  {
    name: "selectAgent",
    behavior: Behavior.NON_BLOCKING,
    description:
      "Focus an agent node — selects its most recent event. Use for 'focus on X', 'show me agent Y', or deictic references like 'that agent' resolved via UI_CONTEXT.",
    parameters: {
      type: Type.OBJECT,
      properties: { agentId: entityIdParam },
      required: ["agentId"],
    },
  },
  {
    name: "highlightEvents",
    behavior: Behavior.NON_BLOCKING,
    description:
      "Highlight a set of events' entities in the graph (dims everything else). Use for 'highlight that path', 'show these two', 'mark the chain'.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        eventIds: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: "Event ids to highlight",
        },
      },
      required: ["eventIds"],
    },
  },
  {
    name: "isolateEntity",
    behavior: Behavior.NON_BLOCKING,
    description:
      "Show only an entity and its downstream subtree in the graph. Use for 'isolate this branch/subtree', 'just show me what X spawned'.",
    parameters: {
      type: Type.OBJECT,
      properties: { entityId: entityIdParam },
      required: ["entityId"],
    },
  },
  {
    name: "setViewUntil",
    behavior: Behavior.NON_BLOCKING,
    description:
      "Scrub the visible timeline: show only events up to a point. Provide eventId ('rewind to right there/that event') OR seconds from trace start.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        eventId: { type: Type.STRING },
        seconds: { type: Type.NUMBER, description: "Seconds from trace start" },
      },
    },
  },
  {
    name: "showFailures",
    behavior: Behavior.NON_BLOCKING,
    description:
      "Highlight every event with failure status. Use for 'show me the failures/errors'.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "clearView",
    behavior: Behavior.NON_BLOCKING,
    description:
      "Clear selection, highlights, isolation and timeline scrub — back to the full trace. Use for 'reset/clear the view'.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
];
