# Phase 2: Advanced TD Integration for ZeroShot

## Executive Summary

Phase 2 builds on the Phase 1 TD provider foundation to add four advanced features:

1. **TD Session to Agent Mapping** - Each agent gets its own TD session for proper implementer/reviewer tracking
2. **TD Usage Context Injection** - Inject TD context into agents for continuity across context windows
3. **Intelligent Handoff Extraction** - Extract structured handoffs from agent conversation instead of static messages
4. **Cross-Provider Support** - TD for local task tracking + GitHub/GitLab for PRs

---

## Feature 1: TD Session to Agent Mapping

### Design Decision

Each ZeroShot agent should get its own TD session to enable:

- Proper tracking of who implemented vs who reviewed
- TD's enforcement that `reviewer_session != implementer_session`
- Clean audit trail per agent

### Architecture

```
Cluster Start
    │
    ├── Worker Agent ─────────► TD Session "ses_worker_abc123"
    │                           (implementer_session)
    │
    ├── Validator-1 Agent ────► TD Session "ses_validator1_abc123"
    │                           (reviewer_session - different from worker)
    │
    ├── Validator-2 Agent ────► TD Session "ses_validator2_abc123"
    │                           (can also be reviewer_session)
    │
    └── Conductor Agent ──────► TD Session "ses_conductor_abc123"
                                (orchestration, not impl/review)
```

### Data Flow

```
1. Cluster Start (orchestrator.js)
   │
   ├── Detect TD issue (TDProvider.fetchIssue)
   │
   ├── For each agent in cluster:
   │   └── Create TD session: `td usage --new-session --name "{agent.id}-{cluster.id}"`
   │   └── Store session ID in agent.tdSession
   │
   ├── For worker agents:
   │   └── Run: `td start <issue-id>` (sets implementer_session)
   │
   └── Inject session context into agent prompts

2. Agent Execution (agent-wrapper.js)
   │
   ├── Before task: Set TD_SESSION env var
   │   └── Export TD_SESSION={agent.tdSession}
   │
   └── Agent's td commands auto-use correct session

3. Validation (validator agent)
   │
   └── Run: `td approve <issue-id>` or `td review <issue-id>`
       (Uses validator's session, enforced different from implementer)
```

### Implementation Details

**New File: `src/td/session-manager.js`**

```javascript
/**
 * TD Session Manager
 * Creates and tracks TD sessions for ZeroShot agents
 */
class TDSessionManager {
  constructor() {
    this.sessions = new Map(); // agentId -> sessionId
  }

  /**
   * Create a named TD session for an agent
   * @param {string} agentId - Agent identifier
   * @param {string} clusterId - Cluster identifier
   * @returns {string} Session ID (ses_xxxxxx format)
   */
  async createSession(agentId, clusterId) {
    const sessionName = `${agentId}-${clusterId.slice(0, 8)}`;

    // td usage --new-session returns the new session ID
    const output = execSync(`td usage --new-session --name "${sessionName}"`, {
      encoding: 'utf8',
      timeout: 5000,
    });

    // Parse session ID from output (format: "Session: ses_abc123")
    const match = output.match(/Session:\s*(ses_[a-f0-9]+)/);
    const sessionId = match ? match[1] : null;

    if (sessionId) {
      this.sessions.set(agentId, sessionId);
    }

    return sessionId;
  }

  /**
   * Get session ID for an agent
   */
  getSession(agentId) {
    return this.sessions.get(agentId) || null;
  }

  /**
   * Get environment variables to inject for TD commands
   */
  getSessionEnv(agentId) {
    const sessionId = this.getSession(agentId);
    return sessionId ? { TD_SESSION: sessionId } : {};
  }
}
```

**Modifications to `src/orchestrator.js`**

