---
name: decide
description: Record a technical or architecture decision as an ADR in Sprintra. Use when the user says "let's use X", "should we go with X or Y", "I decided to", "record this decision", or makes a technology choice.
argument-hint: "[decision topic]"
---

# Record Decision (ADR)

Capture a technical or architecture decision into Sprintra as an Architecture Decision Record.

## Input

Decision topic: **$ARGUMENTS**

## Process

### Step 1: Understand the Decision

If the user already stated the decision clearly (e.g., "let's use PostgreSQL"), proceed to Step 2.

If it's a question ("should we use X or Y?"), briefly discuss tradeoffs (3-4 bullet points per option max), then ask: "Which way do you want to go?" Once decided, proceed.

### Step 2: Record the ADR

Call:
```
decisions(method: "add",
  title: "[concise decision title]",
  context: "[why this decision was needed — 2-3 sentences]",
  decision: "[what was decided and how it will be implemented — 2-3 sentences]",
  consequences: "[positive and negative consequences — brief]",
  category: "architecture|technology|design|infrastructure|process",
  status: "accepted"
)
```

Rules:
- **Title**: Past tense action — "Use PostgreSQL for primary database", "Adopt REST over GraphQL"
- **Context**: The problem or question that prompted this decision
- **Decision**: The chosen approach with enough detail to understand WHY
- **Consequences**: Both positive AND negative. Be honest about tradeoffs.
- **Category**: `architecture` (system structure), `technology` (tool/library choice), `design` (UI/UX), `infrastructure` (deploy/ops), `process` (workflow/team)

### Step 3: Check for Conflicts

Call `decisions(method: "get_conflicts")` to see if this contradicts any existing decisions. If conflicts found, flag them.

### Step 4: Confirm

```
Decision recorded: [title] (dec-xxxxx)
Category: [category]
Status: accepted
```

## Important

- Keep it concise. ADRs are reference docs, not essays.
- If the user is just thinking out loud ("maybe we should..."), don't record it. Only record actual decisions.
- One decision per invocation. If multiple decisions were made, tell the user to run `/decide` again for each.
