---
active: true
iteration: 2
max_iterations: 200
completion_promise: 'BACKLOG COMPLETE'
started_at: '2026-01-28T03:38:13Z'
---

# TD Backlog Completion Loop

You are an autonomous agent completing the entire TD backlog for Zeroshot.

## Session Setup (Every Iteration)

First, check for and commit any uncommitted work from previous iteration:

```bash
git status --porcelain
# If there are changes, commit them:
git add -A && git commit -m "wip: recover uncommitted work from previous iteration" || true
```

Create a unique session identity so you can review previous iteration's work:

```bash
td session --new "ralph-$(date +%s)"
td whoami
```

## Priority Order

1. **Review first** - Complete pending reviews before starting new work
2. **Unblock bottlenecks** - Follow critical path order
3. **One task at a time** - Focus on single issue per iteration

## Phase 1: Check for Reviews

```bash
td reviewable
```

If there are reviewable issues:

1. Show the issue: `td show <id>`
2. Read the implementation files
3. Run tests: `npm test`
4. **Approve** if tests pass and implementation is correct: `td approve <id>`
5. **Reject** with specific feedback if issues found: `td reject <id> "reason"`

You CANNOT review issues you implemented (td enforces this via session).

## Phase 2: Pick Next Task

```bash
td critical-path
td next
```

If `td next` returns nothing, check for blocked issues:

```bash
td blocked
```

If issues are blocked, investigate and unblock if possible:

```bash
td show <blocked-id>
td unblock <id>  # If blocker is resolved
```

Select the highest-priority unblocked task. Start it:

```bash
td start <id>
td focus <id>
```

## Phase 3: Implement

Read the issue carefully:

```bash
td show <id>
```

Implement the task following these rules:

- Read existing code before writing new code
- Follow patterns in `src/issue-providers/` for provider implementation
- Write tests alongside implementation
- Run `npm test` before submitting

Log progress as you work:

```bash
td log "Implemented X"
td log "Tests passing"
```

For larger tasks, commit incrementally:

```bash
git add -A && git commit -m "wip(<id>): <what you just did>"
```

## Phase 4: Commit and Submit for Review

When implementation is complete and tests pass:

```bash
# Run tests
npm test

# Commit all changes with descriptive message
git add -A
git commit -m "feat(<id>): <short description>

Implements <issue title>.

td: <id>"

# Submit for review
td review <id>
td handoff <id>
```

The handoff captures your working state for the next iteration.

**Commit message format:**

- `feat(<id>):` for features/tasks
- `fix(<id>):` for bugs
- `test(<id>):` for test-only changes
- `refactor(<id>):` for refactoring

Always include `td: <id>` in commit body for traceability.

## Completion Check

After each iteration, check if ALL work is done:

```bash
td query "status != closed" -o count
```

**If count is 0**, the entire backlog is complete. Output:

<promise>BACKLOG COMPLETE</promise>

Also check progress:

```bash
td info
```

## Rules

- NEVER skip tests
- NEVER approve your own work (use different session each iteration)
- ALWAYS commit before handoff - no uncommitted work between iterations
- ALWAYS use WIP commits for incremental progress (never use git stash)
- ALWAYS follow critical path order
- ALWAYS run `npm test` before review submission
- If blocked, log the blocker: `td log --type blocker "reason"`
- If a task has failing tests after 3 attempts, reject and move on

## Context Files

Read these for guidance:

- `CLAUDE.md` - Project rules and patterns
- `src/issue-providers/github-provider.js` - Reference implementation
- `src/issue-providers/index.js` - Provider registration

## Epic Hierarchy (Complete in Order)

```
td-dcfc85: TD Issue Provider Integration (parent)
├── td-c64785: Phase 1 - Core Implementation
├── td-007dbe: Phase 2 - Worktree & Docker Integration
├── td-4a13d8: Phase 3 - TD Lifecycle Hooks
├── td-52faa8: Phase 4 - Comprehensive Test Suite
└── td-f71b62: Phase 2 Advanced - Cross-Provider Integration
```

The critical path automatically sequences work across all phases.

## Stuck Detection

If you find yourself on the same task for 3+ iterations:

1. Check if it's actually blocked: `td show <id>`
2. Log what's preventing progress: `td log --type blocker "specific issue"`
3. Consider breaking into subtasks or escalating

## Progress Tracking

Each iteration, log a summary:

```bash
td log "Iteration complete: reviewed X, implemented Y, Z remaining"
```
