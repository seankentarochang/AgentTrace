# Framework hook setup (Track 3)

Each framework calls `agenttrace-ingest <adapter>` on stdin JSON per lifecycle
event. The CLI maps it to `TraceEvent`s and POSTs to the collector; it always
exits 0 and times out emit after 3s, so it can never block the host tool.

Raw payloads are always dumped to `demo/hook-dumps/` (override with
`AGENTTRACE_HOOK_DUMP`, disable with `AGENTTRACE_HOOK_DUMP=off`) — dumps are
how the mappers get verified against real payloads.

Repo-local replay for testing without a live session:

```bash
echo '{"hook_event_name":"PreToolUse","session_id":"s1","tool_name":"Bash","tool_use_id":"t1","tool_input":{"command":"ls"}}' | npm run ingest:codex -w @agenttrace/adapters
```

## Codex (verified end-to-end on codex-cli 0.155)

`.codex/hooks.json` in this repo registers the ingest command for
SessionStart/PreToolUse/PostToolUse/UserPromptSubmit/SubagentStart/
SubagentStop/Stop. The `hooks` feature is stable and on by default in
0.155 — but non-managed hooks are **skipped until trusted**: either run
`/hooks` in the interactive CLI and trust them once, or for demos run:

```bash
codex --dangerously-bypass-hook-trust exec "..."
```

Verified 2026-09-19: a `codex exec` session emitted SessionStart →
UserPromptSubmit → PreToolUse → PostToolUse → Stop into the live collector;
dumps landed in `demo/hook-dumps/`.

Real payload fields (from dumps): `session_id`, `turn_id`,
`transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`,
`source` (SessionStart), `prompt` (UserPromptSubmit), `tool_name`,
`tool_input`, `tool_use_id`, `tool_response` (PostToolUse — can be a plain
string), `stop_hook_active` + `last_assistant_message` (Stop). In subagent
contexts `agent_id`/`agent_type` also appear (codex-rs hooks schema).

Hook commands run with the session cwd; `commandWindows` overrides the
command on Windows if needed.

## Claude Code

Add to the target project's `.claude/settings.json` (or `~/.claude/settings.json`
for all projects) — do NOT commit a `.claude/` dir to this repo:

```json
{
  "hooks": {
    "SessionStart":    [{ "hooks": [{ "type": "command", "command": "node --import tsx <abs>/packages/adapters/src/cli.ts claude" }] }],
    "PreToolUse":      [{ "matcher": "*", "hooks": [{ "type": "command", "command": "...same..." }] }],
    "PostToolUse":     [{ "matcher": "*", "hooks": [{ "type": "command", "command": "...same..." }] }],
    "UserPromptSubmit":[{ "hooks": [{ "type": "command", "command": "...same..." }] }],
    "Stop":            [{ "hooks": [{ "type": "command", "command": "...same..." }] }],
    "SubagentStop":    [{ "hooks": [{ "type": "command", "command": "...same..." }] }]
  }
}
```

`<abs>` = absolute path to this repo. `node --import tsx` resolves `tsx` from
the hook's cwd — run the framework from the repo root, or point NODE_PATH at
`<abs>/node_modules`, or install tsx globally.
