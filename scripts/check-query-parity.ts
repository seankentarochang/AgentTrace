/**
 * Name-parity + redaction check (PLAN-integrations Phase 2).
 *
 * The contract says REST paths -> runQuery() names -> Gemini function
 * declarations must stay in sync; drift here is a silent bug. This script
 * fails loudly instead. Run: npm run check:parity
 *
 * Also smoke-tests redact.ts denylist keys + secret regexes.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  pathFor,
  redactValue,
  traceToolDeclarations,
  validateArgs,
} from "@agenttrace/gemini";
import { createTraceState } from "@agenttrace/protocol";
// No package export on the collector — relative import, tsx resolves .ts.
import { runQuery } from "../packages/collector/src/analysis/queries.js";

const here = dirname(fileURLToPath(import.meta.url));

const declared = traceToolDeclarations.map((d) => d.name).filter(Boolean) as string[];
assert.ok(declared.length > 0, "no function declarations found");

const state = createTraceState("parity_trace");
const validArgs: Record<string, Record<string, unknown>> = {
  getTraceSummary: {},
  getAgentActivity: { agentId: "agent_x" },
  getToolCalls: {},
  getFailures: {},
  getCriticalPath: {},
  getEventsBetween: { start: "2026-01-01T00:00:00Z", end: "2026-01-01T01:00:00Z" },
  getEventsBefore: { eventId: "evt_1" },
  getExactDuplicateCalls: {},
};

// 1. Every declared name resolves through pathFor, validateArgs, runQuery.
for (const name of declared) {
  const args = { traceId: "parity_trace", ...(validArgs[name] ?? {}) };
  const validated = validateArgs(name, args);
  assert.ok(validated.ok, `validateArgs rejects declared name ${name}: ${JSON.stringify(validated)}`);
  assert.doesNotThrow(() => pathFor(name, validated.args), `pathFor throws on ${name}`);
  assert.doesNotThrow(
    () => runQuery(name, validated.args, state),
    `runQuery throws on declared name ${name}`,
  );
}

// 2. Reverse: every case label inside runQuery's switch is declared.
const queriesSrc = readFileSync(
  resolve(here, "../packages/collector/src/analysis/queries.ts"),
  "utf8",
);
const runQueryBody = queriesSrc.slice(queriesSrc.indexOf("export function runQuery"));
const runQueryNames = [...runQueryBody.matchAll(/case "([^"]+)":/g)].map((m) => m[1]);
assert.deepEqual(
  [...runQueryNames].sort(),
  [...declared].sort(),
  `name drift: runQuery has ${JSON.stringify(runQueryNames.sort())}, tools.ts declares ${JSON.stringify(declared.sort())}`,
);

// 3. Every pathFor() output matches a real route registered in server.ts —
// a renamed route would otherwise pass name parity while calls 404.
const serverSrc = readFileSync(
  resolve(here, "../packages/collector/src/server.ts"),
  "utf8",
);
const routePatterns = [...serverSrc.matchAll(/app\.get\("([^"]+)"/g)]
  .map((m) => m[1])
  .filter((p) => p.startsWith("/v1/traces/"));
const routeToRegex = (route: string) =>
  new RegExp(`^${route.replace(/:[^/]+/g, "[^/?]+")}$`);
for (const name of declared) {
  const args = { traceId: "parity_trace", ...(validArgs[name] ?? {}) };
  const path = pathFor(name, validateArgs(name, args).args as Record<string, unknown>);
  const [pathname] = path.split("?");
  const matched = routePatterns.some((route) => routeToRegex(route).test(pathname));
  assert.ok(
    matched,
    `pathFor(${name}) -> ${path} matches no route in server.ts (${routePatterns.join(", ")})`,
  );
}

// 4. Unknown names are rejected everywhere.
assert.equal(validateArgs("bogusFn", { traceId: "x" }).ok, false);
assert.throws(() => pathFor("bogusFn", { traceId: "x" }));
assert.throws(() => runQuery("bogusFn", {}, state));

// 5. Redaction: denylist keys + bearer/private-key/API-key regexes.
const scrubbed = redactValue({
  nested: {
    authorization: "Bearer abc123",
    api_key: "sk-ABCDEFGHIJKLMNOP1234",
    note: "call me",
    text: "token: Bearer abcdef1234567890",
    pem: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
    keep: "harmless value",
  },
}) as { nested: Record<string, unknown> };
assert.equal(scrubbed.nested.authorization, "[REDACTED]");
assert.equal(scrubbed.nested.api_key, "[REDACTED]");
assert.match(String(scrubbed.nested.text), /\[REDACTED\]/);
assert.match(String(scrubbed.nested.pem), /\[REDACTED\]/);
assert.equal(scrubbed.nested.keep, "harmless value");

console.log(`parity ok — ${declared.length} functions in sync; redaction ok`);
