/**
 * Gemini NL interface (spec §19). Gemini sits AFTER the deterministic
 * analysis layer — it picks functions, we execute them, it explains.
 * Its explanations never enter the canonical trace.
 *
 * Without GEMINI_API_KEY, ask() delegates to the deterministic mockAsk
 * (mock.ts) so the assistant endpoint never 501s during a demo.
 *
 * TODO(track-3): add tests against recorded Gemini responses.
 */
import { GoogleGenAI, type Content, type Part } from "@google/genai";
import { traceToolDeclarations } from "./tools.js";
import { executeTraceFunction } from "./query.js";
import { redactValue } from "./redact.js";
import { mockAsk } from "./mock.js";

const MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
const MAX_TOOL_ROUNDS = 6;

const SYSTEM_PROMPT = `You are the query interface for AgentTrace, an observability tool for multi-agent systems.
Answer questions about a single execution trace using ONLY the provided functions.
Numbers, entities and events you report must come from function results — never invent them.
When you infer something beyond the raw data, label it clearly as inference.
Keep answers short and specific.`;

export interface AssistantAnswer {
  answer: string;
  functionsCalled: string[];
}

/** Gemini's Type enum is uppercase ("STRING"); JSON Schema wants lowercase. */
function toJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toJsonSchema);
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(
    Object.entries(schema).map(([k, v]) => [
      k,
      k === "type" && typeof v === "string" ? v.toLowerCase() : toJsonSchema(v),
    ]),
  );
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

/** Same function-calling loop over OpenRouter's OpenAI-compatible API. */
async function askOpenRouter(
  question: string,
  traceId: string,
  apiKey: string,
): Promise<AssistantAnswer> {
  const model = process.env.OPENROUTER_MODEL ?? "deepseek/deepseek-v4.1-flash";
  const tools = traceToolDeclarations.map((d) => ({
    type: "function",
    function: { name: d.name, description: d.description, parameters: toJsonSchema(d.parameters) },
  }));
  const messages: OpenAIMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Trace ID: ${traceId}\n\nQuestion: ${question}` },
  ];
  const functionsCalled: string[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages, tools }),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { choices: { message: OpenAIMessage }[] };
    const message = data.choices[0]!.message;
    if (!message.tool_calls?.length) {
      return { answer: message.content ?? "(no answer)", functionsCalled };
    }

    // Record the model's turn, then answer every function call.
    messages.push(message);
    for (const call of message.tool_calls) {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(call.function.arguments || "{}");
      } catch {
        // Malformed args: run with traceId only rather than abort the answer.
      }
      const name = call.function.name;
      if (!functionsCalled.includes(name)) functionsCalled.push(name);
      // App controls traceId: the model must not redirect to another trace.
      const result = await executeTraceFunction(name, { ...parsed, traceId });
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(redactValue(result)) });
    }
  }

  return { answer: "(query round limit reached)", functionsCalled };
}

export async function ask(
  question: string,
  traceId: string,
): Promise<AssistantAnswer> {
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (openRouterKey) {
    try {
      return await askOpenRouter(question, traceId, openRouterKey);
    } catch (err) {
      // Same contract as the Gemini path: never 501, fall back to the mock.
      console.warn("[assistant] OpenRouter failed, using mock:", err);
      return mockAsk(question, traceId);
    }
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return mockAsk(question, traceId);

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
  const functionsCalled: string[] = [];
  let lastText: string | undefined;

  try {
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
    if (response.text) lastText = response.text;
    if (calls.length === 0) {
      return { answer: response.text ?? "(no answer)", functionsCalled };
    }

    // Record the model's turn, then answer every function call in parallel.
    contents.push({
      role: "model",
      parts: response.candidates?.[0]?.content?.parts ?? [],
    });

    const responseParts = await Promise.all(
      calls.map(async (call): Promise<Part> => {
        const name = call.name ?? "";
        if (name && !functionsCalled.includes(name)) functionsCalled.push(name);
        // The app controls traceId: spread model args first, then force ours —
        // the model must not redirect queries to a different trace.
        const args = { ...(call.args ?? {}), traceId } as Record<
          string,
          unknown
        >;
        const result = await executeTraceFunction(name, args);
        return {
          functionResponse: {
            name: call.name,
            response: { result: redactValue(result) },
          },
        };
      }),
    );
    contents.push({ role: "user", parts: responseParts });
  }
  } catch {
    // Any model-side failure (bad key, quota, malformed decls) falls back to
    // the deterministic mock — the assistant endpoint must not 501 on it.
    return mockAsk(question, traceId);
  }

  return {
    answer: lastText ?? "(query round limit reached)",
    functionsCalled,
  };
}