```javascript
// In _startInternal(), after fetching TD issue:
if (cluster.issueProvider === 'td') {
  cluster.tdSessionManager = new TDSessionManager();

  // Create sessions for each agent
  for (const agentConfig of config.agents) {
    const sessionId = await cluster.tdSessionManager.createSession(agentConfig.id, clusterId);
    agentConfig.tdSession = sessionId;
  }

  // Auto-start the TD issue with worker session
  const workerAgent = config.agents.find((a) => a.role === 'implementation');
  if (workerAgent) {
    const workerSession = cluster.tdSessionManager.getSession(workerAgent.id);
    execSync(`TD_SESSION=${workerSession} td start ${inputData.tdMetadata.id}`, {
      encoding: 'utf8',
    });
  }
}
```

**Modifications to `src/agent/agent-task-executor.js`**

```javascript
// In spawnClaudeTask(), inject TD session into environment:
function buildTaskEnvironment(agent) {
  const env = { ...process.env };

  // Inject TD session if available
  if (agent.config.tdSession) {
    env.TD_SESSION = agent.config.tdSession;
  }

  return env;
}
```

### Role-Based Session Behavior

| Agent Role            | TD Session Behavior                                       |
| --------------------- | --------------------------------------------------------- |
| `conductor`           | Own session, logs classification decisions                |
| `implementation`      | Own session, becomes `implementer_session` on `td start`  |
| `validator`           | Own session (different from worker), can run `td approve` |
| `completion-detector` | Own session, handles final handoff                        |

---

## Feature 2: TD Usage Context Injection

### Design Decision

Inject TD context at multiple points to ensure agents have awareness of:

- Current focus issue
- Previous handoffs from other sessions
- Session-specific logs and decisions

### Injection Points

```
1. Cluster Start
   │
   ├── Inject full `td usage` output into ISSUE_OPENED message
   │   (Includes session, focus, recent handoffs)
   │
   └── Store as cluster.tdContext for later reference

2. Agent Spawn (dynamic agents from conductor)
   │
   └── Inject `td usage -q` into agent's contextStrategy
       (Quiet mode: less verbose after first read)

3. Cluster Resume
   │
   └── Inject full `td context <id>` for the issue
       (Full history including all logs and handoffs)

4. Multi-Issue Work Sessions
   │
   └── Use `td focus` to track primary issue
       Inject context for all related issues via `td tree`
```

### Data Flow

```
td usage (full output)
    │
    ├── Session Info
    │   └── "Current session: ses_abc123 (worker-cluster-xyz)"
    │
    ├── Focus
    │   └── "Focus: td-issue1 - Implement feature X"
    │
    ├── Recent Handoffs (from other sessions)
    │   └── "Handoff from ses_xyz (2h ago):
    │         Done: [...]
    │         Remaining: [...]"
    │
    └── Decision Log
        └── "Decisions:
              - Used approach A because...
              - Skipped B because..."
```

### Implementation Details

**Modifications to `src/issue-providers/td-provider.js`**

