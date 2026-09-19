/**
 * Gemini NL query bar (spec §19 UI). The answer panel shows which
 * deterministic query functions were called, so the viewer can see that the
 * explanation came from observed data — the model never touches the trace.
 */
import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { askAssistant, type AssistantResult } from "../lib/api";

interface Props {
  traceId?: string;
}

const SUGGESTIONS = [
  "Why did this run fail?",
  "Which agents worked in parallel?",
  "What was the slowest tool call?",
];

export function Assistant({ traceId }: Props) {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AssistantResult>();
  const [asked, setAsked] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || !traceId || busy) return;
    setBusy(true);
    setAsked(trimmed);
    setQuestion(""); // The asked question moves into the answer panel.
    setResult(undefined);
    try {
      setResult(await askAssistant(trimmed, traceId));
    } catch (err) {
      setResult({ answer: "", error: String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="assistant">
      {(busy || result) && (
        <div className="assistant-answer">
          <div className="assistant-question">{asked}</div>
          {busy && (
            <div className="assistant-loading">
              <span className="spinner" /> querying deterministic trace
              functions…
            </div>
          )}
          {result?.error && (
            <div className="assistant-error">{result.error}</div>
          )}
          {result?.answer && (
            <div className="assistant-text markdown">
              <Markdown remarkPlugins={[remarkGfm]}>{result.answer}</Markdown>
            </div>
          )}
          {result?.functionsCalled && result.functionsCalled.length > 0 && (
            <div className="assistant-provenance">
              <span className="hint">answered from</span>
              {result.functionsCalled.map((fn) => (
                <span className="fn-chip" key={fn}>
                  {fn}()
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="assistant-bar">
        <span className="assistant-prefix">Ask AgentTrace:</span>
        <input
          value={question}
          placeholder={
            traceId ? "Why was this run slow?" : "load or replay a trace first"
          }
          disabled={!traceId || busy}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit(question)}
        />
        <button
          className="primary"
          disabled={!traceId || busy || !question.trim()}
          onClick={() => submit(question)}
        >
          {busy ? "asking…" : "ask"}
        </button>
        <div className="assistant-suggestions">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              className="chip"
              disabled={!traceId || busy}
              onClick={() => void submit(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
