# AgentTrace

Local observability for multi-agent systems — "Wireshark / distributed tracing
for AI agents". Hackathon MVP. Full design: `tech spec.md`. Work split:
`PLAN.md` (3 parallel tracks; check the contract table before changing shared
files).

## Stack

100% TypeScript (strict, ESM). npm workspaces, no build step — `tsx` runs TS
directly. Internal packages resolve via `exports: "./src/index.ts"`.

| Path | Package | What |
|---|---|---|
| `packages/protocol` | `@agenttrace/protocol` | Canonical `TraceEvent`, zod validation, deterministic `TraceState` reducer, fixtures. **The contract — changes here affect everyone.** |
| `packages/collector` | `@agenttrace/collector` | Fastify ingest + WS broadcast + event store + deterministic analysis |
| `packages/adapters` | `@agenttrace/adapters` | A2A proxy, Codex/Claude hook mappers, `agenttrace-ingest` CLI |
| `packages/gemini` | `@agenttrace/gemini` | Gemini function-calling NL interface + redaction |
| `apps/dashboard` | `@agenttrace/dashboard` | Vite + React + @xyflow/react UI |
| `demo/multi-agent-example` | `@agenttrace/demo` | 3-agent demo (spec §25) |

## Commands

```bash
npm install                 # everything, from repo root
npm run typecheck           # all workspaces — run before committing
npm run check -w @agenttrace/collector   # backend self-check vs fixture
npm run dev:collector       # collector :8787
npm run dev:dashboard       # dashboard :5173 (proxies /v1 incl. WS)
npm run dev:a2a-proxy       # single A2A proxy :8800
npm run demo                # spawns 2 agents + 2 proxies + coordinator
```

Env: copy `.env.example` → `.env`. `GEMINI_API_KEY` enables the assistant;
unset = `/v1/assistant` returns 501 and everything else still works.

## Invariants — do not break

1. **Adapters own provider semantics.** No `if (provider === "codex")` outside
   `packages/adapters` (spec §32).
2. **Observed facts only.** Never fabricate events/edges/messages to fill
   observability gaps; render unavailable regions as unavailable (§3, §4).
3. **No LLM in the ingest → persist → metrics path** (§13). Gemini only reads
   the deterministic query API and its output never enters the trace.
4. **Determinism.** Same ordered `TraceEvent[]` → identical `TraceState`,
   metrics, failure report (§23). The frontend renders `TraceState`; it does
   not reinterpret provider data.
5. Correlation uses explicit IDs only (task ID → call ID → turn ID → agent ID
   → session ID), never semantic similarity (§8).

## Contract (frozen)

- `POST /v1/events` `{event}` → 202; `WS /v1/live` → `{kind:"event"|"reset"}`;
  `GET /v1/traces[/:id]` → `{events, state}`
- Query endpoints → `runQuery()` names → Gemini function declarations
  (`packages/gemini/src/tools.ts`) — all three must stay in sync
- Ports: collector 8787, dashboard 5173, proxies 8800/8801, demo 9101/9102
- `POST /v1/dev/seed[?realtime=1]` replays the fixture as a fresh trace
  through real ingest (no adapters needed). Ingest dedupes by `eventId`.
- Fixture for offline dev: `demoTraceEvents` in
  `packages/protocol/src/fixtures/demo-trace.ts` (dashboard "fixture" button)

## Conventions

- `TODO(track-N)` comments mark planned work per `PLAN.md` tracks
- Validation lives in `packages/protocol/src/validation.ts` (zod); keep it in
  sync with `trace-event.ts`
- Hook/adapters must be best-effort: never crash or block the host framework
- Don't commit secrets; `.env` is gitignored
