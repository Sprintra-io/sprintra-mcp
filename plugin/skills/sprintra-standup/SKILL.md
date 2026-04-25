---
name: standup
description: Generate a standup report from recent work sessions, git commits, and story updates. Use when the user says "standup", "what did I do", "status update", or "progress report".
---

# Standup Report

Generate a concise standup report by reading Sprintra data. No user input needed — just gather and summarize.

## Process

### Step 1: Gather Data (all in parallel if possible)

1. **Recent work sessions**: `work_sessions(method: "list")` — get last 1-2 sessions
2. **Current sprint**: `sprints(method: "get_current")` — sprint progress
3. **Recent activity**: `work_sessions(method: "list_activity", limit: 20)` — what changed recently
4. **AI recommendation**: `ai(method: "get_next_work")` — what to work on next

### Step 2: Format the Report

```
## Standup — [today's date]

### Done (since last session)
- [story title] — [status change] ([feature name])
- [what was accomplished in last work session]
- [commits made]

### In Progress
- [story title] — [current status] ([feature name])
- [what's being worked on]

### Next Up
- [AI recommended next story] — [why this one]
- [any blocked items]

### Sprint Progress
[sprint name]: [done]/[total] stories ([percentage]%)
[progress bar visualization]
```

### Step 3: Flag Issues

If you notice:
- Stories stuck in "in_progress" for multiple sessions → flag as potentially blocked
- Sprint at risk (>50% time elapsed, <30% stories done) → flag
- No work session ended properly → remind about `/wrap`

## Important

- Keep it SHORT — developers scan standups, they don't read essays
- Use bullet points, not paragraphs
- Include the sprint progress bar — it's the most glanced-at element
- If no recent work sessions exist, say "No recent sessions found. Start one with `work_sessions(method: 'start')`"
