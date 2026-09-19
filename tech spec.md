# Agent Network Inspector

**Status:** Hackathon MVP
**Working name:** AgentTrace
**Primary goal:** Real-time observability for multi-agent systems
**Core analogy:** Wireshark / distributed tracing for AI agents
**Primary AI integration:** Gemini as a natural-language interface over captured traces

---

## 1. Problem

Modern agent systems increasingly contain multiple interacting components:

* parent agents
* subagents
* specialized agents
* MCP servers
* external tools
* shell/file operations
* APIs
* model calls

When something goes wrong, developers usually see the final answer and scattered logs but have difficulty answering:

* Which agent delegated work to which other agent?
* What information crossed that boundary?
* Which tool calls resulted from a delegation?
* Where did the system spend its time?
* Which calls failed or were retried?
* Did two agents duplicate the same work?
* What happened immediately before a failure?
* Which parts of the execution are actually observable?

Existing protocols already expose enough structured information to make much of this observable. A2A exposes messages, tasks, status updates, artifacts, context IDs and ordered streaming events. Codex exposes lifecycle hooks including tool-use and subagent events with session, turn and agent identifiers. Claude Code likewise supports hooks as deterministic lifecycle integrations and supports subagents, MCP and agent teams as extension mechanisms.

AgentTrace converts those framework-specific observations into one common execution trace.

---

# 2. Product Definition

AgentTrace is a local observability layer for agentic systems.

It ingests observable events from agent frameworks and protocols, normalizes them into a canonical event model, and displays the execution as:

1. a live agent/tool topology
2. an execution timeline
3. an event inspector
4. deterministic performance/failure metrics
5. a Gemini-powered natural-language query interface

AgentTrace does **not** attempt to expose private model reasoning.

The product observes externally visible behavior.

```text
Agent A ───────────────▶ Agent B
   │                       │
   │                       ├────▶ MCP Tool
   │                       │
   └────▶ Shell            └────▶ Agent C
```

Every observable interaction becomes an event.

---

# 3. Product Principle

## Observed facts and inferred explanations must remain separate.

The backend stores only facts that were actually captured.

Examples:

```text
OBSERVED
agent A sent message M to agent B

OBSERVED
agent B called search()

OBSERVED
search() took 1.82 seconds

OBSERVED
agent B returned artifact X
```

Gemini may later explain:

```text
"The search call appears to be the main bottleneck."
```

But that explanation never becomes part of the canonical trace.

The trace itself remains deterministic.

---

# 4. Visibility Model

Every adapter must explicitly declare how much information it can observe.

AgentTrace supports four visibility levels.

### FULL_PROTOCOL

Actual communication passes through AgentTrace.

Example:

```text
Agent A
   ↓
AgentTrace A2A Proxy
   ↓
Agent B
```

Can capture:

* full message metadata
* message contents
* sender
* receiver
* task identifiers
* artifacts
* timestamps
* responses
* errors
* lifecycle events

This provides the highest fidelity.

### STRUCTURED_EVENTS

The framework emits structured lifecycle events.

Examples:

* Codex hooks
* Claude Code hooks
* SDK event streams

Can capture whatever fields the framework exposes.

### LIFECYCLE_ONLY

The framework exposes that an agent was spawned or stopped but not every intermediate communication event.

Example:

```text
main
 │
 ├─ spawned reviewer
 │
 └─ reviewer completed
```

AgentTrace must not invent edges/messages between those known events.

### UNOBSERVABLE

The framework provides no supported interception point.

AgentTrace displays the region as unavailable.

Example:

```text
Main Agent
   │
   │ delegation observed
   ▼
Subagent
   │
   │
   ? internal activity unavailable
   │
   ▼
Final response observed
```

---

# 5. High-Level Architecture

```text
                      ┌──────────────────────┐
                      │      AgentTrace      │
                      │      Frontend        │
                      └──────────▲───────────┘
                                 │ WebSocket
                                 │
                      ┌──────────┴───────────┐
                      │    Trace Collector   │
                      │                      │
                      │ normalize            │
                      │ correlate            │
                      │ persist              │
                      │ analyze              │
                      └──────────▲───────────┘
                                 │
                 Canonical TraceEvent
                                 │
          ┌──────────────────────┼──────────────────────┐
          │                      │                      │
   ┌──────┴──────┐       ┌──────┴──────┐       ┌──────┴──────┐
   │ A2A Adapter │       │Codex Adapter│       │Claude Adapter│
   └──────▲──────┘       └──────▲──────┘       └──────▲──────┘
          │                      │                      │
      A2A traffic            hooks/events          hooks/events
```

