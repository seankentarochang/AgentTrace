/**
 * Gemini Live voice layer (spec §19 voice extension). The dashboard opens a
 * Live session directly to Google with an ephemeral token minted here — the
 * API key never reaches the browser.
 *
 * Model: gemini-3.8-live (low-latency default). Override with
 * GEMINI_LIVE_MODEL=gemini-3.8-live-extended-thinking for background
 * reasoning. Function calls on 3.8 Live are async-only (NON_BLOCKING), and
 * turnComplete no longer means idle — the client keeps listening.
 */
import { GoogleGenAI } from "@google/genai";

/** Lazy env read — this module ships to the dashboard too. */
function voiceModel(): string {
  return process.env.GEMINI_LIVE_MODEL ?? "gemini-3.8-live";
}

export const VOICE_SYSTEM_PROMPT = `You are AgentTrace's voice interface — the user speaks to the trace visualization and you answer by voice.

Rules:
- NEVER invent trace facts. Numbers, entities, ordering, failures, durations, and topology come ONLY from the declared query functions, which read the deterministic AgentTrace backend. If a function returns an error or no data, say so plainly.
- The user talks about what they SEE. UI_CONTEXT messages describe the current screen: selected event, recent selections, highlighted events, isolated entity, timeline position, and the id/name map for agents and tools. Resolve "that", "this", "these two", "right there", "the other agent" to concrete ids using it BEFORE calling functions — don't ask unless genuinely ambiguous.
- UI functions (selectEvent, selectAgent, highlightEvents, isolateEntity, setViewUntil, showFailures, clearView) change the screen — call them for show/focus/highlight/open/rewind/isolate requests and confirm briefly ("Showing the failure path").
- Queries need a traceId — take it from UI_CONTEXT.traceId, never ask the user for ids.
- Answers are SPOKEN: lead with the answer, 1-3 short sentences, no markdown, no bullet lists. For a fact question, call the function then summarize. For a screen change plus explanation, call both.`;

/** Mints a short-lived ephemeral token the dashboard uses for ai.live.connect. */
export async function createVoiceToken(): Promise<
  { token: string; model: string } | { error: string }
> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { error: "voice needs GEMINI_API_KEY (Live API is Gemini-only)" };
  }
  try {
    const ai = new GoogleGenAI({ apiKey });
    const auth = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(Date.now() + 30 * 60_000).toISOString(),
        newSessionExpireTime: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    if (!auth.name) return { error: "token mint returned no token" };
    return { token: auth.name, model: voiceModel() };
  } catch (err) {
    return { error: `token mint failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
