/**
 * TDSessionManager - Track TD sessions per agent
 *
 * Creates and manages TD sessions for agents in a cluster.
 * Each agent gets its own session for isolated logging.
 */

const { execSync } = require('../lib/safe-exec');

class TDSessionManager {
  constructor(options = {}) {
    this.sessions = new Map(); // agentId -> sessionId
    this.cwd = options.cwd || process.cwd();
  }

  /**
   * Create a new TD session for an agent
   * @param {string} agentId - Agent identifier
   * @param {string} clusterId - Cluster identifier
   * @returns {string|null} Session ID or null if creation failed
   */
  createSession(agentId, clusterId) {
    try {
      // Generate unique session name from agent and cluster
      const shortCluster = clusterId.replace(/^cluster-/, '').slice(0, 8);
      const sessionName = `${agentId}-${shortCluster}`;

      const output = execSync(`td usage --new-session --name "${sessionName}"`, {
        encoding: 'utf8',
        timeout: 5000,
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Parse session ID from output
      const match = output.match(/Session:\s*(ses_[a-f0-9]+)/i);
      const sessionId = match ? match[1] : null;

      if (sessionId) {
        this.sessions.set(agentId, sessionId);
      }

      return sessionId;
    } catch {
      // TD not available or failed - return null
      return null;
    }
  }

  /**
   * Get the session ID for an agent
   * @param {string} agentId
   * @returns {string|null}
   */
  getSession(agentId) {
    return this.sessions.get(agentId) || null;
  }

  /**
   * Get environment variables for an agent's session
   * @param {string} agentId
   * @returns {Object} Environment variables (empty if no session)
   */
  getSessionEnv(agentId) {
    const sessionId = this.getSession(agentId);
    return sessionId ? { TD_SESSION: sessionId } : {};
  }

  /**
   * Check if an agent has a session
   * @param {string} agentId
   * @returns {boolean}
   */
  hasSession(agentId) {
    return this.sessions.has(agentId);
  }

  /**
   * Remove an agent's session
   * @param {string} agentId
   */
  removeSession(agentId) {
    this.sessions.delete(agentId);
  }

  /**
   * Get all active sessions
   * @returns {Map<string, string>}
   */
  getAllSessions() {
    return new Map(this.sessions);
  }

  /**
   * Clear all sessions
   */
  clearAll() {
    this.sessions.clear();
  }

  /**
   * Get session count
   * @returns {number}
   */
  get size() {
    return this.sessions.size;
  }
}

module.exports = TDSessionManager;
