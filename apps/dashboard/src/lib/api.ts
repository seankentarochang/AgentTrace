/** REST helpers for the collector API. */

export interface AssistantResponse {
  answer: string;
  functionsCalled: string[];
}

export async function askAssistant(
  question: string,
  traceId: string,
): Promise<AssistantResponse> {
  const res = await fetch("/v1/assistant", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question, traceId }),
  });
  const body = (await res.json()) as {
    answer?: string;
    functionsCalled?: string[];
    error?: string;
  };
  if (!res.ok) {
    return {
      answer: `assistant error: ${body.error ?? res.status}`,
      functionsCalled: [],
    };
  }
  return {
    answer: body.answer ?? "(empty answer)",
    functionsCalled: body.functionsCalled ?? [],
  };
}
