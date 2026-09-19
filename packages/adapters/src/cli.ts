#!/usr/bin/env node
/**
 * Hook ingestion entrypoint. Agent frameworks call this binary from their
 * lifecycle hooks:
 *
 *   agenttrace-ingest codex   < hook payload on stdin
 *   agenttrace-ingest claude  < hook payload on stdin
 *
 * Reads the raw hook JSON from stdin, normalizes to TraceEvent(s), and
 * forwards them to the collector. Must exit 0 even on failure so the host
 * framework is never blocked by observability.
 */
import { mapCodexHook } from "./codex/hook.js";
import { mapClaudeHook } from "./claude/hook.js";
import { emitEvent } from "./emit.js";

const adapter = process.argv[2];

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) return;

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const events =
    adapter === "codex"
      ? mapCodexHook(payload)
      : adapter === "claude"
        ? mapClaudeHook(payload)
        : [];

  await Promise.all(events.map((e) => emitEvent(e)));
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
