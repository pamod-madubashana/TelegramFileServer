---
description: Create a development plan from a feature specification
handoffs: 
  - label: Implement Feature
    agent: speckit.implement
    prompt: Execute the plan to implement the feature
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Instructions

1. Load the feature specification from `specs/*/spec.md` (you'll be told which one to use)

2. Create a plan that addresses all P1-P3 requirements in the spec

3. Focus only on what needs to be done, not how it will be done

4. Do NOT include:
   - Implementation details
   - Code snippets
   - Technology choices
   - API designs

5. Do include:
   - High-level steps in logical order
   - Dependencies between steps
   - Validation criteria for each step
   - Resource requirements (if any)

6. Output format:

```markdown
# Implementation Plan: [Feature Name]

**Plan Generated**: [Date]
**Spec Source**: [Relative path to spec.md]
**Branch**: [Feature branch name]

## Overview
Brief summary of what this plan accomplishes

## Prerequisites
- [ ] List any requirements that must be met before starting

## Implementation Steps

### Step 1: [Step Name]
- **Priority**: [P1/P2/P3]
- **Description**: What needs to be done
- **Dependencies**: [List any preceding steps]
- **Validation**: How to confirm this step is complete

### Step 2: [Step Name]
...

## Success Criteria
- [ ] List measurable outcomes that define success

## Risks & Mitigations
- [ ] List potential obstacles and how to address them
```