---
description: Implement tasks from a task breakdown
handoffs: 
  - label: Verify Implementation
    agent: speckit.checklist
    prompt: Verify the implementation meets all requirements
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Instructions

1. Load the task breakdown from `tasks/*/tasks.md` (you'll be told which one to use)

2. Implement each task in order, following the priorities and dependencies

3. For each task:
   - Understand what needs to be done
   - Implement the solution
   - Validate that the task is complete

4. Do NOT include:
   - Unnecessary comments
   - Debugging code
   - Temporary files

5. Do include:
   - Clean, well-structured code
   - Proper error handling
   - Clear documentation where needed

6. Output format:

```
# Implementation Log: [Feature Name]

**Started**: [Date]
**Task Source**: [Relative path to tasks.md]

## Implemented Tasks

### Task 1: [Task Name]
- **Status**: Completed
- **Files Modified**: [List of files]
- **Notes**: [Any important details]

### Task 2: [Task Name]
...
```

