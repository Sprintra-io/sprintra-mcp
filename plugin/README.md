# Sprintra — Claude Code Plugin

Persistent project memory and full session-recovery loop for [Sprintra](https://sprintra.io). Plan features, track sprints, record architecture decisions, and **never lose your place** — every Claude Code session auto-loads project state on startup and auto-captures what happened so the next session picks up exactly where you left off.

## Installation

```bash
# Add the Sprintra marketplace (one-time)
/plugin marketplace add Sprintra-io/sprintra-mcp

# Install the plugin
/plugin install sprintra@sprintra
```

## Setup

1. Sign up at [app.sprintra.io](https://app.sprintra.io)
2. Go to Settings → Agents → Create Token
3. Save the token (the `sprintra` CLI stores it at `~/.sprintra/config.json`):
   ```bash
   echo "vp_your_token_here" | npx @sprintra/cli@latest login
   ```
   Or set it as an env var: `export SPRINTRA_TOKEN="vp_..."`
4. In your project root, run `mcp__vibepilot__work_sessions generate_claude_md` (or let the agent do it) to drop a `.sprintra/project.json` marker so hooks know which project this directory belongs to.

## Memory Layer Hooks (the magic)

Four hooks form the session-recovery loop:

| Hook | When it fires | What it does |
|------|---------------|--------------|
| **SessionStart** | Claude Code launches, `/clear`, or auto-compaction | Fetches a ~250-token project briefing (active sprint, WIP stories, last session summary, recent decisions) and injects it into the agent's context. Zero manual context loading. |
| **PostToolUse** | After every tool call (Read, Edit, Write, Bash, MCP, …) | Logs the action to `agent_actions` with project + user attribution. Skips Sprintra's own MCP self-calls to avoid noise. Fire-and-forget, 5s hard timeout — never blocks the agent. |
| **Stop** | Session pauses (Ctrl+C, `/clear`, compact) | Asks the API to summarize the session window into a single readable note. The next SessionStart picks it up as "Last session". |
| **SessionEnd** | Claude Code shuts down cleanly | Final cleanup. |

All hooks silently no-op if Sprintra is unreachable. They are designed to **never** block your agent.

## Skills Included

| Skill | Command | What it does |
|-------|---------|-------------|
| **PM** | `/sprintra:sprintra-pm` | Conversational project manager — lists projects, loads context, suggests work |
| **Capture** | `/sprintra:sprintra-capture` | Capture a feature with stories, criteria, and decisions |
| **Standup** | `/sprintra:sprintra-standup` | Generate standup report from work sessions |
| **Wrap** | `/sprintra:sprintra-wrap` | Save session context for seamless resume |
| **Decide** | `/sprintra:sprintra-decide` | Record architecture decisions as ADRs |
| **Sprint Review** | `/sprintra:sprintra-sprint-review` | Sprint metrics, blockers, recommendations |

## How It Works

The plugin connects to Sprintra's MCP server which provides 17 project management tools:

- **projects** — list, create, update, get context
- **features** — plan epics with acceptance criteria
- **stories** — track tasks with story points
- **sprints** — time-boxed iterations with progress tracking
- **decisions** — architecture decision records (ADRs)
- **documents** — knowledge base with versioning
- **work_sessions** — session continuity across restarts

Skills guide Claude through structured workflows using these tools, so you don't need to remember tool names or parameters.

## Requirements

- Claude Code v2.1+
- Sprintra account ([app.sprintra.io](https://app.sprintra.io))
- `SPRINTRA_TOKEN` environment variable

## License

MIT
