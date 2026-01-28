/**
 * TD Provider - Fetch issues from TD (Task Daemon) via CLI
 * TD is a local-only issue tracker, no PR support.
 */

const IssueProvider = require('./base-provider');
const { execSync } = require('../lib/safe-exec');

class TDProvider extends IssueProvider {
  static id = 'td';
  static displayName = 'TD (Task Daemon)';

  // TD is local-only, no PR support
  static supportsPR() {
    return false;
  }

  static getPRTool() {
    return null;
  }

  /**
   * Detect TD issue identifiers
   * Matches:
   * - td-xxxxxx format (TD issue IDs)
   * - Bare hex strings that look like TD IDs
   *
   * @param {string} input - Issue identifier
   * @param {Object} settings - User settings
   * @param {Object|null} gitContext - Git context (unused, TD is local)
   * @returns {boolean}
   */
  static detectIdentifier(input, settings, _gitContext = null) {
    // TD issue ID format: td-xxxxxx (lowercase hex)
    if (/^td-[a-f0-9]+$/i.test(input)) {
      return true;
    }

    // Bare hex that looks like a TD ID (6+ hex chars)
    if (/^[a-f0-9]{6,}$/i.test(input) && settings.defaultIssueSource === 'td') {
      return true;
    }

    return false;
  }

  static getRequiredTool() {
    return {
      name: 'td',
      checkCmd: 'td --version',
      installHint: 'Install td: npm install -g @anthropic/td (or use local version)',
    };
  }

  /**
   * Check td CLI availability
   * TD uses local SQLite database, no external auth needed.
   * @param {string} _cwd - Working directory (unused - CLI check is global)
   */
  static checkAuth(_cwd = process.cwd()) {
    // Only check CLI is installed
    try {
      execSync('td --version', { encoding: 'utf8', stdio: 'pipe', timeout: 2000 });
      return { authenticated: true, error: null, recovery: [] };
    } catch (err) {
      const stderr = err.stderr || err.message || '';

      if (err.code === 'ENOENT' || stderr.includes('command not found')) {
        return {
          authenticated: false,
          error: 'TD CLI not installed',
          recovery: ['Install td CLI', 'Then verify: td --version'],
        };
      }

      // CLI exists but errored for some other reason - treat as installed
      return { authenticated: true, error: null, recovery: [] };
    }
  }

  /**
   * Validate that a TD issue exists and is accessible
   * Called during preflight to give early, clear errors
   * @param {string} identifier - TD issue ID
   * @param {string} cwd - Working directory
   * @returns {{ valid: boolean, error: string|null, recovery: string[] }}
   */
  static validateIssue(identifier, cwd = process.cwd()) {
    // Normalize the ID
    const issueId = /^td-/i.test(identifier)
      ? identifier.toLowerCase()
      : `td-${identifier.toLowerCase()}`;

    try {
      // Try to show the issue - this validates both TD init and issue existence
      execSync(`td show ${issueId}`, {
        encoding: 'utf8',
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });
      return { valid: true, error: null, recovery: [] };
    } catch (err) {
      const stderr = err.stderr || err.message || '';

      // Check for CLI not installed first (before other "not found" checks)
      if (err.code === 'ENOENT' || stderr.includes('command not found')) {
        return {
          valid: false,
          error: 'TD CLI not installed',
          recovery: ['Install td CLI', 'Then verify: td --version'],
        };
      }

      // Check for project not initialized
      if (
        stderr.includes('not initialized') ||
        stderr.includes('no .todos') ||
        stderr.includes('database not found')
      ) {
        return {
          valid: false,
          error: `TD not initialized in ${cwd}`,
          recovery: [
            'Initialize TD in this project: td init',
            'Or run from a directory with TD initialized',
            'Or create .td-root file pointing to main repo for worktrees',
          ],
        };
      }

      // Check for issue not found (use specific pattern to avoid matching "command not found")
      if (stderr.includes('issue not found') || stderr.includes('No issue')) {
        return {
          valid: false,
          error: `TD issue not found: ${issueId}`,
          recovery: [
            `Verify issue exists: td show ${issueId}`,
            'Check you are in the correct project directory',
            'List available issues: td list',
          ],
        };
      }

      // Generic error
      return {
        valid: false,
        error: `Cannot access TD issue ${issueId}: ${stderr.trim() || err.message}`,
        recovery: ['Check td CLI is working: td list', 'Verify issue ID is correct'],
      };
    }
  }

