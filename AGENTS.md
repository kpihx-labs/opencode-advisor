# AGENTS.md

This file governs OpenCode agent behavior in this repository. See [README.md](README.md) for installation and user configuration.

## Repository purpose

`@kpihx-labs/opencode-advisor` — KπX sovereign fork of `StefanoBalocco/opencode-advisor`. Provides three features:

1. **`advisor()` tool** — consults a strategic model on demand.
2. **Auto-escalation** — after a configurable number of consecutive tool errors, the plugin aborts the failing session, obtains hidden-advisor guidance, and resumes the source agent in a new turn.
3. **`/btw` command** — spawns an ephemeral sub-session to answer a by-the-way question without interrupting the currently running agent (forked from `u007/opencode-advisor`).

## Architecture

Two source entry points: `src/plugin.ts` (advisor + auto-escalation) and `src/btw.ts` (/btw command).

### advisor() tool

The `advisor()` tool uses the v1 plugin client to:

1. Fetch the current transcript.
2. Create an ephemeral session.
3. Prompt the hidden agent by name without passing `model`, `system`, or `tools` in the prompt body.
4. Extract text parts from the response.
5. Delete the ephemeral session in `finally`.

A recursion guard (`inAdvisorCall`) rejects concurrent nested calls.

### Auto-escalation (event hook)

The plugin uses the v1 `event` hook. It listens for `message.part.updated` with a `ToolPart`, `session.idle`, `session.status`, and `session.deleted` events. Factory-local state is isolated per plugin instance:

- `advisorSessions: Set<string>` — tracks temporary advisor session IDs so their tool events are ignored.
- `sessionStates: Map<string, SessionState>` — per-session failure counter, failure details (bounded to threshold), `triggered` latch, `intervening` flag, `awaitingIdle` flag, `idle` flag, `deleted` flag, resolved `sourceAgent`, and `advice` text.

**Flow:**

1. On a terminal error `ToolPart` whose `sessionID` is not an advisor session and whose `tool` is not `"advisor"`: increment the counter. When the counter first reaches `failureThreshold`, set `triggered` and `intervening` synchronously, then `void _launchIntervention()`.
2. `_launchIntervention` fetches the session messages, resolves the source agent via `ToolPart.messageID → assistant info.parentID → user info.agent`, and checks `cfg.agent?.[ agentName ]?.tools?.advisor !== false`. It then calls `abort()`. Only after a successful abort does it start the post-abort idle-wait phase (`awaitingIdle = true`, clear `idle`), record the current `idleGeneration`, and query `session.status()`. The status query result is applied only if no concurrent event advanced the generation. Pre-abort idle events do not qualify a resume. After status, it calls the shared advisor lifecycle with the failure context appended to the transcript.
3. `_maybeResume` fires exactly one source `session.prompt` when the state is registered, not deleted, `intervening`, `idle`, has a `sourceAgent`, and has `advice`. It clears `intervening` immediately before the fire-and-forget prompt.
4. On a terminal `completed` `ToolPart`: reset the counter and clear `triggered`.
5. During intervention (`intervening = true`), all tool events from that session are skipped.
6. `session.idle`, `session.status` (idle/busy/retry), and `session.deleted` events update state and may trigger `_maybeResume`.

Recursion exclusion: tool events from the internal advisor-session set are ignored. The `advisor` tool itself ignores its own error events to prevent cascading.

The shared advisor lifecycle (`_callAdvisor`) creates an ephemeral session, adds its ID to `advisorSessions`, prompts the hidden agent, extracts text, then removes the ID and deletes in `finally`. Both the manual tool and automatic intervention use this same function.

### /btw command

The `command.execute.before` hook intercepts `/btw <query>` commands. It:

1. Acknowledges immediately (agent continues working).
2. Fetches the session transcript, filtering out `/btw` user messages.
3. Creates an ephemeral session with the system prompt from `src/prompts/btw.md`.
4. Prompts the advisor model with transcript + question.
5. Appends the answer as a card to the main session.
6. Deletes the ephemeral session.

A recursion guard (`inBtwCall`) prevents nested calls.

## Configuration

### Advisor (plugin.ts)

The optional profile object is validated at plugin initialization. Model resolution uses the first available value: profile `model`, `agent.plan.model`, global `model`, then the `deepseek/deepseek-v4-pro` fallback.

```json
{
  "plugin": [
    ["@kpihx-labs/opencode-advisor", {
      "model": "deepseek/deepseek-v4-pro",
      "failureThreshold": 3,
      "temperature": 0
    }]
  ]
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | `"provider/model"` | `deepseek/deepseek-v4-pro` | Advisor model |
| `failureThreshold` | positive integer | `3` | Consecutive errors before auto-escalation |
| `temperature` | finite number | `0` | Advisor temperature |
| `prompt` | string | built-in | Custom system prompt (replaces default) |
| `variant` | string | — | Model variant |
| `top_p` | finite number | — | Top-p sampling |
| `options` | JSON-safe object | — | Provider-specific settings |

A supplied `prompt`, including an empty string, replaces the built-in prompt. `temperature` falls back to `0`. `top_p`, `variant`, and `options` are set only when supplied. Profile `options` accepts JSON-safe plain objects and is cloned before registration.

Per-agent opt-out: set `"tools": { "advisor": false }` for any agent in `opencode.jsonc` to prevent auto-escalation for that agent.

### /btw (btw.ts)

Same model resolution cascade as advisor. Pass options via separate plugin entry:

```json
{
  "plugin": [
    ["@kpihx-labs/opencode-advisor", { "model": "deepseek/deepseek-v4-pro" }],
    ["@kpihx-labs/opencode-advisor/btw", { "model": "deepseek/deepseek-v4-pro" }]
  ]
}
```

## Fixed permissions

The hidden advisor agent always receives this policy:

```json
{
  "*": "deny",
  "read": "allow",
  "glob": "allow",
  "grep": "allow",
  "webfetch": "allow",
  "websearch": "allow",
  "skill": "allow",
  "edit": "deny",
  "bash": {
    "*": "deny",
    "wc *": "allow",
    "git log *": "allow",
    "git diff *": "allow",
    "git show *": "allow",
    "rtk wc *": "allow",
    "rtk git log *": "allow",
    "rtk git diff *": "allow",
    "rtk git show *": "allow"
  }
}
```

No write access, LSP, task or todo tools, MCP tools, or arbitrary Bash commands are available.

## File structure

```
src/
├── plugin.ts          # advisor() tool + auto-escalation
├── btw.ts             # /btw slash command
└── prompts/
    └── btw.md         # /btw system prompt (loaded at runtime)
dist/
├── plugin.js + .d.ts  # compiled advisor
├── btw.js + .d.ts     # compiled /btw
```

## Development

```bash
npm install
node build.mjs all    # compile both plugin.ts + btw.ts
node build.mjs plugin # compile plugin only
```

## Forks

- **Base:** `StefanoBalocco/opencode-advisor` v2.3.1 — advisor tool + auto-escalation
- **Added:** `/btw` command from `u007/opencode-advisor` v1.2.3
- **Changed:** package name → `@kpihx-labs/opencode-advisor`, prompt moved to `src/prompts/btw.md`
