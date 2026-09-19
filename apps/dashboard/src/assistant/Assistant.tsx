/**
 * Gemini NL query bar (spec §19 UI). Sends the question to the collector's
 * /v1/assistant route, which lazy-loads packages/gemini.
 */
import { useState } from "react";
import { askAssistant, type AssistantResponse } from "../lib/api";

interface Props {
  traceId?: string;
}

export function Assistant({ traceId }: Props) {
  const [question, setQuestion] = useState("");
  const [response, setResponse] = useState<AssistantResponse>();
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!question.trim() || !traceId) return;
    setBusy(true);
    setResponse(undefined);
    try {
      setResponse(await askAssistant(question, traceId));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {response !== undefined && (
        <div className="assistant-answer">
          {response.answer}
          {response.functionsCalled.length > 0 && (
            <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 4 }}>
              functions: {response.functionsCalled.join(", ")}
            </div>
          )}
        </div>
      )}
      <div className="assistant-bar">
        <span style={{ color: "var(--muted)" }}>Ask AgentTrace:</span>
        <input
          value={question}
          placeholder={traceId ? "Why was this run slow?" : "start a trace first"}
          disabled={!traceId || busy}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </div>
    </>
  );
}
