/**
 * Voice tool execution, split by ownership:
 * - Query functions reuse the collector's deterministic REST paths (pathFor)
 *   through the vite proxy — same endpoints as the text assistant.
 * - UI functions dispatch to explicit UiActions implemented in App — Gemini
 *   never manipulates the DOM or app state directly.
 */
import {
  pathFor,
  validateArgs,
  voiceUiToolDeclarations,
} from "@agenttrace/gemini";

export interface UiActions {
  /** Focus/open a specific event in the inspector. */
  selectEvent: (eventId: string) => void;
  /** Focus an agent — selects its most recent event (deterministic lookup). */
  selectAgent: (agentId: string) => { ok: boolean; eventId?: string; error?: string };
  /** Highlight the entities behind a set of events; dims the rest. */
  highlightEvents: (eventIds: string[]) => { ok: boolean; error?: string };
  /** Show only an entity + its downstream subtree. */
  isolateEntity: (entityId: string) => { ok: boolean; error?: string };
  /** Scrub the visible timeline to an event or N seconds from start. */
  setViewUntil: (args: { eventId?: string; seconds?: number }) => { ok: boolean; error?: string };
  /** Highlight all failure-status events. */
  showFailures: () => { ok: boolean; count: number };
  /** Clear selection/highlight/isolation/scrub. */
  clearView: () => void;
}

const UI_NAMES = new Set(voiceUiToolDeclarations.map((d) => d.name));

export function isUiTool(name: string): boolean {
  return UI_NAMES.has(name);
}

/** Query functions -> collector REST (relative path -> vite proxy). */
async function executeQueryTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const validated = validateArgs(name, args);
  if (!validated.ok) return { error: validated.error };
  try {
    const res = await fetch(pathFor(name, validated.args));
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { error: body.error ?? `HTTP ${res.status}` };
    return body;
  } catch {
    return { error: "collector unreachable" };
  }
}

/** UI functions -> deterministic actions in App. Never throws. */
function executeUiTool(
  name: string,
  args: Record<string, unknown>,
  actions: UiActions,
): unknown {
  switch (name) {
    case "selectEvent": {
      const id = String(args.eventId ?? "");
      if (!id) return { error: "eventId required" };
      actions.selectEvent(id);
      return { ok: true };
    }
    case "selectAgent":
      return actions.selectAgent(String(args.agentId ?? ""));
    case "highlightEvents": {
      const ids = Array.isArray(args.eventIds)
        ? (args.eventIds as unknown[]).map(String).filter(Boolean)
        : [];
      return ids.length ? actions.highlightEvents(ids) : { error: "eventIds required" };
    }
    case "isolateEntity":
      return actions.isolateEntity(String(args.entityId ?? ""));
    case "setViewUntil":
      return actions.setViewUntil({
        eventId: args.eventId ? String(args.eventId) : undefined,
        seconds: typeof args.seconds === "number" ? args.seconds : undefined,
      });
    case "showFailures":
      return actions.showFailures();
    case "clearView":
      actions.clearView();
      return { ok: true };
    default:
      return { error: `unknown UI function: ${name}` };
  }
}

/** One dispatch for every function call the Live session emits. */
export async function executeVoiceTool(
  name: string,
  args: Record<string, unknown>,
  actions: UiActions,
): Promise<unknown> {
  try {
    return isUiTool(name)
      ? executeUiTool(name, args, actions)
      : await executeQueryTool(name, args);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
