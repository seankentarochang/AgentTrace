# Track 3 — Integrations: implementation plan

**Owns:** `packages/adapters/`, `packages/gemini/`, `demo/`
**Goal:** real events flowing end-to-end + the "why did this run fail?" Gemini moment.

**Ordering rule:** everything needing `GEMINI_API_KEY` or live Codex/Claude
sessions is deferred to Phase 3. Phases 1–2 need zero external access.

Three independent sub-streams — **can run in parallel** if multiple people
land on this track, or sequentially in the order A → B → C:

| Stream | Scope | Needs |
|---|---|---|
| **A — A2A + demo** | proxy lifecycle events, demo hardening | nothing (works today) |
| **B — Gemini module** | function dispatch, mock mode, redaction | collector endpoints only (already exist) |
| **C — Framework hooks** | capture, mappers, live feed | docs only until Phase 3 |

**Shared touchpoint (coordinate, don't redesign):** if `/v1/assistant`
response grows a `functionsCalled` field, tell Track 2 — they render it.
`TraceEvent` schema is frozen; adapters translate, never extend.

---

## Phase 1 — A2A proxy + demo (stream A)

`packages/adapters/src/a2a/proxy.ts`, `demo/multi-agent-example/`

- [ ] Emit `status_change` events from `result.status.state`
      (submitted → working → completed/failed) using the task's
      `correlationId` — currently only request/response messages are emitted
- [ ] Emit `artifact_created` per `result.artifacts[]` entry
      (`category: "artifact"`, artifact payload in `payload`)
- [ ] Pass through non-2xx upstreams without emitting fabricated task
      states — record `httpStatus` + `status: "failure"` only
- [ ] SSE streaming (only if demo uses `message/stream`; otherwise cut it —
      it's the biggest single item here)
- [ ] `run-demo.ts`: reuse a second coordinator run on the same trace, or a
      `--repeat` flag, for live demo resilience
- [ ] Tune agent delays so the timeline reads like §25: parallel spans,
      shell failure landing ~1.9s
- [ ] Windows gotcha: document that demo children must be stopped via
      Ctrl+C in the run terminal (orphans hold ports 8800/8801/9101/9102)

**Done when:** `npm run demo` yields one trace showing message → status
changes → artifacts → tool spans → failure, matching §25's beat sheet.

## Phase 2 — Gemini module, offline (stream B)

`packages/gemini/` — build and test everything *without* a key.

- [ ] `src/mock.ts`: deterministic `ask()` fallback when `GEMINI_API_KEY`
      is unset — rule-based dispatch over `executeTraceFunction` for the
      3–4 demo questions ("why fail", "why slow", "what ran in parallel",
      "what happened before X"). This is the demo safety net AND the dev
      harness — judges never see a 501.
- [ ] Unit-test `runQuery` ↔ `pathFor` ↔ `tools.ts` name parity (the three
      name tables must match — a drift bug here is silent)
- [ ] `redact.ts`: test denylist keys + token regexes against a payload
      containing fake secrets
- [ ] `chat.ts`: tighten the function-call loop (parallel calls per round,
      max-rounds guard, empty-response handling); return
      `{ answer, functionsCalled }` instead of bare string — **flag the
      response-shape change to Track 2**
- [ ] App-side validation of Gemini's structured args before executing
      (spec §19 explicitly requires semantic validation even with
      schema-constrained output)

**Done when:** `POST /v1/assistant` answers the demo questions correctly
with no key set (mock path), and the same code path is verified ready to
swap to live Gemini.

## Phase 3 — API keys + live frameworks (stream C)

`packages/adapters/src/{codex,claude}/`, `demo/` — everything needing
`GEMINI_API_KEY` or real Codex/Claude sessions. Both CLIs are installed
locally (`codex-cli 0.155.0`, `claude 2.1.214`).

- [ ] **Capture (do this first, it's ~15 min):** register a hook command in
      the tool's config pointing at `agenttrace-ingest` with
      `AGENTTRACE_HOOK_DUMP=<dir>` set — every raw payload lands in
      `dumps/`. Verify codex-cli 0.155's hook config schema from its docs
      (guess: `~/.codex/config.toml`; Claude Code uses
      `~/.claude/settings.json` `hooks` — documented format)
- [ ] Fix `codex/hook.ts` field names against dumped payloads — every name
      in there is a guess (`hook_event_name`, `tool.call_id`, `turn_id`…)
- [ ] Map only documented fields; unknown hooks → `[]` (already correct)
- [ ] Run one real Codex session with hooks live → events appear in the
      dashboard alongside a demo trace = §30 #7 satisfied
- [ ] `claude/hook.ts`: same pattern (fields: `hook_event_name`,
      `tool_name`, `tool_input`, `session_id`, `transcript_path` — verify
      against dumps too)
- [ ] Live Gemini: set `GEMINI_API_KEY`, verify `ask()` function-call
      round-trip, check `functionsCalled` reaches the UI, sanity-check
      redaction on real query results
- [ ] Pick the demo story: one framework feeding live is required; two
      (Codex + Claude in one trace) is the flex — only if capture went
      smoothly

**Done when:** a real framework session feeds the dashboard live, and
"why did this run fail?" is answered through the real Gemini path.

## Parallelization map

```
Phase 1 (A) ────────────────┐
Phase 2 (B) ────────────────┤── independent: files never overlap
Phase 3 (C) ────────────────┘    except Phase-3 capture enables C's mappers

Within C: codex capture ─┐
          claude capture ─┴── identical pattern, do in parallel

Cross-track: B's mock assistant ──→ Track 2 renders functionsCalled
             A's demo ──→ needs Track 1's /v1/events (already done)
```

If only one person: do A → B → C-capture early anyway (capture is cheap and
it's the only step whose failure changes the demo plan — knowing early
whether hooks emit is worth 15 minutes, even if mapper fixes wait).

## Cut list if behind

1. SSE streaming → request/response only
2. Claude adapter → skip, Codex alone satisfies §30 #7
3. Live Gemini → mock `ask()` already answers demo questions credibly
4. Live Codex session → replay a dumped payload via `echo | agenttrace-ingest codex`, label it "recorded"
