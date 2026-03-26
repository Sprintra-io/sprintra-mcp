<p align="center">
  <img src="https://sprintra.io/icon-192x192.png" width="80" alt="Sprintra Logo" />
</p>

<h1 align="center">Sprintra MCP Server</h1>

<p align="center">
  <strong>AI-native project management with persistent memory for coding agents</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@sprintra/cli"><img src="https://img.shields.io/npm/v/@sprintra/cli?color=6C63FF&label=npm" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@sprintra/cli"><img src="https://img.shields.io/npm/dm/@sprintra/cli?color=6C63FF" alt="npm downloads" /></a>
  <a href="https://sprintra.io"><img src="https://img.shields.io/badge/website-sprintra.io-6C63FF" alt="website" /></a>
  <a href="https://sprintra.io/docs"><img src="https://img.shields.io/badge/docs-sprintra.io%2Fdocs-6C63FF" alt="docs" /></a>
</p>

<p align="center">
  Your AI forgets. <strong>Sprintra remembers.</strong>
</p>

---

## What is Sprintra?

Sprintra gives your AI coding agent **persistent memory** — features, architecture decisions, sprint progress, and project context that survive session resets, token limits, and IDE switches.

**The problem:** Every AI coding session starts from scratch. Your agent doesn't know what you decided last week, what sprint you're in, or what your teammate built yesterday.

**The solution:** Sprintra's MCP server connects to Claude Code, Cursor, Windsurf, and any MCP-compatible tool. Your agent reads and writes project context automatically — no copy-paste, no re-explaining.

## Quick Start

### Option 1: Sprintra Cloud (Recommended)

```bash
# Install the CLI (42KB, zero native dependencies)
npm install -g @sprintra/cli

# Authenticate
sprintra login

# Auto-configure your AI tool
sprintra connect
```

### Option 2: Self-Hosted

```bash
# Scaffold a complete local project with server + dashboard
npx create-sprintra my-project

# Start the server
cd my-project
npm start

# Server + dashboard at http://127.0.0.1:4000
```

## MCP Configuration

### Claude Code

```json
{
  "mcpServers": {
    "sprintra": {
      "command": "npx",
      "args": ["@sprintra/cli", "mcp"]
    }
  }
}
```

Or run: `sprintra connect --tool claude-code`

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "sprintra": {
      "command": "npx",
      "args": ["@sprintra/cli", "mcp"]
    }
  }
}
```

Or run: `sprintra connect --tool cursor`

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "sprintra": {
      "command": "npx",
      "args": ["@sprintra/cli", "mcp"]
    }
  }
}
```

### Windsurf

Run: `sprintra connect --tool windsurf`

### HTTP Transport (Remote)

For remote MCP connections (Claude.ai, mobile):

```
URL: https://api.sprintra.io/api/mcp
Auth: Bearer <your-token>
Transport: HTTP + SSE
```

## 17 MCP Tools

