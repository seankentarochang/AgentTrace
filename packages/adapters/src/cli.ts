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
 * Raw payloads are dumped to <dir>/<adapter>-<timestamp>-<rand>.json so the
 * mappers can be verified against real payloads. Default dir is
 * demo/hook-dumps/; override with --dump=<dir> or AGENTTRACE_HOOK_DUMP,
 * disable with --dump=off.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { mapCodexHook } from "./codex/hook.js";
import { mapClaudeHook } from "./claude/hook.js";
import { emitEvent } from "./emit.js";

const adapter = process.argv.slice(2).find((a) => !a.startsWith("--"));
const defaultDumpDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../demo/hook-dumps",
);
const dumpFlag = process.argv.find((a) => a.startsWith("--dump="));
const dumpTarget =
  dumpFlag?.slice("--dump=".length) ??
  process.env.AGENTTRACE_HOOK_DUMP ??
  defaultDumpDir;
const dumpDir = dumpTarget === "off" ? undefined : dumpTarget;

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
