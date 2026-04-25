# Sprintra — Claude Code Plugin

AI-native project management skills for [Sprintra](https://sprintra.io). Plan features, track sprints, record architecture decisions, and generate standup reports — all through natural conversation with your AI coding assistant.

## Installation

```bash
# Add the Sprintra marketplace (one-time)
/plugin marketplace add ravindra240385/VibePilot

# Install the plugin
/plugin install sprintra
```

Or test locally:
```bash
claude --plugin-dir ./packages/claude-plugin
```

## Setup

1. Sign up at [app.sprintra.io](https://app.sprintra.io)
2. Go to Settings → Agents → Create Token
3. Set your token as an environment variable:
   ```bash
   export SPRINTRA_TOKEN="vp_your_token_here"
   ```
4. The plugin auto-connects to Sprintra via MCP

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