The frontend knows nothing about Codex, Claude Code or A2A.

Only adapters understand framework-specific formats.

Everything downstream consumes `TraceEvent`.

---

# 6. Canonical Data Model

The canonical event schema is the most important architectural component.

```ts
interface TraceEvent {
  schemaVersion: 1;

  eventId: string;
  traceId: string;

  timestamp: string;
  monotonicNs?: number;

  source: EntityRef;
  destination?: EntityRef;

  category:
    | "agent"
    | "tool"
    | "model"
    | "artifact"
    | "system";

  type:
    | "session_start"
    | "session_end"
    | "agent_start"
    | "agent_stop"
    | "agent_message"
    | "tool_call"
    | "tool_result"
    | "artifact_created"
    | "status_change"
    | "error";

  correlationId?: string;
  parentEventId?: string;

  status?:
    | "started"
    | "success"
    | "failure"
    | "cancelled";

  payload?: unknown;

  durationMs?: number;

  visibility: Visibility;

  provider: ProviderMetadata;
}
```

### EntityRef

```ts
interface EntityRef {
  id: string;

  kind:
    | "agent"
    | "tool"
    | "model"
    | "external_service";

  name: string;

  subtype?: string;
}
```

Example:

```json
{
  "id": "agent-reviewer-4",
  "kind": "agent",
  "name": "reviewer",
  "subtype": "codex_subagent"
}
```

### Visibility

```ts
type Visibility =
  | "full_protocol"
  | "structured_event"
  | "lifecycle_only";
```

### Provider Metadata

```ts
interface ProviderMetadata {
  adapter:
    | "a2a"
    | "codex"
    | "claude"
    | "mcp"
    | "custom";

  rawEventType?: string;

  adapterVersion: string;
}
```

Provider-specific details should live here rather than contaminate the canonical schema.

---

# 7. Example Trace

```json
{
  "eventId": "evt_17",
  "traceId": "trace_abc",
  "timestamp": "2026-09-19T15:40:32.184Z",

  "source": {
    "id": "agent_main",
    "kind": "agent",
    "name": "Main Agent"
  },

  "destination": {
    "id": "agent_review",
    "kind": "agent",
    "name": "Reviewer"
  },

  "category": "agent",
  "type": "agent_message",

  "correlationId": "task_42",

  "payload": {
    "message": "Audit the authentication implementation."
  },

  "visibility": "full_protocol",

  "provider": {
    "adapter": "a2a",
    "adapterVersion": "0.1"
  }
}
```

Later:

```json
{
  "eventId": "evt_18",
  "traceId": "trace_abc",

  "source": {
    "id": "agent_review",
    "kind": "agent",
    "name": "Reviewer"
  },

  "destination": {
    "id": "tool_shell",
    "kind": "tool",
    "name": "Shell"
  },

  "category": "tool",
  "type": "tool_call",

  "correlationId": "tool_912",

  "payload": {
    "command": "npm test"
  },

  "visibility": "structured_event",

  "provider": {
    "adapter": "codex",
    "adapterVersion": "0.1"
  }
}
```

---

# 8. Correlation Model

AgentTrace needs to reconstruct relationships without guessing.

Correlation should use explicit identifiers where available.

Priority:

```text
protocol task ID
        ↓
tool call ID
        ↓
turn ID
        ↓
agent ID
        ↓
session ID
```

Never correlate two events based purely on semantic similarity.

For example, these can safely become one span:

```text
tool_call
call_id = 1932

        ↓

tool_result
call_id = 1932
```

But:

```text
"search authentication"
```

and

```text
"look up auth"
```

must not automatically be considered the same operation.

Gemini may suggest they appear redundant, but the canonical graph cannot assert that deterministically.

---

# 9. A2A Adapter

The A2A adapter provides the highest-fidelity demo.

A2A defines explicit messages, Tasks, status updates and artifact updates, and streaming event ordering is specified by the protocol.

AgentTrace sits as an HTTP proxy:

```text
Agent A
   │
   │ A2A
   ▼
AgentTrace Proxy
   │
   │ A2A
   ▼
Agent B
```

