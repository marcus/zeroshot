# TD Integration User Guide

This guide covers how to use ZeroShot with TD (Task Daemon) as your issue provider for local-first, AI-powered task management.

---

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Quick Start](#quick-start)
4. [Configuration](#configuration)
5. [Running Tasks](#running-tasks)
6. [Worktree & Docker Isolation](#worktree--docker-isolation)
7. [Cross-Provider Workflows](#cross-provider-workflows)
8. [Session Management](#session-management)
9. [Context & Handoffs](#context--handoffs)
10. [Troubleshooting](#troubleshooting)
11. [Best Practices](#best-practices)

---

## Overview

[TD](https://marcus.github.io/td/) is a local-first issue tracker that stores tasks in a SQLite database (`.todos/issues.db`). ZeroShot's TD integration enables:

- **Multi-agent workflows** on locally-managed TD issues
- **Automatic session tracking** per agent for proper implementer/reviewer separation
- **Rich context injection** including handoffs from previous sessions
- **Cross-provider PR support** using GitHub/GitLab while tracking locally with TD
- **Worktree isolation** with TD database sharing via `.td-root`

### How It Works

```
User creates TD issue → ZeroShot fetches issue data → Agents work on task
                         ↓
                    TD auto-start (marks issue in_progress)
                         ↓
                    Agents log progress via td log
                         ↓
                    On completion: td handoff captures state
                         ↓
                    PR mode: td review submits for review
```

---

## Prerequisites

### 1. Install TD CLI

See the [TD Getting Started guide](https://marcus.github.io/td/docs/intro/) for full installation instructions.

**Quick install via Go:**

```bash
go install github.com/marcus/td@latest
```

Ensure Go's bin directory is in your PATH:

```bash
export PATH="$PATH:$HOME/go/bin"
```

Verify installation:

```bash
td version
```

> **Note:** Requires Go 1.21 or later. If `td version` prints nothing, confirm `~/go/bin` is in your PATH and restart your terminal.

### 2. Initialize TD in Your Project

```bash
cd your-project
td init
```

This creates `.todos/` directory with the SQLite database.

### 3. Install ZeroShot

```bash
npm install -g @covibes/zeroshot
```

---

## Quick Start

### Create and Run a TD Issue

```bash
# Create a TD issue
td create "Add user authentication endpoint" --type feature

# Output: Created td-abc123

# Run ZeroShot on the issue
zeroshot run td-abc123

# Or use short form (if defaultIssueSource is 'td')
zeroshot run abc123
```

### View Issue Status

```bash
# Show issue details
td show td-abc123

# View issue history (logs, handoffs)
td context td-abc123

# View current session context
td usage
```

---

## Configuration

### Set TD as Default Issue Source

```bash
# Make TD the default for bare issue IDs
zeroshot settings set defaultIssueSource td
```

With this setting:

- `zeroshot run abc123` → Fetches TD issue `td-abc123`
- `zeroshot run td-abc123` → Still works (explicit prefix)

### Issue ID Formats

| Format     | Example     | Description                       |
| ---------- | ----------- | --------------------------------- |
| Full TD ID | `td-abc123` | Always recognized                 |
| Short form | `abc123`    | Requires `defaultIssueSource: td` |
| Hex string | `abcdef12`  | 6+ hex chars with TD as default   |

---

## Running Tasks

### Basic Run (No Isolation)

```bash
zeroshot run td-abc123
```

- Runs agents in current directory
- Changes applied directly to working tree
- Best for: Quick fixes, exploration

### With Worktree Isolation

```bash
zeroshot run td-abc123 --worktree
```

- Creates isolated git worktree
- TD database shared via `.td-root` file
- Changes isolated until merged
- Best for: Feature development, experiments

### With PR Creation

```bash
zeroshot run td-abc123 --pr
```

- Creates worktree + generates PR
- Works with GitHub/GitLab (auto-detected from git remote)
- TD issue automatically transitions to `in_review`
- Best for: Code review workflows

### Auto-Merge (Ship Mode)

```bash
zeroshot run td-abc123 --ship
```

- Creates worktree + PR + auto-merge
- TD issue transitions to `closed` on merge
- Best for: Minor fixes, self-reviewed changes

### Background Mode

```bash
zeroshot run td-abc123 -d
```

- Runs cluster in background (daemon mode)
- Ctrl+C detaches (doesn't stop cluster)
- Monitor with `zeroshot logs <cluster-id>`

---

## Worktree & Docker Isolation

### Worktree Isolation

When using `--worktree`, `--pr`, or `--ship`, ZeroShot:

1. Creates a git worktree: `~/.zeroshot-worktrees/<cluster-id>`
2. Creates `.td-root` file pointing to main repo's `.todos/`
3. TD commands in worktree access the shared database

```
Main Repo                    Worktree
├── .todos/                  ├── .td-root (points to main repo)
│   └── issues.db            ├── src/
├── src/                     └── ...
└── ...
```

**TD commands work normally in worktrees:**

```bash
# From worktree
td show td-abc123    # Reads from main repo's database
td log td-abc123 "Progress update"  # Writes to main repo's database
```

### Docker Isolation

```bash
zeroshot run td-abc123 --docker
```

TD database is mounted into the container:

```
Host: /path/to/project/.todos → Container: /workspace/.todos
```

Configure TD mounts in settings:

```bash
zeroshot settings set dockerMounts '["gh","git","ssh","td"]'
```

---

## Cross-Provider Workflows

Use TD for local task tracking while creating PRs on GitHub/GitLab.

### TD + GitHub PR

```bash
# Create local TD issue
td create "Implement feature X" --type feature
# → td-abc123

# Run with GitHub PR
zeroshot run td-abc123 --pr
```

**What happens:**

1. TD issue fetched (local)
2. Git remote detected (github.com)
3. Agents implement in worktree
4. GitHub PR created
5. PR URL logged to TD issue
6. TD issue transitions to `in_review`

### TD + GitLab MR

Works the same way - platform detected from git remote:

```bash
# In a GitLab-hosted repo
zeroshot run td-abc123 --pr
# → Creates GitLab Merge Request
```

### Viewing PR Links

```bash
td context td-abc123
```

Shows logged PR/MR URLs in issue history.

---

## Session Management

Each ZeroShot agent gets its own TD session, enabling:

- Proper implementer/reviewer separation
- TD's enforcement that `reviewer_session != implementer_session`
- Clean audit trails per agent

### How Sessions Are Assigned

| Agent Role                | Session Usage                               |
| ------------------------- | ------------------------------------------- |
| `implementation` (worker) | Becomes `implementer_session` on `td start` |
| `validator`               | Different session, can run `td approve`     |
| `conductor`               | Own session for classification decisions    |

### Environment Variable

Each agent receives `TD_SESSION` environment variable:

```bash
TD_SESSION=ses_worker_abc123
```

TD commands automatically use this session:

```bash
td log "Progress update"  # Uses TD_SESSION from env
```

### Viewing Sessions

```bash
td usage
# Shows: Current session, focus, recent handoffs
```

---

## Context & Handoffs

### Rich Context Injection

When ZeroShot fetches a TD issue, agents receive:

1. **Issue Details**
   - Title, description, acceptance criteria
   - Status, type, priority, labels

2. **Session Context** (from `td usage`)
   - Current session info
   - Focus issue
   - Recent handoffs from other sessions

3. **Issue History** (from `td context`)
   - Progress logs
   - Decision logs
   - Blockers
   - Previous handoffs

### Automatic Handoff Capture

On cluster completion, ZeroShot extracts structured handoff data:

| Source                        | Extracted As    |
| ----------------------------- | --------------- |
| Worker summary                | Done items      |
| `completionStatus.nextSteps`  | Remaining items |
| `td log --decision` in output | Decisions       |
| Validation errors             | Remaining items |

**Handoff command generated:**

```bash
td handoff td-abc123 \
  --done "Implemented X" \
  --done "Fixed Y" \
  --remaining "Edge case Z" \
  --decision "Used approach A because..."
```

### Context Refresh on Resume

When resuming a cluster:

```bash
zeroshot resume <cluster-id>
```

Fresh TD context (`td context <id>`) is injected as `TD_CONTEXT_REFRESH` message.

### Manual Logging in Agents

Agents can log directly to TD:

```bash
# Progress update
td log td-abc123 "Implemented core logic"

# Decision with reasoning
td log td-abc123 --decision "Used JWT over sessions because stateless"

# Report blocker
td log td-abc123 --blocker "Missing API credentials for external service"
```

---

## Troubleshooting

### "TD CLI not installed"

```bash
# Check if td is in PATH
which td

# Install if missing (requires Go 1.21+)
go install github.com/marcus/td@latest

# Ensure Go bin is in PATH
export PATH="$PATH:$HOME/go/bin"
```

See [TD installation docs](https://marcus.github.io/td/docs/intro/) for detailed instructions.

### "TD not initialized in this project"

```bash
cd your-project
td init
```

### "TD issue not found"

```bash
# Verify issue exists
td list

# Check exact ID format
td show td-abc123 --json
```

### Worktree TD commands fail

Ensure `.td-root` file exists:

```bash
cat .td-root
# Should show path to main repo
```

If missing, ZeroShot may not have detected TD database. Check main repo has `.todos/issues.db`.

### Session conflicts

If getting "cannot close own implementation" errors:

```bash
# Submit for review instead of closing
td review td-abc123

# Another session (person) can then approve
td approve td-abc123
```

### Context not showing

```bash
# Verify issue has logs
td context td-abc123

# If empty, logs haven't been recorded
# Use td log to add context
td log td-abc123 "Starting work"
```

---

## Best Practices

### 1. Use Descriptive Issue Titles

TD issues should have clear, actionable titles:

```bash
# Good
td create "Add rate limiting to API endpoints" --type feature

# Bad
td create "Fix thing" --type task
```

### 2. Add Acceptance Criteria

```bash
td create "Implement user search" --type feature \
  --acceptance "- Searches by name and email
  - Returns paginated results
  - Handles empty queries gracefully"
```

### 3. Log Progress Regularly

```bash
td log td-abc123 "Completed user model"
td log td-abc123 "Working on API endpoints"
td log td-abc123 --decision "Using ElasticSearch for search performance"
```

### 4. Use Worktree for Non-Trivial Changes

```bash
# Simple typo fix - no isolation needed
zeroshot run td-abc123

# Feature implementation - use isolation
zeroshot run td-abc123 --worktree
```

### 5. Review Handoffs Before Continuing

```bash
# Check previous session's handoff
td usage

# Get full issue context
td context td-abc123
```

### 6. Use PR Mode for Team Reviews

```bash
# Creates PR and transitions to in_review
zeroshot run td-abc123 --pr

# Team reviews PR
# On merge, manually: td approve td-abc123
```

### 7. Minor Issues Can Self-Close

```bash
# Create as minor (allows self-close)
td create "Fix typo in README" --type chore --minor

# Ship mode can auto-close minor issues
zeroshot run td-abc123 --ship
```

---

## Command Reference

### ZeroShot Commands

| Command                                       | Description                  |
| --------------------------------------------- | ---------------------------- |
| `zeroshot run <td-id>`                        | Run agents on TD issue       |
| `zeroshot run <td-id> --worktree`             | With git worktree isolation  |
| `zeroshot run <td-id> --pr`                   | With PR creation             |
| `zeroshot run <td-id> --ship`                 | With PR + auto-merge         |
| `zeroshot run <td-id> --docker`               | With Docker isolation        |
| `zeroshot resume <id>`                        | Resume with fresh TD context |
| `zeroshot settings set defaultIssueSource td` | Default to TD for bare IDs   |

### TD Commands (in agents)

| Command                        | Description                           |
| ------------------------------ | ------------------------------------- |
| `td show <id>`                 | View issue details                    |
| `td start <id>`                | Begin work (sets implementer_session) |
| `td log <id> "msg"`            | Log progress                          |
| `td log <id> --decision "..."` | Log decision with reasoning           |
| `td log <id> --blocker "..."`  | Log blocker                           |
| `td handoff <id>`              | Prepare for context switch            |
| `td review <id>`               | Submit for review                     |
| `td usage`                     | Get current session context           |
| `td context <id>`              | Get full issue history                |

---

## Related Documentation

- [TD Official Site](https://marcus.github.io/td/) - TD marketing site and documentation
- [TD Getting Started](https://marcus.github.io/td/docs/intro/) - Installation and setup
- [Phase 1 Design: Core TD Integration](./td-integration-phase1.md)
- [Phase 2 Design: Advanced Features](./td-integration-phase2.md)
- [ZeroShot CLI Reference](../cli-reference.md)
- [Cluster Templates](../templates.md)