Sprintra uses a consolidated tool pattern (inspired by [GitHub's MCP server](https://github.com/github/github-mcp-server)). Each tool accepts a `method` parameter to select the operation.

### Project Management

| Tool | Methods | Description |
|------|---------|-------------|
| `projects` | list, create, update, resolve, get_context | Manage projects with tech stack, status, and full context snapshots |
| `features` | list, get_bundle, create, update, save_context, get_context | Epic-level work items with acceptance criteria and AI guidance |
| `stories` | list, create, update, batch_update | Tasks under features — story, task, bug, chore types |
| `sprints` | list, get_current, create, update, assign | Time-boxed iterations with progress tracking |
| `releases` | list, create, update, generate_notes | Release milestones with auto-generated release notes |

### Knowledge & Decisions

| Tool | Methods | Description |
|------|---------|-------------|
| `decisions` | list, add, supersede, get_conflicts, resolve_conflict | Architecture Decision Records (ADRs) with AI conflict detection |
| `documents` | list, get, create, update, get_versions, restore_version, add_link, get_graph | Knowledge base with versioning, templates, and cross-references |
| `notes` | list, add | Quick capture — ideas, research findings, meeting notes |
| `sessions` | list, start, log_message, complete | Brainstorming sessions with AI personas |

### Tracking & Git

| Tool | Methods | Description |
|------|---------|-------------|
| `criteria` | add, remove, update_status, verify | Acceptance criteria management and verification |
| `git` | sync, link, unlink, get_status, get_feature_stats | Git commit tracking with AI authorship detection |
| `dependencies` | add, remove, get_graph | Feature dependency tracking with cycle detection |
| `work_sessions` | list, start, end, get_active, list_activity, list_traces, delta | Coding session tracking with context handoff |
| `comments` | list, create, update, delete | Threaded comments on any entity |
| `custom_fields` | manage, set, get | Custom metadata fields |

### AI Intelligence

| Tool | Methods | Description |
|------|---------|-------------|
| `ai` | get_next_work, report_progress, get_guidance, generate_briefing | AI-powered recommendations, progress tracking, and context recovery |
| `pull_requests` | list, get_story_prs | GitHub PR tracking and auto-linking |

## Example Prompts

Once connected, try these in Claude Code or Cursor:

```
"Create a Sprintra project for this repo"

"Capture a feature: user authentication with OAuth and email/password"

"What should I work on next?"

"Record a decision: we chose PostgreSQL over MongoDB for relational order data"

"Give me a standup report"

"What changed since my last session?"
```

## 8 AI Skills (Slash Commands)

Install workflow skills for guided project management:

```bash
sprintra skills install --all
```

| Skill | Trigger | Description |
|-------|---------|-------------|
| Capture Feature | `/capture [idea]` | Break down an idea into features, stories, and criteria |
| Record Decision | `/decide [topic]` | Create an Architecture Decision Record |
| Standup Report | `/standup` | Auto-generate standup from recent work |
| Wrap Session | `/wrap` | Save context for seamless session resume |
| Sprint Review | `/sprint-review` | Review sprint progress with metrics |
| Brainstorm | `/brainstorm [topic]` | AI-powered brainstorming with personas |
| Implement Feature | `/implement [id]` | Start implementation with full context loaded |
| Sprint Planning | `/sprint-plan` | Plan sprints with AI recommendations |

## Dashboard

Sprintra includes a full web dashboard with 20+ views:

- **Kanban Board** — drag-and-drop story management
- **Sprint Tracker** — progress bars, velocity charts, burndown
- **Roadmap** — phase timeline with feature grouping
- **Knowledge Base** — Confluence-style docs with versioning
- **Decisions** — ADR log with conflict detection
- **Reports** — burndown, velocity, DORA metrics
- **Activity Feed** — real-time project activity

**Cloud:** [app.sprintra.io](https://app.sprintra.io)
**Self-hosted:** `http://127.0.0.1:4000` after `npm start`

## Pricing

| Plan | Price | Includes |
|------|-------|---------|
| **Solo Pilot** | Free forever | 2 projects, unlimited stories, all MCP tools, all skills |
| **Team** | $5/seat/month | 10 projects, AI features, team collaboration, priority support |
| **Enterprise** | Custom | On-premise, dedicated infra, custom SLA |

## Links

- **Website:** [sprintra.io](https://sprintra.io)
- **Documentation:** [sprintra.io/docs](https://sprintra.io/docs)
- **MCP Tools Reference:** [sprintra.io/docs/mcp-tools](https://sprintra.io/docs/mcp-tools)
- **Skills Guide:** [sprintra.io/docs/skills](https://sprintra.io/docs/skills)
- **CLI Reference:** [sprintra.io/docs/cli](https://sprintra.io/docs/cli)
- **npm:** [@sprintra/cli](https://www.npmjs.com/package/@sprintra/cli)
- **Blog:** [sprintra.io/blog](https://sprintra.io/blog)

## License

The Sprintra MCP server documentation in this repository is MIT licensed.
The Sprintra server, dashboard, and CLI are proprietary software — see [sprintra.io/pricing](https://sprintra.io/pricing) for plans.
