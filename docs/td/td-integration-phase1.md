# Plan: TD as Task Management Backend for ZeroShot

## Overview

Integrate TD (`~/code/td`) as a full-featured issue provider for ZeroShot, enabling multi-agent workflows to run against locally-managed TD tasks with full awareness of project context, worktrees, and TD's complete command set.

---

## Phase 1: Core TD Provider Implementation

### 1.1 Create `src/issue-providers/td-provider.js`

```javascript
class TDProvider extends IssueProvider {
  static id = 'td';
  static displayName = 'TD (Task Daemon)';
  static supportsPR() {
    return false;
  } // TD is local-only
}
```

**Key Methods:**

| Method               | Purpose                               |
| -------------------- | ------------------------------------- |
| `detectIdentifier()` | Match `td-xxxx` IDs, short hex forms  |
| `getRequiredTool()`  | Return `td` CLI info                  |
| `checkAuth()`        | Verify `.todos/` or `.td-root` exists |
| `fetchIssue()`       | Call `td show <id> --json`            |
| `_parseIssue()`      | Map TD JSON → InputData format        |

**Input Detection Logic:**

- Full TD ID: `td-abc1`, `td-1234` (4+ hex chars)
- Short form: `abc1` when `defaultIssueSource: 'td'`
- **NOT** bare numbers (TD uses hex IDs, not sequential)

### 1.2 Register Provider

**Modify `src/issue-providers/index.js`:**

```javascript
const TDProvider = require('./td-provider');
registerProvider(TDProvider);
```

**Modify `lib/settings.js`:**
Add `'td'` to valid `defaultIssueSource` values.

---

## Phase 2: Worktree Integration

### 2.1 Create `.td-root` in Worktrees

TD supports worktrees via `.td-root` file pointing to main repo's `.todos/` directory.

**Extend `IsolationManager.createWorktree()` (~line 1304):**

```javascript
// After worktree creation, add TD support
if (this._hasTdDatabase(repoRoot)) {
  const tdRootPath = path.join(worktreePath, '.td-root');
  fs.writeFileSync(tdRootPath, repoRoot);
  console.log(`[IsolationManager] Created .td-root for TD database access`);
}

_hasTdDatabase(dir) {
  return fs.existsSync(path.join(dir, '.todos', 'issues.db'));
}
```

This ensures TD commands work correctly in ZeroShot worktrees.

### 2.2 Docker Mode Support

**Add `td` mount preset to `lib/docker-config.js`:**

```javascript
td: {
  host: '${CWD}/.todos',
  container: '/workspace/.todos',
  readonly: false  // TD needs write access for logging
}
```

---

## Phase 3: Rich Context for Agents

### 3.1 InputData Context with TD Workflow Commands

The `_parseIssue()` method will build a rich context including:

```markdown
# TD Issue td-abc1

## Title

Implement feature X

## Description

...

## Metadata

- **Status**: in_progress
- **Type**: feature
- **Priority**: P1

## TD Workflow Commands

Use these commands to track progress:

- `td log "message"` - Log progress updates
- `td log --decision "choice because reason"` - Record decisions
- `td log --blocker "issue description"` - Report blockers
- `td handoff td-abc1 --done "..." --remaining "..."` - Prepare handoff
- `td review td-abc1` - Submit for review when complete

## Current Session Context

Run `td usage` to see full session context including handoffs.
```

### 3.2 TD Metadata Passthrough

Include TD-specific metadata in the returned InputData:

```javascript
return {
  number: null, // TD uses string IDs
  title,
  body,
  labels,
  comments,
  url: null,
  context,
  tdMetadata: { id, status, type, priority, acceptance },
};
```

---

## Phase 4: TD CLI Integration

### 4.1 TD CLI Interface (Verified ✓)

**Command:** `td show <id> --json`

**JSON Output Format:**

```json
{
  "id": "td-abc123",
  "title": "Issue title",
  "description": "Full description",
  "status": "open|in_progress|in_review|blocked|closed",
  "type": "task|feature|bug|chore",
  "priority": "P0|P1|P2|P3",
  "labels": ["label1", "label2"],
  "acceptance": "Acceptance criteria",
  "points": 3,
  "minor": false,
  "parent_id": "",
  "implementer_session": "ses_xxx",
  "reviewer_session": "ses_yyy",
  "created_at": "2026-01-27T...",
  "updated_at": "2026-01-27T..."
}
```

