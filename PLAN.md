# AgentTrace — Implementation Plan

One-day hackathon build, 3 parallel tracks. The contract below is **frozen in
the boilerplate** — build against it, don't redesign it. If a track needs a
contract change, flag it in the group chat before changing shared files.

## The contract (already implemented — do not break)

| Thing | Where |
|---|---|
| `TraceEvent` schema + `TraceState` reducer | `packages/protocol/src/` |
| Demo fixture (14 events, spec §25 scenario) | `packages/protocol/src/fixtures/demo-trace.ts` |
| Ingest: `POST /v1/events` `{event}` → 202 | `packages/collector/src/server.ts` |
| Live stream: `WS /v1/live` → `{kind:"event",event}` / `{kind:"reset"}` | `packages/collector/src/websocket.ts` |
| Reads: `GET /v1/traces`, `GET /v1/traces/:id` → `{events, state}` | server.ts |
| Deterministic queries: `summary`, `agents/:id/activity`, `tools`, `failures`, `critical-path`, `concurrency`, `duplicates`, `events?from&to` / `?before&count` (unknown trace → 404) | server.ts + `analysis/queries.ts` |
| Dev seed: `POST /v1/dev/seed[?realtime=1]` → fresh trace from the fixture via real ingest (broadcasts `reset` first) | server.ts |
| Assistant: `POST /v1/assistant` `{question, traceId}` → `{answer}` | server.ts (lazy-loads `@agenttrace/gemini`) |
| Gemini function names = `runQuery` names = REST paths | `packages/gemini/src/tools.ts` ↔ `query.ts` |

**Ports:** collector `:8787` · dashboard `:5173` (proxies `/v1` incl. WS) ·
A2A proxies `:8800`/`:8801` · demo agents `:9101`/`:9102`.

**Rules for everyone:**
- Provider semantics stop at adapters. No `if (provider === "codex")` outside
  `packages/adapters` (spec §32).
- Only observed facts enter the trace. Never fabricate edges/messages to fill
  gaps (spec §3, §4).
- No LLM in the ingest → metrics path (spec §13).

---

## Track 1 — Core backend: reducer, collector, analytics

**Owns:** `packages/protocol/`, `packages/collector/`
**Goal:** correct, deterministic TraceState + all query endpoints return real data.

- [x] Verify reducer edge cases: spans pairing via `correlationId`, unpaired
      `tool_call` stays `started`, out-of-order events sort correctly
      (`packages/protocol/src/reducer.ts`)
- [x] Real critical path over the span DAG (replace top-N stub in
      `analysis/timings.ts` — parent/child via `correlationId`/`parentEventId`)
- [x] Concurrency metrics: max concurrent agents, overlapping spans, idle gaps
      (spec §14) — extend `TraceMetrics`
- [x] `payload` truncation / size guard on ingest; JSONL persistence check
      (`AGENTTRACE_DATA_DIR`)
- [x] Seed route for dev: `POST /v1/dev/seed` replays the fixture through real
      ingest (unblocks Track 2/3 testing without adapters)

**Done when:** fixture POSTed through ingest → dashboard shows correct
graph/timeline; `GET /v1/traces/:id/failures` names the shell failure;
same event stream → identical `TraceState` twice.

## Track 2 — Frontend dashboard

**Owns:** `apps/dashboard/`
**Goal:** the screen in spec §15, live. Work against the **fixture button**
until Track 1/3 deliver real streams — never block.

- [ ] Graph: real layered layout (add `dagre` or hand-roll better BFS layout),
      node status colors (active/failed/idle), edge animation for `started`
- [ ] Visibility rendering (spec §16): `lifecycle_only` edges dashed,
      unobservable regions shown as a distinct "?" boundary — never imply
      message visibility that wasn't captured
- [ ] Timeline: time-axis ticks, ms labels, agent→tool row grouping
- [ ] Inspector: related events (same `correlationId`), copy-paste payload,
      jump-to-related-event links
- [ ] Trace picker header (`GET /v1/traces` dropdown), reconnect/backoff on WS
- [ ] Assistant bar polish: loading state, show which functions Gemini called
      (return them in `/v1/assistant` response — coordinate w/ Track 3)

**Done when:** fixture mode renders the spec §15 screen; live mode animates
edges as demo events arrive; every spec §30 UI criterion visible.

## Track 3 — Integrations: A2A proxy, Codex hooks, Gemini, demo

**Owns:** `packages/adapters/`, `packages/gemini/`, `demo/`
**Goal:** real events flowing end-to-end + the "Why did this run fail?" moment.

- [ ] Verify Codex hook field names against a real payload — every name in
      `codex/hook.ts` is a guess; capture one real hook JSON first, fix the
      mapper, then write the hook config snippet for the demo
- [ ] A2A proxy: emit `task created/status changed/artifact_created` from
      `result.status`/`result.artifacts`; SSE pass-through if the demo uses
      streaming (spec §9)
- [ ] Run `demo/run-demo.ts` end-to-end; tune delays so the timeline tells the
      §25 story (parallel agents, shell failure at ~1.9s)
- [ ] Gemini `ask()`: verify function-call round-trip works with
      `GEMINI_API_KEY`; app-side validation of structured output (spec §19);
      return `functionsCalled` in the assistant response for Track 2
- [ ] Redaction pass on query results before they hit Gemini (`redact.ts`)
- [ ] Optional: Claude adapter (`claude/hook.ts`) — only if ahead of schedule

**Done when:** `npm run demo` produces a live trace in the dashboard (2
proxied agents + self-reported tool calls + a failure); asking "why did the
run fail?" answers with the shell failure from deterministic data; a real
Codex session feeds the same dashboard.

---

## Integration checkpoints

| When | What |
|---|---|
| T+0 | Everyone: `npm install`, `npm run typecheck`. Track 2 clicks "fixture" — sees the whole UI. |
| ~2h | Track 1: collector accepts real posts → Track 3 starts emitting through it; Track 2 switches fixture→live |
| ~4h | Track 3: `run-demo` works end-to-end → combined live demo rehearsal |
| ~5h | Gemini wired → Track 2 shows function-call provenance |
| Last hour | Freeze, demo run-through, failure talk-track ("why did this fail?" query live) |

## Risk cuts (drop these if behind)

1. Real Codex hook capture → keep the mapper, feed recorded JSON via
   `echo '{...}' | npm run ingest:codex -w @agenttrace/adapters`
2. SSE streaming in proxy → request/response only
3. Critical-path DAG → keep top-N spans, say so in demo
4. Claude adapter → skip entirely
5. JSONL persistence → memory-only

## Demo script target (spec §25/§30)

1. `npm run dev:collector` + `npm run dev:dashboard` + `npm run demo`
2. Graph animates: Coordinator → {Researcher, Reviewer} in parallel
3. Timeline shows the shell span going red at ~1.9s
4. Click the failed span → inspector shows `exit code 1` payload
5. Ask: "Why did this run fail?" → Gemini calls `getFailures`, explains
   deterministically-derived answer
6. Ask: "Which agents worked in parallel?" → overlap from timestamps
7. Callout: "everything you just saw is observed data — Gemini only explains"