The proxy:

1. receives request
2. records metadata
3. forwards request unchanged
4. observes response/stream
5. emits normalized events
6. returns response unchanged

The proxy must not modify semantic behavior.

### Events generated

```text
message received
task created
task status changed
artifact emitted
task completed
task failed
```

A2A task and context IDs map directly into AgentTrace correlation fields.

---

# 10. Codex Adapter

Codex currently exposes lifecycle hooks including:

* `SessionStart`
* `SessionEnd`
* `PreToolUse`
* `PostToolUse`
* `PermissionRequest`
* `SubagentStart`
* `SubagentStop`
* `UserPromptSubmit`
* `Stop`

Its hook payloads include fields such as `session_id`, `turn_id`, tool information, agent IDs and, for subagent completion, the final assistant message and optional transcript path.

AgentTrace installs lightweight hook commands.

Example conceptual configuration:

```text
PreToolUse
      ↓
agenttrace ingest codex

PostToolUse
      ↓
agenttrace ingest codex

SubagentStart
      ↓
agenttrace ingest codex

SubagentStop
      ↓
agenttrace ingest codex
```

Each hook forwards its JSON payload to the local collector.

### Codex visibility

Reliable:

```text
session lifecycle
tool execution
tool arguments where exposed
tool results where exposed
subagent lifecycle
agent identifiers
turn identifiers
```

Not assumed:

```text
private reasoning
every internal model operation
communications not exposed through hooks/events
```

---

# 11. Claude Code Adapter

Claude Code supports external hooks as lifecycle-triggered commands and supports subagents, agent teams and MCP as extension mechanisms. Hooks run outside the conversational context and are explicitly suitable for deterministic logging/automation.

The Claude adapter follows the same pattern:

```text
Claude lifecycle event
         ↓
small hook
         ↓
AgentTrace collector
```

The adapter must map only documented fields.

If Claude exposes only:

```text
subagent started
subagent stopped
```

then AgentTrace displays only those facts.

If an internal parent/subagent message is unavailable, the graph represents the relationship without displaying fabricated message contents.

---

# 12. MCP Integration

MCP calls should eventually be intercepted independently from framework hooks.

Architecture:

```text
Agent
 │
 │ MCP
 ▼
AgentTrace MCP Proxy
 │
 │ MCP
 ▼
MCP Server
```

This creates consistent visibility regardless of the agent framework.

MCP's 2026 protocol work also standardizes W3C Trace Context propagation through metadata, allowing traces to correlate across clients, MCP servers and downstream services.

Longer term, AgentTrace should propagate:

```text
traceparent
tracestate
baggage
```

rather than creating an incompatible tracing ecosystem.

For the one-day MVP, MCP proxying is optional.

---

# 13. Collector

The collector is a local HTTP/WebSocket service.

Recommended stack:

```text
Node.js
TypeScript
Fastify
WebSocket
SQLite
```

For the hackathon version, SQLite can be replaced initially by an in-memory event store plus JSON persistence.

Endpoints:

```text
POST /v1/events
GET  /v1/traces
GET  /v1/traces/:traceId
WS   /v1/live
```

### Event ingestion

```http
POST /v1/events
```

Body:

```json
{
  "event": { "...TraceEvent" }
}
```

The collector:

```text
validate schema
     ↓
assign event ID if necessary
     ↓
persist
     ↓
update deterministic metrics
     ↓
broadcast over WebSocket
```

No LLM participates in this pipeline.

---

# 14. Deterministic Analysis Engine

AgentTrace should calculate as much as possible without Gemini.

Examples:

### Timing

```text
total trace duration
duration by agent
duration by tool
duration by span
critical-path duration
```

### Counts

```text
number of agents
number of tool calls
number of delegations
number of failures
number of retries
```

### Failure analysis

```text
first failed operation
last successful operation before failure
agent owning failed operation
tool producing failure
```

### Concurrency

Using timestamps:

```text
maximum concurrent agents
parallel tool calls
idle intervals
overlapping spans
```

### Potential duplicate activity

For MVP, only mark exact duplicates deterministically:

```text
same tool
+
canonicalized arguments
+
same trace
```

Semantic redundancy can later be Gemini-assisted and must be labelled inferred.

---

# 15. Frontend

Recommended:

```text
React
TypeScript
Vite
React Flow
```