### 4.2 TD Commands Reference (for agents)

| Command                   | Purpose                     |
| ------------------------- | --------------------------- |
| `td show <id>`            | View issue details          |
| `td start <id>`           | Begin work on issue         |
| `td log "msg"`            | Log progress                |
| `td log --decision "..."` | Log decisions               |
| `td log --blocker "..."`  | Log blockers                |
| `td handoff <id>`         | Prepare for context switch  |
| `td review <id>`          | Submit for review           |
| `td approve <id>`         | Approve (different session) |
| `td usage`                | Get AI context block        |
| `td usage --new-session`  | Start new session           |

---

## Phase 5: TD Lifecycle Integration

### 5.1 Auto-Start on Cluster Begin

When a cluster starts with a TD issue, automatically run:

```bash
td start <issue-id>
```

**Implementation:** Add hook in `orchestrator.js` after issue fetch when provider is `td`.

### 5.2 Auto-Handoff on Cluster Complete

When a cluster completes successfully, capture handoff state:

```bash
td handoff <issue-id> --done "..." --remaining "..."
```

**Implementation:**

- Add `onClusterComplete` hook in orchestrator
- Extract done/remaining from agent conversation or final state
- Could use a summary prompt or structured output

### 5.3 Auto-Review on PR Creation

When using `--pr` or `--ship` flags, submit TD issue for review:

```bash
td review <issue-id>
```

**Implementation:** Add hook after PR creation succeeds in `createPR()` or cluster completion path.

---

## Files to Modify

| File                                    | Changes                                       |
| --------------------------------------- | --------------------------------------------- |
| `src/issue-providers/td-provider.js`    | **NEW** - Core provider                       |
| `src/issue-providers/index.js`          | Register TDProvider                           |
| `lib/settings.js`                       | Add 'td' to valid sources                     |
| `src/isolation-manager.js`              | Create `.td-root` in worktrees                |
| `lib/docker-config.js`                  | Add `td` mount preset                         |
| `src/orchestrator.js`                   | Add TD lifecycle hooks (start/handoff/review) |
| `tests/td-provider.test.js`             | **NEW** - Unit tests                          |
| `tests/integration/td-worktree.test.js` | **NEW** - Integration tests                   |

---

## Test Plan

### Unit Tests (`tests/td-provider.test.js`)

1. **Detection Tests:**
   - Detects full TD IDs (`td-abc1`, `td-1234`)
   - Detects short form when `defaultIssueSource: 'td'`
   - Rejects bare numbers (TD uses hex)
   - Rejects GitHub/GitLab formats

2. **Normalization Tests:**
   - Adds `td-` prefix when missing
   - Preserves existing prefix
   - Normalizes to lowercase

3. **Parse Tests:**
   - Maps TD JSON to InputData correctly
   - Includes TD workflow commands in context
   - Handles missing optional fields

### Integration Tests (`tests/integration/td-worktree.test.js`)

1. Creates `.td-root` in worktrees pointing to main repo
2. TD commands work via `.td-root` redirection
3. ZeroShot can fetch issues in worktree mode

---

## Implementation Order

1. ~~**Verify TD CLI interface**~~ ✓ Done - `td show --json` works
2. **Create TDProvider class** - Core detection and fetch logic
3. **Register in index.js** - Add to provider registry
4. **Update settings.js** - Allow 'td' as issue source
5. **Extend IsolationManager** - Add `.td-root` creation for worktrees
6. **Add docker mount preset** - Support `--docker` mode
7. **Add TD lifecycle hooks** - Auto-start, auto-handoff, auto-review in orchestrator
8. **Write tests** - Unit and integration
9. **Manual verification** - End-to-end test

---

## TD Tasks (in TD itself)

See `td tree td-dcfc85` for the complete task breakdown with:

- 4 phase epics
- 17 detailed implementation tasks
- Dependencies and acceptance criteria
- ~52 story points total

---

## Related Documents

- [Phase 2: Advanced TD Integration](./td-integration-phase2.md) - Session mapping, intelligent handoffs, cross-provider support
