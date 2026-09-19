/**
 * Gemini NL interface (spec §19). Gemini sits AFTER the deterministic
 * analysis layer — it picks functions, we execute them, it explains.
 * Its explanations never enter the canonical trace.
 *
 * TODO(track-3): validate structured output app-side (spec recommends
 * semantic validation even with schema-constrained output), tighten the
 * function-call loop, add tests against recorded responses.
 */
import { GoogleGenAI, type Content, type Part } from "@google/genai";
import { traceToolDeclarations } from "./tools.js";
import { executeTraceFunction } from "./query.js";
import { redactValue } from "./redact.js";

const MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
const MAX_TOOL_ROUNDS = 6;

const SYSTEM_PROMPT = `You are the query interface for AgentTrace, an observability tool for multi-agent systems.
Answer questions about a single execution trace using ONLY the provided functions.
Numbers, entities and events you report must come from function results — never invent them.
When you infer something beyond the raw data, label it clearly as inference.
Keep answers short and specific.`;

export async function ask(question: string, traceId: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const ai = new GoogleGenAI({ apiKey });
  const contents: Content[] = [
    {
      role: "user",
      parts: [
        {
          text: `Trace ID: ${traceId}\n\nQuestion: ${question}`,
        },
      ],
    },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        tools: [{ functionDeclarations: traceToolDeclarations }],
      },
    });

    const calls = response.functionCalls ?? [];
    if (calls.length === 0) {
      return response.text ?? "(no answer)";
    }

    // Record the model's turn, then answer every function call.
    contents.push({ role: "model", parts: response.candidates?.[0]?.content?.parts ?? [] });

    const responseParts: Part[] = [];
    for (const call of calls) {
      const args = { traceId, ...(call.args ?? {}) } as Record<string, unknown>;
      const result = await executeTraceFunction(call.name ?? "", args);
      responseParts.push({
        functionResponse: {
          name: call.name,
          response: { result: redactValue(result) },
        },
      });
    }
    contents.push({ role: "user", parts: responseParts });
  }

  return "(query round limit reached)";
}
