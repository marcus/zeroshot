import { fork } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { LOGS_DIR } from './config.js';
import { addTask, generateId, ensureDirs } from './store.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { loadSettings } = require('../lib/settings.js');
const { normalizeProviderName } = require('../lib/provider-names');
const { getProvider } = require('../src/providers');

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function spawnTask(prompt, options = {}) {
  ensureDirs();

  const id = generateId();
  const logFile = join(LOGS_DIR, `${id}.log`);
  const cwd = options.cwd || process.cwd();

  const settings = loadSettings();
  const providerName = normalizeProviderName(
    options.provider || settings.defaultProvider || 'claude'
  );
  const provider = getProvider(providerName);
  const providerSettings = settings.providerSettings?.[providerName] || {};
  const levelOverrides = providerSettings.levelOverrides || {};

  const outputFormat = options.outputFormat || 'stream-json';

  let jsonSchema = options.jsonSchema || null;
  if (jsonSchema && outputFormat !== 'json') {
    console.warn('Warning: --json-schema requires --output-format json, ignoring schema');
    jsonSchema = null;
  }

  let modelSpec;
  if (options.model) {
    modelSpec = {
      model: options.model,
      reasoningEffort: options.reasoningEffort,
    };
  } else {
    const level = options.modelLevel || providerSettings.defaultLevel || provider.getDefaultLevel();
    modelSpec = provider.resolveModelSpec(level, levelOverrides);
    if (options.reasoningEffort) {
      modelSpec = { ...modelSpec, reasoningEffort: options.reasoningEffort };
    }
  }

  const cliFeatures = await provider.getCliFeatures();
  const commandSpec = provider.buildCommand(prompt, {
    modelSpec,
    outputFormat,
    jsonSchema,
    cwd,
    autoApprove: true,
    cliFeatures,
  });

  const finalArgs = [...commandSpec.args];
  if (providerName === 'claude') {
    const promptIndex = finalArgs.length - 1;
    if (options.resume) {
      finalArgs.splice(promptIndex, 0, '--resume', options.resume);
    } else if (options.continue) {
      finalArgs.splice(promptIndex, 0, '--continue');
    }
  } else if (options.resume || options.continue) {
    console.warn('Warning: resume/continue is only supported for Claude CLI; ignoring.');
  }

  const task = {
    id,
    prompt: prompt.slice(0, 200) + (prompt.length > 200 ? '...' : ''),
    fullPrompt: prompt,
    cwd,
    status: 'running',
    pid: null,
    sessionId: options.resume || options.sessionId || null,
    logFile,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    exitCode: null,
    error: null,
    provider: providerName,
    model: modelSpec?.model || null,
    // Schedule reference (if spawned by scheduler)
    scheduleId: options.scheduleId || null,
    // Attach support
    socketPath: null,
    attachable: false,
  };

  addTask(task);

  const watcherConfig = {
    outputFormat,
    jsonSchema,
    silentJsonOutput: options.silentJsonOutput || false,
    provider: providerName,
    command: commandSpec.binary,
    env: commandSpec.env || {},
  };

  const useAttachable = options.attachable !== false && !options.jsonSchema;
  const watcherScript = useAttachable
    ? join(__dirname, 'attachable-watcher.js')
    : join(__dirname, 'watcher.js');

  const watcher = fork(
    watcherScript,
    [id, cwd, logFile, JSON.stringify(finalArgs), JSON.stringify(watcherConfig)],
    {
      detached: true,
      stdio: 'ignore',
    }
  );

  watcher.unref();
  watcher.disconnect(); // Close IPC channel so parent can exit

  return task;
}

export function isProcessRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function killTask(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}
