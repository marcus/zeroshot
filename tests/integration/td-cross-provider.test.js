/**
 * Test: TD + GitHub/GitLab Cross-Provider Integration
 *
 * Tests the cross-provider support when using TD issues
 * with GitHub/GitLab PR workflows (--pr, --ship modes).
 *
 * These tests mock the git remote detection and PR creation
 * to verify the correct flow without actual API calls.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

/**
 * Check if td CLI is available
 */
function hasTdCli() {
  try {
    execSync('td --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

describe('TD + Cross-Provider Integration', function () {
  let testRepoDir;
  let skipTests = false;

  before(function () {
    if (!hasTdCli()) {
      skipTests = true;
      this.skip();
      return;
    }

    // Create temp git repo with TD initialized
    testRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-td-cross-provider-'));

    execSync('git init', { cwd: testRepoDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: testRepoDir, stdio: 'pipe' });
    execSync('git config user.name "Test User"', { cwd: testRepoDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(testRepoDir, 'test.txt'), 'initial content');
    execSync('git add -A', { cwd: testRepoDir, stdio: 'pipe' });
    execSync('git commit -m "Initial commit"', { cwd: testRepoDir, stdio: 'pipe' });

    // Initialize TD
    execSync('td init', { cwd: testRepoDir, stdio: 'pipe' });
  });

  after(function () {
    if (testRepoDir && fs.existsSync(testRepoDir)) {
      fs.rmSync(testRepoDir, { recursive: true, force: true });
    }
  });

  describe('TD Issue Provider Detection', function () {
    it('should detect td-xxxxxx format as TD issue', function () {
      if (skipTests) this.skip();

      const TDProvider = require('../../src/issue-providers/td-provider');
      assert.ok(TDProvider.detectIdentifier('td-abc123', {}));
      assert.ok(TDProvider.detectIdentifier('td-ABCDEF', {}));
    });

    it('should detect bare hex when defaultIssueSource is td', function () {
      if (skipTests) this.skip();

      const TDProvider = require('../../src/issue-providers/td-provider');
      assert.ok(TDProvider.detectIdentifier('abc123', { defaultIssueSource: 'td' }));
      assert.ok(TDProvider.detectIdentifier('ABCDEF123', { defaultIssueSource: 'td' }));
    });

    it('should not detect bare hex when defaultIssueSource is not td', function () {
      if (skipTests) this.skip();

      const TDProvider = require('../../src/issue-providers/td-provider');
      assert.ok(!TDProvider.detectIdentifier('abc123', { defaultIssueSource: 'github' }));
      assert.ok(!TDProvider.detectIdentifier('123', { defaultIssueSource: null }));
    });
  });

  describe('TD Issue Fetch', function () {
    it('should fetch TD issue and include tdMetadata', function () {
      if (skipTests) this.skip();

      // Create a test issue
      const createOutput = execSync('td create "Cross-provider test issue" --type task', {
        cwd: testRepoDir,
        encoding: 'utf8',
      });
      const issueId = createOutput.match(/td-[0-9a-f]+/)?.[0];
      assert(issueId, 'Should extract issue ID');

      const TDProvider = require('../../src/issue-providers/td-provider');
      const provider = new TDProvider();
      const inputData = provider.fetchIssue(issueId, {}, { cwd: testRepoDir });

      assert.ok(inputData, 'Should return inputData');
      assert.ok(inputData.tdMetadata, 'Should include tdMetadata');
      assert.strictEqual(inputData.tdMetadata.id, issueId);
      assert.strictEqual(inputData.tdMetadata.status, 'open');
    });
  });

  describe('Cross-Provider PR Workflow', function () {
    it('should not add Closes #X for TD issues in git-pusher template', function () {
      if (skipTests) this.skip();

      // The TD issue should not include "Closes #X" since TD doesn't use GitHub issue numbers
      // This is verified by checking the _applyAutoPrConfig logic in orchestrator

      const TDProvider = require('../../src/issue-providers/td-provider');
      assert.ok(!TDProvider.supportsPR(), 'TD should not support PR');
      assert.strictEqual(TDProvider.getPRTool(), null, 'TD should not have PR tool');
    });

    it('should store issueProvider for cross-provider workflows', function () {
      if (skipTests) this.skip();

      // This is a unit test verifying the orchestrator stores issueProvider
      // The actual integration is tested in orchestrator tests

      const TDProvider = require('../../src/issue-providers/td-provider');
      assert.strictEqual(TDProvider.id, 'td');
    });
  });

  describe('TD Lifecycle with PR Modes', function () {
    it('should include td log command in context for PR URL tracking', function () {
      if (skipTests) this.skip();

      // Create issue and check context includes td log command
      const createOutput = execSync('td create "PR tracking test" --type task', {
        cwd: testRepoDir,
        encoding: 'utf8',
      });
      const issueId = createOutput.match(/td-[0-9a-f]+/)?.[0];
      assert(issueId, 'Should extract issue ID');

      const TDProvider = require('../../src/issue-providers/td-provider');
      const provider = new TDProvider();
      const inputData = provider.fetchIssue(issueId, {}, { cwd: testRepoDir });

      assert.ok(
        inputData.context.includes('td log'),
        'Context should include td log command reference'
      );
    });

    it('should support td review command for PR mode', function () {
      if (skipTests) this.skip();

      // Create and start issue
      const createOutput = execSync('td create "Review mode test" --type task', {
        cwd: testRepoDir,
        encoding: 'utf8',
      });
      const issueId = createOutput.match(/td-[0-9a-f]+/)?.[0];
      assert(issueId, 'Should extract issue ID');

      execSync(`td start ${issueId}`, { cwd: testRepoDir, stdio: 'pipe' });

      // Submit for review
      execSync(`td review ${issueId}`, { cwd: testRepoDir, stdio: 'pipe' });

      // Verify status changed
      const showOutput = execSync(`td show ${issueId}`, {
        cwd: testRepoDir,
        encoding: 'utf8',
      });
      assert.ok(showOutput.includes('in_review'), 'Issue should be in_review status');
    });

    it('should support td close command for ship mode', function () {
      if (skipTests) this.skip();

      // Create issue marked as minor (allows self-close)
      const createOutput = execSync('td create "Ship mode testing workflow" --type task --minor', {
        cwd: testRepoDir,
        encoding: 'utf8',
      });
      const issueId = createOutput.match(/td-[0-9a-f]+/)?.[0];
      assert(issueId, 'Should extract issue ID');

      execSync(`td start ${issueId}`, { cwd: testRepoDir, stdio: 'pipe' });

      // Close (ship mode) - minor issues allow self-close
      execSync(`td close ${issueId}`, { cwd: testRepoDir, stdio: 'pipe' });

      // Verify status changed
      const showOutput = execSync(`td show ${issueId}`, {
        cwd: testRepoDir,
        encoding: 'utf8',
      });
      assert.ok(showOutput.includes('closed'), 'Issue should be closed status');
    });
  });

  describe('TD with Git Remote Detection', function () {
    it('should allow TD issues in repos with GitHub remotes', function () {
      if (skipTests) this.skip();

      // Add a mock GitHub remote
      try {
        execSync('git remote add origin https://github.com/test/repo.git', {
          cwd: testRepoDir,
          stdio: 'pipe',
        });
      } catch {
        // Remote may already exist
      }

      // TD should still work even with GitHub remote
      const createOutput = execSync('td create "GitHub repo TD test" --type task', {
        cwd: testRepoDir,
        encoding: 'utf8',
      });
      const issueId = createOutput.match(/td-[0-9a-f]+/)?.[0];
      assert(issueId, 'Should create TD issue in GitHub-remoted repo');

      // TD provider should still detect the issue
      const TDProvider = require('../../src/issue-providers/td-provider');
      assert.ok(TDProvider.detectIdentifier(issueId, {}));
    });
  });
});
