---
name: sprint-review
description: Review current sprint progress with metrics, blockers, and recommendations. Use when the user says "sprint review", "how's the sprint", "sprint status", or at the end of a sprint.
disable-model-invocation: true
---

# Sprint Review

Generate a comprehensive sprint review with metrics, story breakdown, and recommendations.

## Process

### Step 1: Load Sprint Data

1. `sprints(method: "get_current")` — current sprint + progress + readiness
2. `features(method: "list")` — all features (filter by sprint_id)
3. `ai(method: "get_next_work")` — recommended priorities

### Step 2: Calculate Metrics

From the sprint data, compute:
- **Velocity**: stories done / total stories (%)
- **Points delivered**: sum of completed story points
- **Burndown status**: on track / at risk / behind
- **Readiness**: how many stories are "ready" vs "needs_info" vs "not_ready"

### Step 3: Format the Review

```
## Sprint Review: [sprint name]

### Progress
[done]/[total] stories ([percentage]%) | [points delivered]/[total points] SP
[=========>          ] 55% complete

### By Status
- Done: [count] stories
- In Progress: [count] stories
- Todo: [count] stories

### Feature Breakdown
| Feature | Stories | Done | Status |
|---------|---------|------|--------|
| [name]  | [total] | [done] | [on track / at risk] |

### Blockers & Risks
- [any stories stuck in in_progress for too long]
- [features with 0% progress]
- [dependencies not met]

### Recommendations
- [AI-recommended next work]
- [stories to deprioritize if sprint is at risk]
- [carry-over items for next sprint]
```

### Step 4: If Sprint is Ending

If the user says "close the sprint" or "end sprint":
1. Move incomplete stories to backlog or next sprint
2. `sprints(method: "update", status: "completed")` with retrospective data
3. Ask: "What went well? What to improve?" for the retro

## Important

- Use tables and progress bars — make it scannable
- Flag risk early: if >50% time elapsed and <30% done, say so clearly
- Don't sugar-coat. Honest status is more valuable than optimistic status.