```javascript
async fetchIssue(identifier, settings) {
  const issueData = await this._fetchIssueData(identifier);

  // Get full TD context including usage information
  const usageContext = this._fetchUsageContext();
  const issueContext = this._fetchIssueContext(issueData.id);

  return {
    ...issueData,
    context: this._buildRichContext(issueData, usageContext, issueContext),
    tdMetadata: {
      ...issueData.tdMetadata,
      usageContext,
      issueContext
    }
  };
}

_fetchUsageContext() {
  try {
    return execSync('td usage', { encoding: 'utf8', timeout: 5000 });
  } catch {
    return null;
  }
}

_fetchIssueContext(issueId) {
  try {
    return execSync(`td context ${issueId}`, { encoding: 'utf8', timeout: 10000 });
  } catch {
    return null;
  }
}

_buildRichContext(issue, usage, context) {
  let output = `# TD Issue ${issue.id}\n\n`;
  output += `## Title\n${issue.title}\n\n`;
  output += `## Description\n${issue.description}\n\n`;

  // Add session context if available
  if (usage) {
    output += `## Current Session Context\n\`\`\`\n${usage}\n\`\`\`\n\n`;
  }

  // Add full issue context (logs, handoffs) if available
  if (context) {
    output += `## Issue History\n\`\`\`\n${context}\n\`\`\`\n\n`;
  }

  output += this._buildWorkflowCommands(issue.id);

  return output;
}
```

**Context Injection for Resume**

```javascript
// In orchestrator.js resume() method:
async resume(clusterId, prompt) {
  const cluster = this.clusters.get(clusterId);

  // If TD issue, inject fresh context
  if (cluster.issueProvider === 'td' && cluster.tdIssueId) {
    const tdContext = execSync(`td context ${cluster.tdIssueId}`, {
      encoding: 'utf8'
    });

    // Publish context refresh message
    cluster.messageBus.publish({
      cluster_id: clusterId,
      topic: 'TD_CONTEXT_REFRESH',
      sender: 'system',
      content: {
        text: tdContext,
        data: { issueId: cluster.tdIssueId }
      }
    });
  }

  // Continue with normal resume...
}
```

**Context Strategy Addition**

Add new context source type for TD context:

```json
{
  "contextStrategy": {
    "sources": [
      { "topic": "ISSUE_OPENED", "priority": "required" },
      { "topic": "TD_CONTEXT_REFRESH", "priority": "high", "strategy": "latest" }
    ]
  }
}
```

---

## Feature 3: Intelligent Handoff Extraction

### Design Decision

Instead of static "cluster completed" messages, extract structured handoff information from:

1. Agent tool calls (Write = done item, TODO in code = remaining)
2. Agent output summaries (completionStatus.nextSteps)
3. Agent logged decisions via `td log --decision`
4. Validation feedback (errors = remaining)

### Handoff Structure

```bash
td handoff <id> \
  --done "item1" --done "item2" \
  --remaining "item1" \
  --decision "choice because reason" \
  --uncertain "question"
```

### Extraction Sources

| Source                              | Extracts                      |
| ----------------------------------- | ----------------------------- |
| Write tool calls                    | Files modified → done items   |
| completionStatus.nextSteps          | Remaining work items          |
| td log --decision (in agent output) | Decisions made                |
| VALIDATION_RESULT.errors            | Issues to address (remaining) |
| Agent summary text                  | Done/remaining via NLP        |

### Data Flow

```
Cluster Complete
    │
    ├── Collect from Worker Agent
    │   ├── Output: completionStatus.blockers → remaining
    │   ├── Output: summary → done items
    │   └── Tool calls: Write operations → files modified
    │
    ├── Collect from Validators
    │   └── VALIDATION_RESULT.errors (if any rejected) → remaining
    │
    ├── Collect from Message Bus
    │   └── Query for td log messages → decisions, blockers
    │
    └── Generate Handoff Command
        td handoff {issue_id} \
          --done "Implemented X" \
          --done "Fixed Y" \
          --remaining "TODO: edge case Z" \
          --decision "Used approach A because..."
```

### Implementation Details

**New File: `src/td/handoff-extractor.js`**

```javascript
/**
 * Handoff Extractor
 * Extracts structured handoff information from agent conversation
 */
class HandoffExtractor {
  constructor(messageBus, clusterId) {
    this.messageBus = messageBus;
    this.clusterId = clusterId;
  }

