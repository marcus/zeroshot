/**
 * Test: TDProvider - TD issue provider
 *
 * Unit tests for TDProvider class in src/issue-providers/td-provider.js
 */

const assert = require('assert');
const TDProvider = require('../../src/issue-providers/td-provider');

describe('TDProvider', function () {
  describe('static properties', function () {
    it('has correct id', function () {
      assert.strictEqual(TDProvider.id, 'td');
    });

    it('has correct displayName', function () {
      assert.strictEqual(TDProvider.displayName, 'TD (Task Daemon)');
    });

    it('does not support PR', function () {
      assert.strictEqual(TDProvider.supportsPR(), false);
    });

    it('getPRTool returns null', function () {
      assert.strictEqual(TDProvider.getPRTool(), null);
    });
  });

  describe('detectIdentifier', function () {
    it('detects full TD ID format (td-xxxx)', function () {
      assert.strictEqual(TDProvider.detectIdentifier('td-abc123', {}), true);
      assert.strictEqual(TDProvider.detectIdentifier('td-12345678', {}), true);
      assert.strictEqual(TDProvider.detectIdentifier('td-a', {}), true);
    });

    it('is case insensitive for td- prefix', function () {
      assert.strictEqual(TDProvider.detectIdentifier('TD-ABC123', {}), true);
      assert.strictEqual(TDProvider.detectIdentifier('Td-AbC123', {}), true);
    });

    it('detects bare hex when TD is default source', function () {
      const settings = { defaultIssueSource: 'td' };
      assert.strictEqual(TDProvider.detectIdentifier('abc123', settings), true);
      assert.strictEqual(TDProvider.detectIdentifier('1234abcd', settings), true);
      assert.strictEqual(TDProvider.detectIdentifier('fedcba', settings), true);
    });

    it('rejects bare hex when TD is not default', function () {
      assert.strictEqual(TDProvider.detectIdentifier('abc123', {}), false);
      assert.strictEqual(
        TDProvider.detectIdentifier('abc123', { defaultIssueSource: 'github' }),
        false
      );
    });

    it('rejects bare hex shorter than 6 chars', function () {
      const settings = { defaultIssueSource: 'td' };
      assert.strictEqual(TDProvider.detectIdentifier('abc', settings), false);
      assert.strictEqual(TDProvider.detectIdentifier('12345', settings), false);
    });

    it('rejects bare decimal numbers', function () {
      // Decimal numbers without hex chars are not valid TD IDs
      assert.strictEqual(TDProvider.detectIdentifier('123456', {}), false);
      // Even with defaultIssueSource=td, pure decimals less than 6 chars rejected
      assert.strictEqual(TDProvider.detectIdentifier('123', { defaultIssueSource: 'td' }), false);
    });

    it('rejects GitHub formats', function () {
      assert.strictEqual(TDProvider.detectIdentifier('org/repo#123', {}), false);
      assert.strictEqual(
        TDProvider.detectIdentifier('https://github.com/org/repo/issues/123', {}),
        false
      );
    });

    it('rejects Jira formats', function () {
      assert.strictEqual(TDProvider.detectIdentifier('PROJ-123', {}), false);
    });
  });

  describe('getRequiredTool', function () {
    it('returns td CLI info', function () {
      const tool = TDProvider.getRequiredTool();
      assert.strictEqual(tool.name, 'td');
      assert.strictEqual(tool.checkCmd, 'td --version');
      assert.strictEqual(typeof tool.installHint, 'string');
    });
  });

  describe('checkAuth', function () {
    // Note: These tests check return format, not actual CLI availability
    it('returns auth result object with expected properties', function () {
      const result = TDProvider.checkAuth();
      assert.strictEqual(typeof result.authenticated, 'boolean');
      assert.ok('error' in result);
      assert.ok(Array.isArray(result.recovery));
    });

    it('only checks CLI availability, not project init', function () {
      // checkAuth should pass even from a directory without .todos/
      const result = TDProvider.checkAuth('/tmp');
      // If td CLI is installed, should be authenticated
      // (We can't guarantee td is installed in CI, so just check format)
      assert.strictEqual(typeof result.authenticated, 'boolean');
    });
  });

  describe('validateIssue', function () {
    // Helper to check if td CLI is installed
    const isTdInstalled = (() => {
      try {
        require('child_process').execSync('td --version', { stdio: 'pipe' });
        return true;
      } catch {
        return false;
      }
    })();

    it('returns validation result object with expected properties', function () {
      // Test with a fake issue ID - will fail but should return proper format
      const result = TDProvider.validateIssue('td-000000', '/tmp');
      assert.strictEqual(typeof result.valid, 'boolean');
      assert.ok('error' in result);
      assert.ok(Array.isArray(result.recovery));
    });

    it('normalizes issue ID before validation', function () {
      // Both formats should be handled
      const result1 = TDProvider.validateIssue('td-abc123', '/tmp');
      const result2 = TDProvider.validateIssue('abc123', '/tmp');
      // Both should have same format (may fail if issue doesn't exist, that's ok)
      assert.strictEqual(typeof result1.valid, 'boolean');
      assert.strictEqual(typeof result2.valid, 'boolean');
    });

    it('detects TD CLI not installed error', function () {
      if (isTdInstalled) {
        this.skip(); // Skip if td is installed - can't test this path
      }
      const result = TDProvider.validateIssue('td-abc123', '/tmp');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error.includes('not installed'));
      assert.ok(result.recovery.some((r) => r.includes('Install td')));
    });

    it('detects TD not initialized error', function () {
      if (!isTdInstalled) {
        this.skip(); // Skip if td isn't installed - can't test TD-specific errors
      }
      // /tmp won't have .todos/
      const result = TDProvider.validateIssue('td-abc123', '/tmp');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error.includes('not initialized'));
      assert.ok(result.recovery.some((r) => r.includes('td init')));
    });
  });

  describe('_normalizeIssueId', function () {
    let provider;
    beforeEach(function () {
      provider = new TDProvider();
    });

    it('adds td- prefix when missing', function () {
      assert.strictEqual(provider._normalizeIssueId('abc123'), 'td-abc123');
    });

    it('preserves td- prefix', function () {
      assert.strictEqual(provider._normalizeIssueId('td-abc123'), 'td-abc123');
    });

    it('normalizes to lowercase', function () {
      assert.strictEqual(provider._normalizeIssueId('TD-ABC123'), 'td-abc123');
      assert.strictEqual(provider._normalizeIssueId('ABC123'), 'td-abc123');
    });

    it('handles mixed case', function () {
      assert.strictEqual(provider._normalizeIssueId('Td-AbC123'), 'td-abc123');
    });
  });

  describe('_parseIssue', function () {
    let provider;
    beforeEach(function () {
      provider = new TDProvider();
    });

    it('maps TD JSON to InputData format', function () {
      const result = provider._parseIssue({
        id: 'td-abc123',
        title: 'Test issue',
        description: 'Description here',
        status: 'open',
        type: 'feature',
        priority: 'P1',
        labels: ['api', 'backend'],
        acceptance: 'Must pass all tests',
      });

      assert.strictEqual(result.title, 'Test issue');
      assert.strictEqual(result.body, 'Description here');
      assert.deepStrictEqual(result.labels, [{ name: 'api' }, { name: 'backend' }]);
      assert.strictEqual(result.url, null);
      assert.deepStrictEqual(result.comments, []);
    });

    it('computes number from hex ID', function () {
      const result = provider._parseIssue({
        id: 'td-abc123',
        title: 'Test',
        status: 'open',
        type: 'task',
        priority: 'P2',
      });

      // abc123 parsed as hex = 11256099
      assert.strictEqual(result.number, parseInt('abc123', 16));
    });

    it('includes TD workflow commands in context', function () {
      const result = provider._parseIssue({
        id: 'td-abc123',
        title: 'Test',
        status: 'open',
        type: 'task',
        priority: 'P1',
      });

      assert.ok(result.context.includes('td log'));
      assert.ok(result.context.includes('td handoff td-abc123'));
      assert.ok(result.context.includes('td review td-abc123'));
    });

    it('includes title and status in context', function () {
      const result = provider._parseIssue({
        id: 'td-abc123',
        title: 'Test Title',
        status: 'in_progress',
        type: 'bug',
        priority: 'P0',
      });

      assert.ok(result.context.includes('Test Title'));
      assert.ok(result.context.includes('in_progress'));
      assert.ok(result.context.includes('bug'));
      assert.ok(result.context.includes('P0'));
    });

    it('includes acceptance criteria in context when present', function () {
      const result = provider._parseIssue({
        id: 'td-abc123',
        title: 'Test',
        status: 'open',
        type: 'task',
        priority: 'P1',
        acceptance: 'Must pass all tests',
      });

      assert.ok(result.context.includes('Acceptance Criteria'));
      assert.ok(result.context.includes('Must pass all tests'));
    });

    it('includes labels in context when present', function () {
      const result = provider._parseIssue({
        id: 'td-abc123',
        title: 'Test',
        status: 'open',
        type: 'task',
        priority: 'P1',
        labels: ['api', 'backend'],
      });

      assert.ok(result.context.includes('Labels'));
      assert.ok(result.context.includes('- api'));
      assert.ok(result.context.includes('- backend'));
    });

    it('includes tdMetadata for lifecycle hooks', function () {
      const result = provider._parseIssue({
        id: 'td-abc123',
        title: 'Test',
        status: 'in_progress',
        type: 'bug',
        priority: 'P0',
        acceptance: 'Fix the bug',
        points: 5,
        parent_id: 'td-parent',
        minor: true,
      });

      assert.strictEqual(result.tdMetadata.id, 'td-abc123');
      assert.strictEqual(result.tdMetadata.status, 'in_progress');
      assert.strictEqual(result.tdMetadata.type, 'bug');
      assert.strictEqual(result.tdMetadata.priority, 'P0');
      assert.strictEqual(result.tdMetadata.acceptance, 'Fix the bug');
      assert.strictEqual(result.tdMetadata.points, 5);
      assert.strictEqual(result.tdMetadata.parentId, 'td-parent');
      assert.strictEqual(result.tdMetadata.minor, true);
    });

    it('handles missing optional fields with defaults', function () {
      const result = provider._parseIssue({
        id: 'td-abc123',
        title: 'Minimal issue',
      });

      assert.strictEqual(result.title, 'Minimal issue');
      assert.strictEqual(result.body, '');
      assert.deepStrictEqual(result.labels, []);
      assert.strictEqual(result.tdMetadata.status, 'open');
      assert.strictEqual(result.tdMetadata.type, 'task');
      assert.strictEqual(result.tdMetadata.priority, 'P2');
      assert.strictEqual(result.tdMetadata.points, 0);
      assert.strictEqual(result.tdMetadata.parentId, null);
      assert.strictEqual(result.tdMetadata.minor, false);
    });

    it('includes points in context when non-zero', function () {
      const result = provider._parseIssue({
        id: 'td-abc123',
        title: 'Test',
        status: 'open',
        type: 'task',
        priority: 'P1',
        points: 5,
      });

      assert.ok(result.context.includes('5 pts'));
    });

    it('includes self-service context retrieval instructions', function () {
      const result = provider._parseIssue({
        id: 'td-abc123',
        title: 'Test',
        status: 'open',
        type: 'task',
        priority: 'P1',
      });

      // Check for "How to Get TD Context" section
      assert.ok(result.context.includes('## How to Get TD Context'));
      assert.ok(result.context.includes('td show td-abc123'));
      assert.ok(result.context.includes('td context td-abc123'));
      assert.ok(result.context.includes('td usage -q'));
    });

    it('has properly grouped TD workflow commands', function () {
      const result = provider._parseIssue({
        id: 'td-abc123',
        title: 'Test',
        status: 'open',
        type: 'task',
        priority: 'P1',
      });

      // Check for grouped workflow commands
      assert.ok(result.context.includes('**Track your progress:**'));
      assert.ok(result.context.includes('**When complete:**'));
    });

    it('interpolates issue ID into all relevant commands', function () {
      const result = provider._parseIssue({
        id: 'td-custom99',
        title: 'Test',
        status: 'open',
        type: 'task',
        priority: 'P1',
      });

      // Verify issue ID is interpolated (not a placeholder)
      assert.ok(result.context.includes('td show td-custom99'));
      assert.ok(result.context.includes('td context td-custom99'));
      assert.ok(result.context.includes('td handoff td-custom99'));
      assert.ok(result.context.includes('td review td-custom99'));
      // Should NOT contain placeholder text
      assert.ok(!result.context.includes('${id}'));
      assert.ok(!result.context.includes('<id>'));
    });
  });
});
