/**
 * Gemini NL query bar (spec §19 UI). Sends the question to the collector's
 * /v1/assistant route, which lazy-loads packages/gemini.
 */
import { useState } from "react";
import { askAssistant } from "../lib/api";

interface Props {
  traceId?: string;
}

export function Assistant({ traceId }: Props) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!question.trim() || !traceId) return;
    setBusy(true);
    setAnswer(undefined);
    try {
      setAnswer(await askAssistant(question, traceId));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {answer !== undefined && <div className="assistant-answer">{answer}</div>}
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