  /**
   * Extract handoff data from cluster messages
   */
  async extract() {
    const done = [];
    const remaining = [];
    const decisions = [];
    const uncertain = [];

    // 1. Extract from IMPLEMENTATION_READY messages
    const implMessages = this.messageBus.query({
      cluster_id: this.clusterId,
      topic: 'IMPLEMENTATION_READY',
    });

    for (const msg of implMessages) {
      const summary = msg.content?.text;
      if (summary) {
        done.push(summary);
      }

      const status = msg.content?.data?.completionStatus;
      if (status?.nextSteps) {
        remaining.push(...status.nextSteps);
      }
      if (status?.blockers) {
        remaining.push(...status.blockers.map((b) => `BLOCKER: ${b}`));
      }
    }

    // 2. Extract from VALIDATION_RESULT messages
    const validationMessages = this.messageBus.query({
      cluster_id: this.clusterId,
      topic: 'VALIDATION_RESULT',
    });

    for (const msg of validationMessages) {
      const errors = msg.content?.data?.errors;
      if (errors && Array.isArray(errors)) {
        remaining.push(...errors.map((e) => `Validation issue: ${e}`));
      }
    }

    // 3. Extract from AGENT_OUTPUT for td log commands
    const outputMessages = this.messageBus.query({
      cluster_id: this.clusterId,
      topic: 'AGENT_OUTPUT',
    });

    for (const msg of outputMessages) {
      const text = msg.content?.text || '';

      // Look for td log --decision patterns
      const decisionMatch = text.match(/td log --decision\s+["']([^"']+)["']/g);
      if (decisionMatch) {
        decisions.push(
          ...decisionMatch.map((m) =>
            m.replace(/td log --decision\s+["']/, '').replace(/["']$/, '')
          )
        );
      }

      // Look for TODO comments in code
      const todoMatch = text.match(/TODO:?\s+(.+)/g);
      if (todoMatch) {
        remaining.push(...todoMatch);
      }
    }

    // 4. Deduplicate
    return {
      done: [...new Set(done)],
      remaining: [...new Set(remaining)],
      decisions: [...new Set(decisions)],
      uncertain: [...new Set(uncertain)],
    };
  }

  /**
   * Build td handoff command from extracted data
   */
  buildHandoffCommand(issueId, data) {
    const args = [];

    for (const item of data.done) {
      args.push(`--done "${this._escape(item)}"`);
    }
    for (const item of data.remaining) {
      args.push(`--remaining "${this._escape(item)}"`);
    }
    for (const item of data.decisions) {
      args.push(`--decision "${this._escape(item)}"`);
    }
    for (const item of data.uncertain) {
      args.push(`--uncertain "${this._escape(item)}"`);
    }

    return `td handoff ${issueId} ${args.join(' ')}`;
  }

  _escape(str) {
    return str.replace(/"/g, '\\"').replace(/\n/g, ' ');
  }
}
```

**Hook Integration in Orchestrator**

```javascript
// In _registerClusterCompletionHandlers():
this._subscribeToClusterTopic(messageBus, clusterId, 'CLUSTER_COMPLETE', async (message) => {
  // ... existing completion logging ...

  // Auto-handoff for TD issues
  if (cluster.issueProvider === 'td' && cluster.tdIssueId) {
    try {
      const extractor = new HandoffExtractor(messageBus, clusterId);
      const handoffData = await extractor.extract();
      const command = extractor.buildHandoffCommand(cluster.tdIssueId, handoffData);

      this._log(`[TD Handoff] Executing: ${command}`);
      execSync(command, { encoding: 'utf8', timeout: 10000 });
      this._log(`[TD Handoff] Successfully saved handoff state`);
    } catch (err) {
      console.error(`[TD Handoff] Failed: ${err.message}`);
    }
  }

  // Proceed with normal stop...
});
```

### Optional: LLM-Assisted Summarization

For richer handoffs, use a summarization prompt:

```javascript
async extractWithSummarization(provider) {
  const basicData = await this.extract();

  // Collect all agent outputs
  const outputs = this.messageBus.query({
    cluster_id: this.clusterId,
    topic: 'AGENT_OUTPUT'
  });

  const conversationText = outputs.map(o => o.content?.text).join('\n');

  // Summarize with small/fast model
  const prompt = `Summarize this agent conversation into:
1. DONE: What was completed
2. REMAINING: What still needs work
3. DECISIONS: Key choices made and why
4. QUESTIONS: Uncertainties or blockers

Conversation:
${conversationText.slice(-50000)}`;

  const summary = await provider.generate(prompt, { model: 'haiku' });

  // Parse structured output and merge with basic extraction
  return this._mergeWithBasicData(basicData, summary);
}
```

---

## Feature 4: Cross-Provider Support (TD + GitHub PR)

### Design Decision

Allow TD to manage local tasks while creating PRs on GitHub/GitLab:

- TD tracks the task locally (focus, logs, handoffs)
- Git remote determines where PR is created
- TD issue links to PR URL after creation

### Use Cases

```
Scenario 1: TD Issue + GitHub PR
├── td create "Implement feature X" → td-abc123
├── zeroshot run td-abc123 --pr
│   ├── Worker implements in worktree
│   ├── Validators check work
│   └── git-pusher creates GitHub PR
└── TD issue updated with PR URL

Scenario 2: TD Issue + GitLab MR
├── td create "Fix bug Y" → td-def456
├── zeroshot run td-def456 --ship
│   ├── Worker implements
│   └── git-pusher creates GitLab MR + auto-merge
└── TD issue marked complete with MR URL
```

### Data Flow

```
zeroshot run td-abc123 --pr
    │
    ├── TDProvider.fetchIssue(td-abc123)
    │   └── Returns issue data with tdMetadata
    │
    ├── Detect git platform (from git remote)
    │   └── github.com → platform = 'github'
    │
    ├── Set cluster flags:
    │   ├── cluster.issueProvider = 'td'
    │   ├── cluster.gitPlatform = 'github'
    │   └── cluster.autoPr = true
    │
    ├── Inject git-pusher agent (GitHub version)
    │
    ├── On PR_CREATED message:
    │   └── td log td-abc123 "PR: https://github.com/..."
    │
    └── On CLUSTER_COMPLETE:
        └── td review td-abc123 (or td close with --ship)
```

### Implementation Details

**Modifications to `src/orchestrator.js`**

```javascript
// In _applyAutoPrConfig():
_applyAutoPrConfig(config, inputData, options) {
  if (!options.autoPr) return;

  // Detect git platform (independent of issue provider)
  const { getPlatformForPR } = require('./issue-providers');
  const platform = getPlatformForPR(options.cwd);

  // Generate platform-specific git-pusher
  const gitPusherConfig = generateGitPusherAgent(platform);

  // For TD issues, modify git-pusher to NOT use "Closes #X" syntax
  // (TD issues use different ID format)
  if (inputData.tdMetadata) {
    gitPusherConfig.prompt = gitPusherConfig.prompt
      .replace(/Closes #\{\{issue_number\}\}/g, `TD: ${inputData.tdMetadata.id}`)
      .replace(/\{\{issue_number\}\}/g, inputData.tdMetadata.id)
      .replace(/\{\{issue_title\}\}/g, inputData.title);

    // Add TD-specific completion hook
    gitPusherConfig.hooks.onComplete.tdIssueId = inputData.tdMetadata.id;
  }

  config.agents.push(gitPusherConfig);
}
```

**TD Issue Update After PR Creation**

```javascript
// New subscription in orchestrator:
_registerPRCreatedHandler(messageBus, clusterId) {
  this._subscribeToClusterTopic(messageBus, clusterId, 'PR_CREATED', (message) => {
    const prUrl = message.content?.data?.pr_url || message.content?.data?.mr_url;
    const cluster = this.clusters.get(clusterId);

    if (cluster.issueProvider === 'td' && cluster.tdIssueId && prUrl) {
      // Log PR URL to TD issue
      execSync(`td log ${cluster.tdIssueId} "PR: ${prUrl}"`, {
        encoding: 'utf8',
        timeout: 5000
      });

      this._log(`[TD] Linked PR to issue: ${prUrl}`);
    }
  });
}
```

**`--ship` Mode with TD**

```javascript
// In completion handler:
if (cluster.autoPr && cluster.issueProvider === 'td') {
  const isShipMode = process.env.ZEROSHOT_SHIP === '1';

  if (isShipMode) {
    // Close TD issue on successful merge
    execSync(`td close ${cluster.tdIssueId}`, { encoding: 'utf8' });
  } else {
    // Submit for review on PR creation
    execSync(`td review ${cluster.tdIssueId}`, { encoding: 'utf8' });
  }
}
```

### Hybrid Detection Logic

```javascript
// In TDProvider.detectIdentifier():
static detectIdentifier(input, settings, gitContext) {
  // TD IDs: td-xxxx or xxxx (4+ hex chars)
  const isTdId = /^(td-)?[a-f0-9]{4,}$/i.test(input);

  if (isTdId) {
    // Check if TD database exists in CWD or git root
    return this._hasTdDatabase(process.cwd());
  }

  // If defaultIssueSource is 'td' and input looks like short ID
  if (settings.defaultIssueSource === 'td') {
    return /^[a-f0-9]{4,}$/i.test(input);
  }

  return false;
}
```

---

## File Modifications Summary

| File                                      | Changes                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `src/td/session-manager.js`               | **NEW** - TD session creation and tracking                              |
| `src/td/handoff-extractor.js`             | **NEW** - Extract structured handoffs from conversation                 |
| `src/issue-providers/td-provider.js`      | Add usage/context fetching, rich context building                       |
| `src/orchestrator.js`                     | Session creation, context injection, handoff hooks, PR_CREATED handling |
| `src/agent-wrapper.js`                    | Inject TD_SESSION env var                                               |
| `src/agent/agent-task-executor.js`        | Pass TD session to spawned processes                                    |
| `cluster-templates/base-templates/*.json` | Add TD_CONTEXT_REFRESH to contextStrategy                               |
| `tests/td-session-manager.test.js`        | **NEW** - Session management tests                                      |
| `tests/td-handoff-extractor.test.js`      | **NEW** - Handoff extraction tests                                      |
| `tests/td-cross-provider.test.js`         | **NEW** - TD + GitHub/GitLab integration tests                          |

---

## Integration Points with Phase 1

| Phase 1 Component           | Phase 2 Extension                              |
| --------------------------- | ---------------------------------------------- |
| TDProvider.fetchIssue()     | Add usage/context fetching                     |
| `.td-root` worktree support | Session-aware TD commands in worktrees         |
| Auto-start hook             | Assign implementer session                     |
| Auto-handoff hook           | Use HandoffExtractor instead of static message |
| Auto-review hook            | Use validator session for review               |

---

## Test Strategy

### Unit Tests

1. **Session Manager Tests**
   - Creates named sessions
   - Tracks session per agent
   - Provides correct env vars

2. **Handoff Extractor Tests**
   - Extracts done items from IMPLEMENTATION_READY
   - Extracts remaining from validation errors
   - Parses td log --decision from output
   - Builds correct td handoff command
   - Deduplicates items

3. **Cross-Provider Tests**
   - TD issue with GitHub PR creation
   - TD issue with GitLab MR creation
   - PR URL logged to TD issue
   - --ship mode closes TD issue

### Integration Tests

1. **Session Flow**
   - Worker gets implementer session
   - Validator gets different session
   - `td approve` works with validator session

2. **Context Injection**
   - Usage context in initial ISSUE_OPENED
   - Context refresh on resume
   - Quiet mode after first read

3. **End-to-End Handoff**
   - Cluster completes
   - Handoff extracted from conversation
   - TD handoff command executed
   - Data visible in `td context`

---

## Phased Implementation Order

### Phase 2.1: Session Management (2-3 days)

1. Create `src/td/session-manager.js`
2. Integrate into orchestrator
3. Inject session env into agents
4. Test session isolation

### Phase 2.2: Context Injection (2-3 days)

1. Extend TDProvider for usage/context
2. Add context refresh on resume
3. Update context strategies
4. Test continuity across windows

### Phase 2.3: Handoff Extraction (3-4 days)

1. Create `src/td/handoff-extractor.js`
2. Integrate into completion handler
3. Optional: LLM summarization
4. Test extraction quality

### Phase 2.4: Cross-Provider (2-3 days)

1. Modify git-pusher for TD issues
2. Add PR_CREATED handler
3. Handle --ship mode
4. Test TD + GitHub/GitLab flows

**Total Estimate: 9-13 days**

---

## Related Documents

- [Phase 1: Core TD Integration](./td-integration-phase1.md) - Basic provider, worktree support, lifecycle hooks
