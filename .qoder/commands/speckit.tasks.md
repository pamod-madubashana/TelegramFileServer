---
description: Break an implementation plan down into executable tasks
handoffs: 
  - label: Execute Tasks
    agent: speckit.implement
    prompt: Implement the tasks in the plan
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Instructions

1. Load the implementation plan from `plans/*/plan.md` (you'll be told which one to use)

2. Break the plan down into executable tasks

3. Each task should be:
   - Specific and actionable
   - Have a clear outcome
   - Be completable in a reasonable timeframe
   - Include validation criteria

4. Do NOT include:
   - Implementation details
   - Code snippets
   - Technology choices

5. Do include:
   - Task priorities (P1/P2/P3)
   - Dependencies between tasks
   - Validation criteria for each task

6. Output format:

```
# Task Breakdown: [Feature Name]

**Generated**: [Date]
**Plan Source**: [Relative path to plan.md]

## Task List

### Task 1: [Task Name]
- **Priority**: [P1/P2/P3]
- **Description**: What needs to be done
- **Dependencies**: [List any preceding tasks]
- **Validation**: How to confirm this task is complete

### Task 2: [Task Name]
- **Priority**: [P1/P2/P3]
- **Description**: What needs to be done
- **Dependencies**: [List any preceding tasks]
- **Validation**: How to confirm this task is complete

...

```

