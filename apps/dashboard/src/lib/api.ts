/** REST helpers for the collector API. */

export async function askAssistant(
  question: string,
  traceId: string,
): Promise<string> {
  const res = await fetch("/v1/assistant", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question, traceId }),
  });
  const body = (await res.json()) as { answer?: string; error?: string };
  if (!res.ok) return `assistant error: ${body.error ?? res.status}`;
  return body.answer ?? "(empty answer)";
}