Primary screen:

```text
┌──────────────────────────────────────────────┐
│ Trace #abc                                   │
│ 4 agents · 27 calls · 8.2s · 2 errors      │
├─────────────────────────────┬────────────────┤
│                             │                │
│       LIVE GRAPH            │ EVENT DETAILS  │
│                             │                │
│       Main                  │ tool_call      │
│      /    \                 │ search         │
│ Research  Review            │ 832 ms         │
│    |        |               │ success        │
│ Search    Shell             │                │
│                             │ arguments...   │
├─────────────────────────────┴────────────────┤
│ EXECUTION TIMELINE                           │
│ ███ Main                                     │
│   █████ Research                             │
│      ██ Search                               │
│    ███ Review                                │
├──────────────────────────────────────────────┤
│ Ask AgentTrace: [ Why was this run slow? ]  │
└──────────────────────────────────────────────┘
```

---

# 16. Live Graph

Nodes represent:

```text
agents
tools
external services
models, if observable
```

Edges represent:

```text
agent → agent message
agent → tool call
agent → model call
tool → external service
```

Edges animate while an operation is active.

Visual distinction should exist between:

```text
observed communication
lifecycle relationship
unobservable boundary
```

Do not visually imply full message visibility where it does not exist.

---

# 17. Timeline

Every asynchronous operation is represented as a span.

Example:

```text
0ms       main
│████████████████████████████████│

24ms      researcher
          │████████████████│

71ms      search
             │████████│

31ms      reviewer
           │█████████████████████│

80ms      shell
              │██████│
```

Clicking any span opens the event inspector.

This makes parallel agent execution immediately understandable.

---

# 18. Event Inspector

Selecting an edge/node/span displays:

```text
Type
Source
Destination
Provider
Start time
Duration
Status
Correlation ID
Visibility level
Arguments
Result
Error
Raw event
```

Raw payloads should be collapsible.

---

# 19. Gemini Module

Gemini is intentionally **not part of trace collection or metric computation**.

Gemini sits after the deterministic analysis layer.

Architecture:

```text
User question
     ↓
Gemini
     ↓
structured query
     ↓
deterministic trace API
     ↓
structured result
     ↓
Gemini explanation
```

Gemini's function-calling model fits this directly: Gemini selects a declared function and produces structured arguments, while the application—not the model—executes the function.

Functions:

```ts
getTraceSummary(traceId)

getAgentActivity(traceId, agentId)

getToolCalls(traceId, toolName?)

getFailures(traceId)

getCriticalPath(traceId)

getEventsBetween(traceId, start, end)

getEventsBefore(traceId, eventId, count)

getExactDuplicateCalls(traceId)
```

Example:

```text
User:
"Why was this run slow?"
```

Gemini calls:

```json
{
  "name": "getCriticalPath",
  "args": {
    "traceId": "abc"
  }
}
```

Backend returns:

```json
{
  "total_ms": 8420,
  "critical_path": [
    {
      "entity": "research_agent",
      "duration_ms": 6290
    },
    {
      "entity": "search",
      "duration_ms": 5702
    }
  ]
}
```

Gemini then explains:

```text
"The run spent 5.7 of its 8.4 seconds waiting on the search
tool used by the research agent, making it the dominant
contributor to latency."
```

The underlying numbers are deterministic.

Gemini structured output should still be validated application-side; Google's documentation explicitly recommends semantic validation even when schema-constrained output is used.

---

# 20. Privacy

Agent traces can contain extremely sensitive information:

```text
source code
shell commands
file contents
credentials
API responses
user prompts
agent messages
```

The MVP should therefore be local-first.

Default:

```text
collector: localhost
database: local
dashboard: localhost
Gemini receives summarized/query-specific data only
```

Raw payload forwarding to Gemini should be disabled by default.

Before sending anything to Gemini:

```text
deterministic query
      ↓
minimal relevant fields
      ↓
redaction
      ↓
Gemini
```

---

# 21. Redaction Layer

Before storage or LLM forwarding, optionally redact obvious secrets.

Examples:

```text
Authorization headers
API keys
Bearer tokens
password fields
.env values
private keys
```

MVP implementation can use:

```text
field-name denylist
+
basic secret regexes
```

Original local events may optionally be retained separately.

---

# 22. Persistence

For MVP:

```sql
traces

trace_id
provider
started_at
ended_at
status
```

