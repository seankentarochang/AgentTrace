/**
 * Gemini Live voice session: mic -> Live API -> tool calls -> deterministic
 * results -> spoken answer. The dashboard connects directly to Google with an
 * ephemeral token minted by POST /v1/voice/token (key stays server-side).
 *
 * Deictic context: pushContext() sends the current UI state as a
 * turnComplete:false client-content turn — the model resolves "that",
 * "these two", "right there" against it before calling tools.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Behavior,
  GoogleGenAI,
  Modality,
  type Session,
} from "@google/genai";
import {
  traceToolDeclarations,
  VOICE_SYSTEM_PROMPT,
  voiceUiToolDeclarations,
} from "@agenttrace/gemini";
import { startMic, createPlayer } from "./audio";
import { executeVoiceTool, type UiActions } from "./uiTools";

export type VoiceStatus = "off" | "connecting" | "live" | "error";

export interface VoiceLine {
  role: "you" | "gemini";
  text: string;
}

export interface VoiceHandle {
  status: VoiceStatus;
  speaking: boolean;
  error?: string;
  lines: VoiceLine[];
  start: () => void;
  stop: () => void;
  /** Push the current UI context into the session (debounced). */
  pushContext: () => void;
}

// Query declarations get NON_BLOCKING too — 3.8 Live function calls are
// async-only; the model keeps talking while we fetch the result.
const VOICE_DECLS = [
  ...traceToolDeclarations.map((d) => ({ ...d, behavior: Behavior.NON_BLOCKING })),
  ...voiceUiToolDeclarations,
];

const CONTEXT_DEBOUNCE_MS = 300;
const MAX_LINES = 8;

export function useVoice(opts: {
  contextJson: () => string;
  actions: UiActions;
}): VoiceHandle {
  const [status, setStatus] = useState<VoiceStatus>("off");
  const [error, setError] = useState<string>();
  const [lines, setLines] = useState<VoiceLine[]>([]);
  const [partials, setPartials] = useState<{ you: string; gemini: string }>({
    you: "",
    gemini: "",
  });

  const optsRef = useRef(opts);
  optsRef.current = opts;
  const sessionRef = useRef<Session | undefined>(undefined);
  const playerRef = useRef<ReturnType<typeof createPlayer> | undefined>(undefined);
  const stopMicRef = useRef<(() => void) | undefined>(undefined);
  const ctxTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const pushContext = useCallback(() => {
    clearTimeout(ctxTimer.current);
    ctxTimer.current = setTimeout(() => {
      const session = sessionRef.current;
      if (!session) return;
      try {
        session.sendClientContent({
          turns: [
            {
              role: "user",
              parts: [{ text: `UI_CONTEXT ${optsRef.current.contextJson()}` }],
            },
          ],
          turnComplete: false,
        });
      } catch {
        // Session may have just closed — the next connect re-sends context.
      }
    }, CONTEXT_DEBOUNCE_MS);
  }, []);

  const stop = useCallback(() => {
    clearTimeout(ctxTimer.current);
    stopMicRef.current?.();
    stopMicRef.current = undefined;
    playerRef.current?.close();
    playerRef.current = undefined;
    try {
      sessionRef.current?.close();
    } catch {
      // already closed
    }
    sessionRef.current = undefined;
    setStatus("off");
    setPartials({ you: "", gemini: "" });
  }, []);

  const start = useCallback(async () => {
    if (sessionRef.current) return;
    setStatus("connecting");
    setError(undefined);

    let token: string;
    let model: string;
    try {
      const res = await fetch("/v1/voice/token", { method: "POST" });
      const body = (await res.json()) as {
        token?: string;
        model?: string;
        error?: string;
      };
      if (!res.ok || !body.token || !body.model) {
        throw new Error(body.error ?? `voice token failed (${res.status})`);
      }
      token = body.token;
      model = body.model;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
      return;
    }

    try {
      const ai = new GoogleGenAI({ apiKey: token });
      const session = await ai.live.connect({
        model,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: { parts: [{ text: VOICE_SYSTEM_PROMPT }] },
          tools: [{ functionDeclarations: VOICE_DECLS }],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => setStatus("live"),
          onclose: () => {
            stopMicRef.current?.();
            stopMicRef.current = undefined;
            setStatus((s) => (s === "error" ? s : "off"));
          },
          onerror: (e) => {
            setError(e.message ?? "voice session error");
            setStatus("error");
          },
          onmessage: (message) => {
            // Spoken audio out — modelTurn parts carry 24kHz PCM inline data.
            const parts = message.serverContent?.modelTurn?.parts ?? [];
            for (const part of parts) {
              const data = part.inlineData?.data;
              if (data) playerRef.current?.push(data);
            }
            if (message.serverContent?.interrupted) playerRef.current?.reset();

            // Transcripts for the on-screen readout.
            const inputText = message.serverContent?.inputTranscription?.text;
            const outputText = message.serverContent?.outputTranscription?.text;
            if (inputText) {
              setPartials((p) => ({ ...p, you: p.you + inputText }));
            }
            if (outputText) {
              setPartials((p) => ({ ...p, gemini: p.gemini + outputText }));
            }
            if (message.serverContent?.turnComplete) {
              setPartials((p) => {
                const done: VoiceLine[] = [];
                if (p.you) done.push({ role: "you", text: p.you });
                if (p.gemini) done.push({ role: "gemini", text: p.gemini });
                if (done.length) {
                  setLines((prev) => [...prev, ...done].slice(-MAX_LINES));
                }
                return { you: "", gemini: "" };
              });
            }

            // Tool calls -> deterministic execution -> sendToolResponse.
            const calls = message.toolCall?.functionCalls ?? [];
            if (calls.length && sessionRef.current) {
              const session = sessionRef.current;
              void (async () => {
                const functionResponses = [];
                for (const call of calls) {
                  const name = call.name ?? "";
                  const result = await executeVoiceTool(
                    name,
                    (call.args ?? {}) as Record<string, unknown>,
                    optsRef.current.actions,
                  );
                  functionResponses.push({
                    id: call.id ?? "",
                    name,
                    response: result as Record<string, unknown>,
                  });
                }
                try {
                  session.sendToolResponse({ functionResponses });
                } catch {
                  // Session closed mid-dispatch.
                }
              })();
            }
          },
        },
      });
      sessionRef.current = session;

      // Mic + playback start once the socket is open.
      playerRef.current = createPlayer();
      stopMicRef.current = await startMic((b64) => {
        try {
          session.sendRealtimeInput({
            audio: { data: b64, mimeType: "audio/pcm;rate=16000" },
          });
        } catch {
          // Closed between chunks.
        }
      });
      pushContext();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
      stop();
    }
  }, [pushContext, stop]);

  // Full teardown on unmount.
  useEffect(() => stop, [stop]);

  return {
    status,
    speaking: partials.gemini.length > 0,
    error,
    lines: [
      ...lines,
      ...(partials.you ? [{ role: "you" as const, text: partials.you }] : []),
      ...(partials.gemini
        ? [{ role: "gemini" as const, text: partials.gemini }]
        : []),
    ],
    start,
    stop,
    pushContext,
  };
}
