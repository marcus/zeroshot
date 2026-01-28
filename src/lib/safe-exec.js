/**
 * Safe subprocess execution with mandatory timeouts.
 *
 * NEVER use child_process.exec() or execSync() directly.
 * These wrappers enforce timeouts to prevent infinite hangs.
 */

const {
  exec: nodeExec,
  execSync: nodeExecSync,
  spawnSync: nodeSpawnSync,
} = require('child_process');

/** Default timeout: 30 seconds */
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Execute command with mandatory timeout.
 * Supports both Promise and callback styles for gradual migration.
 *
 * @param {string} command - Command to execute
 * @param {object} [options] - Options (timeout uses default if not specified)
 * @param {function} [callback] - Optional callback(error, stdout, stderr)
 * @returns {Promise<{stdout: string, stderr: string}>|void} Promise if no callback, void if callback
 *
 * @example
 * // Promise style (preferred)
 * const { stdout } = await exec('ls -la', { timeout: 5000 });
 *
 * @example
 * // Callback style (for legacy code migration)
 * exec('ls -la', { timeout: 5000 }, (error, stdout) => { ... });
 */
function exec(command, optionsOrCallback = {}, callbackArg = null) {
  // Handle overloaded signature: exec(cmd, callback)
  const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : callbackArg;
  const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;

  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;

  if (timeout <= 0) {
    const err = new Error('exec() timeout must be > 0. Infinite waits are forbidden.');
    if (callback) {
      callback(err);
      return;
    }
    return Promise.reject(err);
  }

  // Callback style
  if (callback) {
    nodeExec(command, { ...options, timeout }, (error, stdout, stderr) => {
      if (error && error.killed && error.signal === 'SIGTERM') {
        error.message = `Command timed out after ${timeout}ms: ${command}`;
      }
      callback(error, stdout, stderr);
    });
    return;
  }

  // Promise style
  return new Promise((resolve, reject) => {
    nodeExec(command, { ...options, timeout }, (error, stdout, stderr) => {
      if (error) {
        if (error.killed && error.signal === 'SIGTERM') {
          error.message = `Command timed out after ${timeout}ms: ${command}`;
        }
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/**
 * Execute command with mandatory timeout (sync)
 * @param {string} command - Command to execute
 * @param {object} [options] - Options (timeout required or uses default)
 * @returns {string} stdout
 */
function execSync(command, options = {}) {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;

  if (timeout <= 0) {
    throw new Error('execSync() timeout must be > 0. Infinite waits are forbidden.');
  }

  return nodeExecSync(command, { ...options, timeout });
}

/**
 * Execute command with args (no shell parsing, safer for user input)
 * Uses spawnSync to avoid shell injection vulnerabilities.
 *
 * @param {string} command - The command to execute (e.g., 'td')
 * @param {string[]} args - Array of arguments (not parsed by shell)
 * @param {object} [options] - Options (timeout required or uses default)
 * @returns {{ stdout: string, stderr: string, status: number }}
 *
 * @example
 * // Safely execute with user-provided strings
 * spawnSync('td', ['handoff', issueId, '--done', userInput]);
 */
function spawnSync(command, args = [], options = {}) {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;

  if (timeout <= 0) {
    throw new Error('spawnSync() timeout must be > 0. Infinite waits are forbidden.');
  }

  const result = nodeSpawnSync(command, args, {
    ...options,
    timeout,
    shell: false, // Critical: no shell parsing
    encoding: options.encoding || 'utf8',
  });

  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      result.error.message = `Command timed out after ${timeout}ms: ${command} ${args.join(' ')}`;
    }
    throw result.error;
  }

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
}

module.exports = { exec, execSync, spawnSync, DEFAULT_TIMEOUT_MS };