  /**
   * Fetch issue from TD via CLI
   * @param {string} identifier - TD issue ID (td-xxxxxx or bare hex)
   * @param {Object} _settings - User settings (unused)
   * @param {Object} options - Options including cwd for worktree support
   * @returns {Promise<Object>} InputData object
   */
  fetchIssue(identifier, _settings, options = {}) {
    const cwd = options.cwd || process.cwd();
    const issueId = this._normalizeIssueId(identifier);

    try {
      const cmd = `td show ${issueId} --json`;
      const output = execSync(cmd, {
        encoding: 'utf8',
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const issue = JSON.parse(output);

      // Fetch additional context
      const usageContext = this._fetchUsageContext(cwd);
      const issueContext = this._fetchIssueContext(issueId, cwd);

      return this._parseIssue(issue, usageContext, issueContext);
    } catch (error) {
      if (error.message.includes('not found')) {
        throw new Error(`TD issue not found: ${issueId}`);
      }
      throw new Error(`Failed to fetch TD issue: ${error.message}`);
    }
  }

  /**
   * Fetch current TD session usage context
   * @private
   */
  _fetchUsageContext(cwd) {
    try {
      return execSync('td usage -q', {
        encoding: 'utf8',
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });
    } catch {
      return null;
    }
  }

  /**
   * Fetch issue history/context from TD
   * @private
   */
  _fetchIssueContext(issueId, cwd) {
    try {
      return execSync(`td context ${issueId}`, {
        encoding: 'utf8',
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      });
    } catch {
      return null;
    }
  }

  /**
   * Normalize issue ID to lowercase with td- prefix
   * @private
   */
  _normalizeIssueId(identifier) {
    // If already has td- prefix, return as-is (lowercase)
    if (/^td-/i.test(identifier)) {
      return identifier.toLowerCase();
    }
    // Otherwise add td- prefix
    return `td-${identifier.toLowerCase()}`;
  }

  /**
   * Parse TD issue into standardized InputData format
   * @private
   */
  _parseIssue(issue, usageContext = null, issueContext = null) {
    const id = issue.id;
    const title = issue.title || '';
    const description = issue.description || '';
    const labels = issue.labels || [];
    const acceptance = issue.acceptance || '';
    const status = issue.status || 'open';
    const type = issue.type || 'task';
    const priority = issue.priority || 'P2';
    const points = issue.points || 0;

    // Build rich context for agents
    let context = `# TD Issue ${id}\n\n`;
    context += `## Title\n${title}\n\n`;
    context += `## Status\n${status} | ${type} | ${priority}`;
    if (points > 0) {
      context += ` | ${points} pts`;
    }
    context += '\n\n';

    if (description) {
      context += `## Description\n${description}\n\n`;
    }

    if (acceptance) {
      context += `## Acceptance Criteria\n${acceptance}\n\n`;
    }

    if (labels.length > 0) {
      context += `## Labels\n`;
      context += labels.map((l) => `- ${l}`).join('\n');
      context += '\n\n';
    }

    // Include session context if available
    if (usageContext) {
      context += `## Session Context\n`;
      context += '```\n';
      context += usageContext.trim();
      context += '\n```\n\n';
    }

    // Include issue history if available
    if (issueContext) {
      context += `## Issue History\n`;
      context += '```\n';
      context += issueContext.trim();
      context += '\n```\n\n';
    }

    // Self-service context retrieval instructions
    context += `## How to Get TD Context\n\n`;
    context += `Issue: \`${id}\`\n\n`;
    context += `**Get full issue details:**\n`;
    context += '```bash\n';
    context += `td show ${id}\n`;
    context += '```\n\n';
    context += `**Get issue history and previous work:**\n`;
    context += '```bash\n';
    context += `td context ${id}\n`;
    context += '```\n\n';
    context += `**Check current session status:**\n`;
    context += '```bash\n';
    context += `td usage -q\n`;
    context += '```\n\n';

    // TD workflow commands for agents (grouped by purpose)
    context += `## TD Workflow Commands\n\n`;
    context += `**Track your progress:**\n`;
    context += `- \`td log "message"\` - Log progress updates\n`;
    context += `- \`td log --decision "choice because reason"\` - Record decisions with rationale\n`;
    context += `- \`td log --blocker "issue"\` - Report blockers\n\n`;
    context += `**When complete:**\n`;
    context += `- \`td handoff ${id} --done "..." --remaining "..."\` - Prepare handoff for next session\n`;
    context += `- \`td review ${id}\` - Submit for review\n\n`;

    // Map labels to GitHub format
    const mappedLabels = labels.map((name) => ({ name }));

    // Extract numeric portion from ID for number field
    const numberMatch = id.match(/td-([a-f0-9]+)/i);
    const hexPart = numberMatch ? numberMatch[1] : null;
    // Convert first 8 hex chars to number (for compatibility)
    const number = hexPart ? parseInt(hexPart.slice(0, 8), 16) : null;

    return {
      number,
      title,
      body: description,
      labels: mappedLabels,
      comments: [], // TD doesn't have comments in same format
      url: null, // TD is local-only
      context,
      // Extra TD-specific fields for agent context
      tdMetadata: {
        id,
        status,
        type,
        priority,
        points,
        acceptance,
        parentId: issue.parent_id || null,
        minor: issue.minor || false,
        usageContext: usageContext || null,
        issueContext: issueContext || null,
      },
    };
  }
}

module.exports = TDProvider;
