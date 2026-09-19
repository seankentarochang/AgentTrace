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
 *
 * Pass --dump=<dir> or set AGENTTRACE_HOOK_DUMP to also write every raw
 * payload to <dir>/<adapter>-<timestamp>-<rand>.json — use it to capture
 * real payloads for fixing the mapper field names.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { mapCodexHook } from "./codex/hook.js";
import { mapClaudeHook } from "./claude/hook.js";
import { emitEvent } from "./emit.js";

const adapter = process.argv[2];
const dumpFlag = process.argv.find((a) => a.startsWith("--dump="));
const dumpDir = dumpFlag?.slice("--dump=".length) ?? process.env.AGENTTRACE_HOOK_DUMP;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function dumpRaw(raw: string): void {
  if (!dumpDir) return;
  try {
    mkdirSync(dumpDir, { recursive: true });
    const name = `${adapter ?? "unknown"}-${Date.now()}-${randomBytes(3).toString("hex")}.json`;
    writeFileSync(join(dumpDir, name), raw);
  } catch {
    // Dumping is diagnostic only — never block the hook.
  }
}

async function main(): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) return;
  dumpRaw(raw);

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
