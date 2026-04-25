---
name: capture
description: Capture a feature idea into Sprintra with stories, acceptance criteria, and decisions. Use when the user describes something they want to build, a feature request, or says "let's plan" or "I want to build".
argument-hint: "[feature description]"
---

# Capture Feature into Sprintra

You are capturing a product feature into Sprintra project management. Your job is to have a SHORT conversation (2-3 exchanges max) to understand what the user wants, then create well-structured artifacts via MCP tools. Do NOT over-interview — developers hate long Q&A. Get enough to create quality artifacts, infer the rest.

## Input

The user described: **$ARGUMENTS**

## Process

### Step 1: Quick Clarification (1 exchange only)

If the description is clear enough to act on, skip to Step 2. Only ask if genuinely ambiguous. When you do ask, batch all questions into ONE message:
- What's the priority? (critical/high/medium/low) — infer from context if possible
- Any technical constraints or preferences?
- Target sprint or just backlog?

If the user gave enough context already, say "Got it, let me capture this" and proceed.

### Step 2: Create the Feature

Call the `features` MCP tool:
```
features(method: "create", title: "...", description: "...", priority: "...", acceptance_criteria: [...])
```

Rules:
- **Title**: Short, action-oriented (e.g., "User Authentication System" not "Auth")
- **Description**: 2-3 sentences explaining the WHY and WHAT
- **Priority**: Infer from conversation tone — "need this ASAP" = critical, "would be nice" = low
- **Acceptance criteria**: 3-5 testable criteria derived from the conversation. Use "Given/When/Then" or simple "User can..." format
- **Inferred fields**: List any fields you inferred (not explicitly stated) in the `inferred_fields` array

### Step 3: Break into Stories

For each distinct piece of work, call:
```
stories(method: "create", feature_id: "...", title: "...", type: "story|task|bug", story_points: N, description: "...", acceptance_criteria: [...])
```

Rules:
- Each story should be **2-4 hours of work** (1-3 story points)
- Use types: `story` (user-facing), `task` (technical), `bug` (fix), `chore` (maintenance)
- Story points: 1 (trivial), 2 (small), 3 (medium), 5 (large), 8 (needs breakdown)
- If a story is 8+ points, break it further
- Include 2-3 acceptance criteria per story
- Order stories logically (foundation first, then features, then polish)

### Step 4: Capture Decisions (if any)

If the conversation included technical choices (e.g., "let's use PostgreSQL", "we'll go with REST not GraphQL"), record each as:
```
decisions(method: "add", title: "...", context: "...", decision: "...", consequences: "...", category: "architecture|technology|design|infrastructure|process")
```

### Step 5: Summary

Show a compact summary:
```
Feature: [title] ([priority])
Stories: [count] ([total points] SP)
  1. [story title] — [points] SP
  2. [story title] — [points] SP
  ...
Decisions: [count] recorded
Completeness: [score]%
```

## Important

- Do NOT ask more than 1 round of questions. Developers want to capture and move on.
- Infer liberally — an honest 60% completeness is fine. User can refine later.
- If the user just says `/capture` with no args, ask "What are we building?" — one sentence is enough.
- Always check the completeness score in the response. If yellow/red, mention what's missing but don't block.
