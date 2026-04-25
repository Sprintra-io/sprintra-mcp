---
name: wrap
description: End a coding session and save context to Sprintra. Use when the user says "I'm done", "wrapping up", "save progress", "end session", or is about to stop working.
disable-model-invocation: true
---

# Wrap Up Session

Save the current coding session's context to Sprintra so the next session can resume seamlessly. This is the "save game" for development work.

## Process

### Step 1: Check Active Session

Call `work_sessions(method: "get_active")`. If no active session, skip to summary.

### Step 2: Analyze What Happened

Look at:
- Git status: what files were changed (use `git diff --stat HEAD~5` via Bash if needed)
- Conversation context: what stories were worked on, what decisions were made
- Any stories that should be marked done

### Step 3: Update Story Statuses

For any stories completed during this session:
```
stories(method: "update", story_id: "...", status: "done")
```

Add a comment to each completed story:
```
comments(method: "create", entity_type: "story", entity_id: "...", content: "Completed: [what was done, files changed, how tested]")
```

### Step 4: Save Feature Context (if applicable)

If a feature was being worked on, save where you left off:
```
features(method: "save_context", feature_id: "...", where_left_off: "...", last_session_summary: "...", files_touched: [...])
```

### Step 5: End Work Session

```
work_sessions(method: "end", summary: "...", files_changed: [...], stories_completed: [...], next_steps: "...")
```

Include:
- **summary**: 1-2 sentences of what was accomplished
- **files_changed**: key files modified (not every file — just the important ones)
- **stories_completed**: IDs of stories marked done
- **next_steps**: what to pick up next time (critical for session continuity)

### Step 6: Git Sync (if commits were made)

```
git(method: "sync")
```

Then link commits to stories:
```
git(method: "link", story_id: "...", commit_hash: "...")
```

### Step 7: Show Summary

```
## Session Wrapped ✓

Duration: [start time] → [now]
Stories completed: [list]
Files changed: [count]
Next steps: [what to do next time]

Context saved — next session will auto-resume.
```

## Important

- This should take <30 seconds. Don't over-analyze — capture the essentials.
- If the user didn't work on any tracked stories, just end the session with a summary.
- Always include `next_steps` — this is the most valuable field for session continuity.
- Don't ask questions. Just gather, save, and confirm.
