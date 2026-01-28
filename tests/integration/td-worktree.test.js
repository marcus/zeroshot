/**
 * Test: TD + Worktree Integration
 *
 * Tests that TD (Task Daemon) works correctly with ZeroShot worktree mode:
 * - .td-root file created in worktree pointing to main repo
 * - TD commands work in worktree via .td-root
 * - TD logging works in worktree
 * - No .td-root when TD not initialized
 *
 * REQUIRES: Git installed, td CLI installed
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const IsolationManager = require('../../src/isolation-manager');

let manager;
let testRepoDir;
const testClusterId = 'test-td-worktree-' + Date.now();

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

describe('TD + Worktree Integration', function () {
  before(function () {
    if (!hasTdCli()) {
      this.skip();
      return;
    }

    // Create temp git repo
    testRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-td-worktree-test-'));

    execSync('git init', { cwd: testRepoDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: testRepoDir, stdio: 'pipe' });
    execSync('git config user.name "Test User"', { cwd: testRepoDir, stdio: 'pipe' });

    fs.writeFileSync(path.join(testRepoDir, 'test.txt'), 'initial content');
    execSync('git add -A', { cwd: testRepoDir, stdio: 'pipe' });
    execSync('git commit -m "Initial commit"', { cwd: testRepoDir, stdio: 'pipe' });

    // Initialize TD in the test repo
    execSync('td init', { cwd: testRepoDir, stdio: 'pipe' });

    manager = new IsolationManager();
  });

  afterEach(function () {
    try {
      manager.cleanupWorktreeIsolation(testClusterId);
    } catch {
      // Ignore cleanup errors
    }
  });

  after(function () {
    if (testRepoDir && fs.existsSync(testRepoDir)) {
      fs.rmSync(testRepoDir, { recursive: true, force: true });
    }
  });

  describe('.td-root creation', function () {
    it('should create .td-root in worktree pointing to main repo', function () {
      const info = manager.createWorktreeIsolation(testClusterId, testRepoDir);

      const tdRootPath = path.join(info.path, '.td-root');
      assert(fs.existsSync(tdRootPath), '.td-root should exist in worktree');

      const tdRootContent = fs.readFileSync(tdRootPath, 'utf8').trim();
      // Use realpath to handle /var vs /private/var on macOS
      assert.strictEqual(
        fs.realpathSync(tdRootContent),
        fs.realpathSync(testRepoDir),
        '.td-root should point to main repo'
      );
    });

    it('should not create .td-root when no TD database exists', function () {
      // Create a separate temp repo without TD
      const noTdRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-no-td-test-'));

      try {
        execSync('git init', { cwd: noTdRepo, stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: noTdRepo, stdio: 'pipe' });
        execSync('git config user.name "Test User"', { cwd: noTdRepo, stdio: 'pipe' });
        fs.writeFileSync(path.join(noTdRepo, 'test.txt'), 'content');
        execSync('git add -A', { cwd: noTdRepo, stdio: 'pipe' });
        execSync('git commit -m "Initial"', { cwd: noTdRepo, stdio: 'pipe' });

        const noTdClusterId = 'test-no-td-' + Date.now();
        const info = manager.createWorktree(noTdClusterId, noTdRepo);

        const tdRootPath = path.join(info.path, '.td-root');
        assert(!fs.existsSync(tdRootPath), '.td-root should not exist when TD not initialized');

        // Cleanup
        manager.removeWorktree(info);
      } finally {
        fs.rmSync(noTdRepo, { recursive: true, force: true });
      }
    });
  });

  describe('TD commands in worktree', function () {
    it('should allow TD list from worktree', function () {
      // Create an issue in main repo first
      execSync('td create "Test TD issue for worktree" --type task', {
        cwd: testRepoDir,
        stdio: 'pipe',
      });

      const info = manager.createWorktreeIsolation(testClusterId, testRepoDir);

      // TD list should work in worktree and show the issue
      const output = execSync('td list', {
        cwd: info.path,
        encoding: 'utf8',
      });

      assert(
        output.includes('Test TD issue for worktree'),
        'TD list in worktree should show issues from main repo'
      );
    });

    it('should allow TD show from worktree', function () {
      // Create issue in main repo
      const createOutput = execSync('td create "Worktree show test" --type task', {
        cwd: testRepoDir,
        encoding: 'utf8',
      });
      const issueId = createOutput.match(/td-[0-9a-f]+/)?.[0];
      assert(issueId, 'Should extract issue ID from create output');

      const info = manager.createWorktreeIsolation(testClusterId, testRepoDir);

      // TD show should work in worktree
      const output = execSync(`td show ${issueId}`, {
        cwd: info.path,
        encoding: 'utf8',
      });

      assert(output.includes('Worktree show test'), 'TD show in worktree should work');
    });
  });

  describe('TD logging from worktree', function () {
    it('should log progress from worktree to main repo', function () {
      // Create and start issue in main repo
      const createOutput = execSync('td create "Worktree logging test" --type task', {
        cwd: testRepoDir,
        encoding: 'utf8',
      });
      const issueId = createOutput.match(/td-[0-9a-f]+/)?.[0];
      assert(issueId, 'Should extract issue ID');

      execSync(`td start ${issueId}`, { cwd: testRepoDir, stdio: 'pipe' });

      const info = manager.createWorktreeIsolation(testClusterId, testRepoDir);

      // Log from worktree (must specify issue ID - focus context not shared)
      execSync(`td log ${issueId} "Progress logged from worktree"`, {
        cwd: info.path,
        stdio: 'pipe',
      });

      // Verify log appears when viewing from main repo
      const showOutput = execSync(`td show ${issueId}`, {
        cwd: testRepoDir,
        encoding: 'utf8',
      });

      assert(
        showOutput.includes('Progress logged from worktree'),
        'Log entry should be visible from main repo'
      );
    });

    it('should allow td handoff from worktree', function () {
      // Create and start issue
      const createOutput = execSync('td create "Worktree handoff test" --type task', {
        cwd: testRepoDir,
        encoding: 'utf8',
      });
      const issueId = createOutput.match(/td-[0-9a-f]+/)?.[0];
      assert(issueId, 'Should extract issue ID');

      execSync(`td start ${issueId}`, { cwd: testRepoDir, stdio: 'pipe' });

      const info = manager.createWorktreeIsolation(testClusterId, testRepoDir);

      // Handoff from worktree (must specify issue ID)
      execSync(`td handoff ${issueId} "Handoff from worktree complete"`, {
        cwd: info.path,
        stdio: 'pipe',
      });

      // Verify the handoff happened
      const showOutput = execSync(`td show ${issueId}`, {
        cwd: testRepoDir,
        encoding: 'utf8',
      });

      assert(
        showOutput.includes('Handoff from worktree complete') || showOutput.includes('handoff'),
        'Handoff should be recorded'
      );
    });
  });

  describe('TD lifecycle in worktree', function () {
    it('should allow full TD lifecycle from worktree: start, log, review', function () {
      // Create issue in main repo
      const createOutput = execSync('td create "Full lifecycle test" --type task', {
        cwd: testRepoDir,
        encoding: 'utf8',
      });
      const issueId = createOutput.match(/td-[0-9a-f]+/)?.[0];
      assert(issueId, 'Should extract issue ID');

      const info = manager.createWorktreeIsolation(testClusterId, testRepoDir);

      // Start from worktree
      execSync(`td start ${issueId}`, { cwd: info.path, stdio: 'pipe' });

      // Log progress from worktree (must specify issue ID)
      execSync(`td log ${issueId} "Step 1 complete"`, { cwd: info.path, stdio: 'pipe' });
      execSync(`td log ${issueId} "Step 2 complete"`, { cwd: info.path, stdio: 'pipe' });

      // Submit for review from worktree
      execSync(`td review ${issueId}`, { cwd: info.path, stdio: 'pipe' });

      // Verify status from main repo
      const showOutput = execSync(`td show ${issueId}`, {
        cwd: testRepoDir,
        encoding: 'utf8',
      });

      assert(
        showOutput.includes('in_review') || showOutput.includes('review'),
        'Issue should be in review status'
      );
    });
  });
});