```sql
events

event_id
trace_id
timestamp
source_id
destination_id
category
type
correlation_id
parent_event_id
status
duration_ms
visibility
provider
payload_json
```

Indexes:

```text
trace_id
timestamp
correlation_id
source_id
destination_id
```

Do not prematurely model agents/tools into normalized relational tables.

The event log should be the source of truth.

Derived graph/timeline state can always be rebuilt from it.

---

# 23. Determinism

Given the same ordered `TraceEvent` stream, AgentTrace must produce the same:

```text
graph
timeline
metrics
failure report
critical-path calculation
exact-duplicate detection
```

Gemini responses are outside this guarantee.

Conceptually:

```text
TraceEvent[]
     ↓
deterministic reducer
     ↓
TraceState
```

```ts
interface TraceState {
  entities: Map<string, Entity>;
  edges: Edge[];
  spans: Span[];
  metrics: TraceMetrics;
  errors: TraceError[];
}
```

The frontend should render `TraceState`, not reconstruct provider semantics independently.

---

# 24. MVP Integrations

For a one-day build:

## Required

### A2A demo integration

Two or three small agents communicate through the AgentTrace proxy.

This proves genuine:

```text
agent → agent messages
task lifecycle
artifacts
streaming
```

### Codex hooks integration

Capture:

```text
session
tool calls
tool results
subagent start
subagent stop
```

This proves compatibility with an existing major agent framework.

## Optional

Claude Code hooks.

Because all adapters normalize to `TraceEvent`, this is incremental rather than architectural work.

---

# 25. Demo Scenario

The demo should involve multiple agents so the network view matters.

Example:

```text
User:
"Investigate why authentication tests started failing."
```

System:

```text
                Coordinator
                 /        \
                /          \
          Researcher      Reviewer
              │              │
              ▼              ▼
         file search       shell
              │              │
              └──────┬───────┘
                     ▼
                Coordinator
```

Live UI:

```text
00.000 Coordinator started
00.041 Coordinator → Researcher
00.052 Coordinator → Reviewer
00.217 Researcher → file_search
00.390 Reviewer → shell
01.940 shell failed
02.112 Reviewer → Coordinator
03.485 Researcher → Coordinator
03.620 trace completed
```

Then ask Gemini:

> Why did the run fail?

Gemini queries deterministic events.

Answer:

```text
The first failure occurred in Reviewer's shell call at
1.94 seconds. The test command returned exit code 1.
No earlier operation in the trace was marked failed.
```

Then:

> Which agents worked in parallel?

Backend computes overlap.

Gemini explains it.

Then:

> Show me what happened immediately before the failure.

Gemini retrieves the preceding events.

This makes Gemini clearly useful while keeping it peripheral to the actual product.

---

# 26. What We Must Not Claim

AgentTrace must never claim to expose:

```text
private chain-of-thought
hidden model reasoning
unexposed internal prompts
all framework-internal communication
causal reasoning not represented in events
```

Use wording such as:

> "AgentTrace captures observable interactions between agents, tools and external systems."

Not:

> "AgentTrace shows everything your agents are thinking."

---

# 27. Non-Goals for MVP

Do not build:

```text
cloud accounts
authentication system
teams
billing
distributed collectors
production-scale telemetry
full OpenTelemetry backend
arbitrary framework auto-detection
automatic semantic root-cause analysis
agent replay
agent modification
permission enforcement
long-term storage management
```

These distract from the core demo.

---

# 28. Suggested Repository Structure

```text
agenttrace/
│
├── packages/
│   │
│   ├── protocol/
│   │   ├── trace-event.ts
│   │   ├── validation.ts
│   │   └── reducer.ts
│   │
│   ├── collector/
│   │   ├── server.ts
│   │   ├── event-store.ts
│   │   ├── websocket.ts
│   │   └── analysis/
│   │       ├── timings.ts
│   │       ├── failures.ts
│   │       └── duplicates.ts
│   │
│   ├── adapters/
│   │   ├── a2a/
│   │   ├── codex/
│   │   └── claude/
│   │
│   └── gemini/
│       ├── tools.ts
│       └── query.ts
│
├── apps/
│   └── dashboard/
│       ├── graph/
│       ├── timeline/
│       ├── inspector/
│       └── assistant/
│
└── demo/
    └── multi-agent-example/
```

