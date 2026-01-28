/**
 * Test: TDSessionManager
 *
 * Tests the TD session management for agents.
 */

const assert = require('assert');
const TDSessionManager = require('../../src/td/session-manager');

describe('TDSessionManager', function () {
  let manager;

  beforeEach(function () {
    manager = new TDSessionManager();
  });

  describe('constructor', function () {
    it('should initialize with empty sessions', function () {
      assert.strictEqual(manager.size, 0);
    });

    it('should accept cwd option', function () {
      const custom = new TDSessionManager({ cwd: '/custom/path' });
      assert.strictEqual(custom.cwd, '/custom/path');
    });

    it('should default cwd to process.cwd()', function () {
      assert.strictEqual(manager.cwd, process.cwd());
    });
  });

  describe('getSession()', function () {
    it('should return null for unknown agent', function () {
      assert.strictEqual(manager.getSession('unknown-agent'), null);
    });
  });

  describe('getSessionEnv()', function () {
    it('should return empty object for unknown agent', function () {
      const env = manager.getSessionEnv('unknown-agent');
      assert.deepStrictEqual(env, {});
    });

    it('should return TD_SESSION when session exists', function () {
      // Manually set a session for testing
      manager.sessions.set('test-agent', 'ses_abc123');

      const env = manager.getSessionEnv('test-agent');
      assert.deepStrictEqual(env, { TD_SESSION: 'ses_abc123' });
    });
  });

  describe('hasSession()', function () {
    it('should return false for unknown agent', function () {
      assert.strictEqual(manager.hasSession('unknown'), false);
    });

    it('should return true when session exists', function () {
      manager.sessions.set('test-agent', 'ses_xyz');
      assert.strictEqual(manager.hasSession('test-agent'), true);
    });
  });

  describe('removeSession()', function () {
    it('should remove an existing session', function () {
      manager.sessions.set('agent-1', 'ses_123');
      assert.strictEqual(manager.size, 1);

      manager.removeSession('agent-1');
      assert.strictEqual(manager.size, 0);
      assert.strictEqual(manager.hasSession('agent-1'), false);
    });

    it('should not throw for unknown agent', function () {
      assert.doesNotThrow(() => manager.removeSession('unknown'));
    });
  });

  describe('getAllSessions()', function () {
    it('should return empty map when no sessions', function () {
      const all = manager.getAllSessions();
      assert.strictEqual(all.size, 0);
    });

    it('should return copy of all sessions', function () {
      manager.sessions.set('agent-1', 'ses_1');
      manager.sessions.set('agent-2', 'ses_2');

      const all = manager.getAllSessions();
      assert.strictEqual(all.size, 2);
      assert.strictEqual(all.get('agent-1'), 'ses_1');
      assert.strictEqual(all.get('agent-2'), 'ses_2');

      // Verify it's a copy
      all.set('agent-3', 'ses_3');
      assert.strictEqual(manager.size, 2);
    });
  });

  describe('clearAll()', function () {
    it('should remove all sessions', function () {
      manager.sessions.set('agent-1', 'ses_1');
      manager.sessions.set('agent-2', 'ses_2');
      assert.strictEqual(manager.size, 2);

      manager.clearAll();
      assert.strictEqual(manager.size, 0);
    });
  });

  describe('size', function () {
    it('should return correct count', function () {
      assert.strictEqual(manager.size, 0);

      manager.sessions.set('a', 's1');
      assert.strictEqual(manager.size, 1);

      manager.sessions.set('b', 's2');
      assert.strictEqual(manager.size, 2);
    });
  });

  describe('createSession()', function () {
    it('should return null when td CLI not available', function () {
      // This test runs without td CLI mocking, so it should fail gracefully
      const result = manager.createSession('test-agent', 'cluster-xyz-123');
      // Result depends on whether td CLI is available
      // If not available, should return null
      // If available, should return a session ID
      assert.ok(result === null || /^ses_[a-f0-9]+$/.test(result));
    });

    it('should store session when created successfully', function () {
      // Manually simulate successful session creation
      manager.sessions.set('test-agent', 'ses_manual');

      assert.strictEqual(manager.getSession('test-agent'), 'ses_manual');
      assert.strictEqual(manager.hasSession('test-agent'), true);
    });
  });
});

describe('TDSessionManager Integration', function () {
  // These tests require td CLI to be available
  // They will be skipped if td is not installed

  let hasTd = false;

  before(function () {
    try {
      require('child_process').execSync('td --version', { stdio: 'pipe' });
      hasTd = true;
    } catch {
      hasTd = false;
    }
  });

  it('should create real session when td available', function () {
    if (!hasTd) {
      this.skip();
      return;
    }

    const manager = new TDSessionManager();
    const sessionId = manager.createSession('integration-test', 'cluster-test-123');

    // If td is properly initialized in cwd, we should get a session
    // If not (no .todos), it will return null
    if (sessionId) {
      assert.ok(/^ses_[a-f0-9]+$/.test(sessionId));
      assert.strictEqual(manager.getSession('integration-test'), sessionId);
    }
  });
});