Avoid separate services for each component.

For the MVP everything can run in one Node process except the frontend dev server.

---

# 29. Implementation Order

### Stage 1 — Canonical protocol

Implement:

```text
TraceEvent
schema validation
TraceState reducer
```

Do this first.

Every subsequent component depends on it.

### Stage 2 — Collector

Implement:

```text
POST /events
WebSocket broadcast
in-memory event store
```

Confirm manually inserted events appear correctly.

### Stage 3 — Dashboard

Implement:

```text
entity graph
live edges
event details
basic timeline
```

Use mocked events initially.

### Stage 4 — A2A adapter

Proxy a simple two-agent interaction and convert messages/tasks into `TraceEvent`.

This gives the first real end-to-end demo.

### Stage 5 — Codex adapter

Install lifecycle/tool hooks and forward events to the collector.

### Stage 6 — Deterministic analytics

Add:

```text
duration
failure detection
call counts
per-agent metrics
critical path
```

### Stage 7 — Gemini interface

Expose deterministic query functions and allow Gemini to call them.

Gemini is deliberately last.

The product should already work before this stage.

---

# 30. MVP Success Criteria

The prototype is successful if:

1. Two agents communicate through an observed A2A interaction.
2. Their communication appears live as graph edges.
3. Their events appear chronologically in the timeline.
4. Tool activity can appear as separate nodes.
5. Clicking an interaction displays its captured payload.
6. Timing and failure metrics are computed without an LLM.
7. At least one existing agent framework feeds events into the same dashboard.
8. Gemini can answer natural-language questions by querying deterministic trace functions.
9. The UI clearly distinguishes unavailable data from observed data.
10. No feature depends on access to private model reasoning.

---

# 31. Stretch Features

After the MVP:

### MCP Proxy

Observe MCP traffic independently of the host framework.

### OpenTelemetry Export

Translate AgentTrace spans into standard OTel spans instead of becoming a closed telemetry ecosystem. MCP already specifies W3C trace-context propagation, making this a natural direction.

### Compare Runs

```text
trace A
vs
trace B
```

Show:

```text
different agents spawned
different tool calls
latency regressions
new failures
different topology
```

### Cost Analysis

If providers expose token/cost metadata:

```text
cost by agent
cost by task
cost by tool
```

### Exact Duplicate Detection

Detect repeated identical tool calls.

### Semantic Redundancy Detection

Use Gemini to identify potentially equivalent work.

Must be labelled:

```text
AI inference
```

rather than deterministic fact.

### Agent Capability Firewall

The observability layer can eventually become an enforcement layer:

```text
Agent
  ↓
AgentTrace
  ↓
policy
  ↓
Tool
```

This should not be attempted in the hackathon MVP.

---

# 32. Core Architectural Invariant

Provider-specific semantics stop at the adapter boundary.

```text
Codex ───────┐
Claude ──────┼──▶ TraceEvent ─▶ everything else
A2A ─────────┤
MCP ─────────┘
```

No frontend component should contain:

```ts
if (provider === "codex") ...
```

No analytics component should contain:

```ts
if (provider === "claude") ...
```

Only adapters translate providers into the canonical model.

This is what allows AgentTrace to become genuinely framework-agnostic.

---

# 33. Final System

```text
              Existing Agent Systems
          ┌────────┬────────┬────────┐
          │        │        │        │
        Codex    Claude    A2A      MCP
          │        │        │        │
          ▼        ▼        ▼        ▼
      ┌───────────────────────────────┐
      │           Adapters            │
      └───────────────┬───────────────┘
                      │
                 TraceEvent
                      │
                      ▼
      ┌───────────────────────────────┐
      │       Deterministic Core      │
      │                               │
      │ event log                     │
      │ correlation                   │
      │ topology                      │
      │ timeline                      │
      │ analytics                     │
      └───────────────┬───────────────┘
                      │
           ┌──────────┴──────────┐
           │                     │
           ▼                     ▼
      Dashboard               Gemini
      visualization           I/O layer
           │                     │
           └──────────┬──────────┘
                      ▼
                    User
```

The defining idea is:

> **AgentTrace makes the observable behavior of multi-agent systems visible.**

The agents and protocols generate the telemetry.

AgentTrace deterministically records, correlates and visualizes it.

Gemini simply gives the developer a natural-language interface for interrogating that execution.
