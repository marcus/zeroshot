/**
 * AgentHookExecutor - Hook transformation and execution
 *
 * Provides:
 * - Hook execution (publish_message, stop_cluster, etc.)
 * - Template variable substitution
 * - Transform script execution in VM sandbox
 * - Logic scripts for conditional config (like triggers)
 */

const vm = require('vm');
const { execSync } = require('../lib/safe-exec'); // Enforces timeouts

/**
 * Deep merge two objects, with source taking precedence
 * @param {Object} target - Base object
 * @param {Object} source - Override object
 * @returns {Object} Merged object
 */
function deepMerge(target, source) {
  if (!source || typeof source !== 'object') return target;
  if (!target || typeof target !== 'object') return source;

  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * Execute a hook
 * THROWS on failure - no silent errors
 * @param {Object} params - Hook execution parameters
 * @param {Object} params.hook - Hook configuration
 * @param {Object} params.agent - Agent instance
 * @param {Object} params.message - Triggering message
 * @param {Object} params.result - Agent execution result
 * @param {Object} params.messageBus - Message bus instance
 * @param {Object} params.cluster - Cluster object
 * @param {Object} params.orchestrator - Orchestrator instance
 * @returns {Promise<void>}
 */
async function executeHook(params) {
  const { hook, agent, message, result, cluster } = params;

  if (!hook) {
    return;
  }

  // Build context for hook execution
  const context = {
    result,
    triggeringMessage: message,
    agent,
    cluster,
  };

  // NO try/catch - errors must propagate
  if (hook.action === 'publish_message') {
    let messageToPublish;

    if (hook.transform) {
      // Transform scripts handle their own logic - no additional processing needed
      messageToPublish = await executeTransform({
        transform: hook.transform,
        context,
        agent,
      });
    } else {
      // Template-based config - may have logic block for conditional overrides
      let effectiveConfig = hook.config;

      // If hook has logic block, evaluate it to get config overrides
      if (hook.logic) {
        // Parse result data for logic evaluation (if available)
        let resultData = null;
        if (result?.output) {
          try {
            resultData = await agent._parseResultOutput(result.output);
          } catch (parseError) {
            // If logic script doesn't use result, parsing failure is OK
            // If it does use result, evaluateHookLogic will fail appropriately
            agent._log(
              `⚠️  Hook logic: result parsing failed, continuing with null: ${parseError.message}`
            );
          }
        }

        // Evaluate logic script
        const overrides = evaluateHookLogic({
          logic: hook.logic,
          resultData,
          agent,
          context,
        });

        // Deep merge overrides into config
        if (overrides) {
          agent._log(`Hook logic returned overrides: ${JSON.stringify(overrides)}`);
          effectiveConfig = deepMerge(hook.config, overrides);
        }
      }

      // Now do template substitution on the (possibly modified) config
      messageToPublish = await substituteTemplate({
        config: effectiveConfig,
        context,
        agent,
        cluster,
      });
    }

    // Publish via agent's _publish method
    agent._publish(messageToPublish);
  } else if (hook.action === 'execute_system_command') {
    throw new Error('execute_system_command not implemented');
  } else {
    throw new Error(`Unknown hook action: ${hook.action}`);
  }
}

/**
 * Execute a hook transform script
 * Transform scripts return the message to publish, with access to:
 * - result: parsed agent output
 * - triggeringMessage: the message that triggered the agent
 * - helpers: { getConfig(complexity, taskType) }
 * @param {Object} params - Transform parameters
 * @param {Object} params.transform - Transform configuration
 * @param {Object} params.context - Execution context
 * @param {Object} params.agent - Agent instance
 * @returns {Promise<Object>} Message to publish
 */
async function executeTransform(params) {
  const { transform, context, agent } = params;
  const { engine, script } = transform;

  if (engine !== 'javascript') {
    throw new Error(`Unsupported transform engine: ${engine}`);
  }

  // Parse result output if we have a result
  // VALIDATION: Check if script uses result.* variables and fail early if no output
  const scriptUsesResult = /\bresult\.[a-zA-Z]/.test(script);
  let resultData = null;

  if (context.result?.output) {
    try {
      resultData = await agent._parseResultOutput(context.result.output);
    } catch (parseError) {
      // FAIL FAST: Result parsing failed - don't continue with null data
      const taskId = context.result?.taskId || agent.currentTaskId || 'UNKNOWN';
      console.error(`\n${'='.repeat(80)}`);
      console.error(`🔴 TRANSFORM SCRIPT BLOCKED - RESULT PARSING FAILED`);
      console.error(`${'='.repeat(80)}`);
      console.error(`Agent: ${agent.id}, Role: ${agent.role}`);
      console.error(`TaskID: ${taskId}`);
      console.error(`Parse error: ${parseError.message}`);
      console.error(`Output (last 500 chars): ${(context.result.output || '').slice(-500)}`);
      console.error(`${'='.repeat(80)}\n`);
      throw new Error(
        `Transform script cannot run: result parsing failed. ` +
          `Agent: ${agent.id}, Error: ${parseError.message}`
      );
    }

    // DEFENSIVE: Validate result has expected fields if script accesses them
    // Extract field names from script (e.g., result.complexity, result.taskType)
    const accessedFields = [...script.matchAll(/result\.([a-zA-Z_]+)/g)].map((m) => m[1]);
    const missingFields = accessedFields.filter((f) => resultData[f] === undefined);
    if (missingFields.length > 0) {
      const taskId = context.result?.taskId || agent.currentTaskId || 'UNKNOWN';
      console.error(`\n${'='.repeat(80)}`);
      console.error(`🔴 TRANSFORM SCRIPT BLOCKED - MISSING REQUIRED FIELDS`);
      console.error(`${'='.repeat(80)}`);
      console.error(`Agent: ${agent.id}, Role: ${agent.role}, TaskID: ${taskId}`);
      console.error(`Script accesses: ${accessedFields.join(', ')}`);
      console.error(`Missing from result: ${missingFields.join(', ')}`);
      console.error(`Result keys: ${Object.keys(resultData).join(', ')}`);
      console.error(`Result data: ${JSON.stringify(resultData, null, 2)}`);
      console.error(`${'='.repeat(80)}\n`);
      throw new Error(
        `Transform script accesses undefined fields: ${missingFields.join(', ')}. ` +
          `Agent ${agent.id} (task ${taskId}) output missing required fields. ` +
          `Check agent's jsonSchema and output format.`
      );
    }
  } else if (scriptUsesResult) {
    const taskId = context.result?.taskId || agent.currentTaskId || 'UNKNOWN';
    const outputLength = (context.result?.output || '').length;
    throw new Error(
      `Transform script uses result.* variables but no output was captured. ` +
        `Agent: ${agent.id}, TaskID: ${taskId}, Iteration: ${agent.iteration}, ` +
        `Output length: ${outputLength}. ` +
        `Check that the task completed successfully and the get-log-path command exists.`
    );
  }

  // Helper functions exposed to transform scripts
  const helpers = {
    /**
     * Get cluster config based on complexity and task type
     * Returns: { base: 'template-name', params: { ... } }
     */
    getConfig: require('../config-router').getConfig,
  };

  // Build sandbox context
  const sandbox = {
    result: resultData,
    triggeringMessage: context.triggeringMessage,
    helpers,
    JSON,
    console: {
      log: (...args) => agent._log('[transform]', ...args),
      error: (...args) => console.error('[transform]', ...args),
      warn: (...args) => console.warn('[transform]', ...args),
    },
  };

  // Execute in VM sandbox with timeout
  const vmContext = vm.createContext(sandbox);
  const wrappedScript = `(function() { ${script} })()`;

  let result;
  try {
    result = vm.runInContext(wrappedScript, vmContext, { timeout: 5000 });
  } catch (err) {
    throw new Error(`Transform script error: ${err.message}`);
  }

  // Validate result
  if (!result || typeof result !== 'object') {
    throw new Error(
      `Transform script must return an object with topic and content, got: ${typeof result}`
    );
  }
  if (!result.topic) {
    throw new Error(`Transform script result must have a 'topic' property`);
  }
  if (!result.content) {
    throw new Error(`Transform script result must have a 'content' property`);
  }

  // CRITICAL: Extra validation for CLUSTER_OPERATIONS - this is the make-or-break message
  // If this message is malformed, the cluster will hang forever
  if (result.topic === 'CLUSTER_OPERATIONS') {
    const operations = result.content?.data?.operations;
    if (!operations) {
      console.error(`\n${'='.repeat(80)}`);
      console.error(`🔴 CLUSTER_OPERATIONS MALFORMED - MISSING OPERATIONS ARRAY`);
      console.error(`${'='.repeat(80)}`);
      console.error(`Agent: ${agent.id}`);
      console.error(`Result: ${JSON.stringify(result, null, 2)}`);
      console.error(`${'='.repeat(80)}\n`);
      throw new Error(
        `CLUSTER_OPERATIONS message missing operations array. ` +
          `Agent ${agent.id} transform script returned invalid structure.`
      );
    }
    if (!Array.isArray(operations)) {
      throw new Error(`CLUSTER_OPERATIONS.operations must be an array, got: ${typeof operations}`);
    }
    if (operations.length === 0) {
      throw new Error(`CLUSTER_OPERATIONS.operations is empty - no operations to execute`);
    }

    // Validate each operation has required 'action' field
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      if (!op || !op.action) {
        throw new Error(`CLUSTER_OPERATIONS.operations[${i}] missing required 'action' field`);
      }
    }

    agent._log(`✅ CLUSTER_OPERATIONS validated: ${operations.length} operations`);
  }

  return result;
}

/**
 * Substitute template variables in hook config
 * ONLY parses result output if result.* variables are used
 * THROWS on any error - no silent failures
 * @param {Object} params - Substitution parameters
 * @param {Object} params.config - Hook configuration
 * @param {Object} params.context - Execution context
 * @param {Object} params.agent - Agent instance
 * @param {Object} params.cluster - Cluster object
 * @returns {Promise<Object>} Substituted configuration
 */
async function substituteTemplate(params) {
  const { config, context, agent, cluster } = params;

  if (!config) {
    throw new Error('_substituteTemplate: config is required');
  }

  const json = JSON.stringify(config);

  // Check if ANY result.* variables are used BEFORE parsing
  // Generic pattern - no hardcoded field names, works with any agent config
  const usesResultVars = /\{\{result\.[^}]+\}\}/.test(json);

  let resultData = null;
  if (usesResultVars) {
    if (!context.result) {
      throw new Error(
        `Hook uses result.* variables but no result in context. ` +
          `Agent: ${agent.id}, TaskID: ${agent.currentTaskId}, Iteration: ${agent.iteration}`
      );
    }
    if (!context.result.output) {
      // Log detailed context for debugging
      const taskId = context.result.taskId || agent.currentTaskId || 'UNKNOWN';
      console.error(`\n${'='.repeat(80)}`);
      console.error(`🔴 HOOK FAILURE - EMPTY OUTPUT`);
      console.error(`${'='.repeat(80)}`);
      console.error(`Agent: ${agent.id}`);
      console.error(`Task ID: ${taskId}`);
      console.error(`Iteration: ${context.result.iteration || agent.iteration}`);
      console.error(`Result success: ${context.result.success}`);
      console.error(`Result error: ${context.result.error || 'none'}`);
      console.error(`Output length: ${(context.result.output || '').length}`);
      console.error(`Hook config: ${JSON.stringify(config, null, 2)}`);

      // Auto-fetch and publish task logs for debugging
      let taskLogs = 'Task logs unavailable';
      if (taskId !== 'UNKNOWN') {
        console.error(`\nFetching task logs for ${taskId}...`);
        try {
          const ctPath = agent._getClaudeTasksPath();
          taskLogs = execSync(`${ctPath} logs ${taskId} --lines 100`, {
            encoding: 'utf-8',
            timeout: 5000,
            maxBuffer: 1024 * 1024, // 1MB
          }).trim();
          console.error(`✓ Retrieved ${taskLogs.split('\n').length} lines of logs`);
        } catch (err) {
          taskLogs = `Failed to retrieve logs: ${err.message}`;
          console.error(`✗ Failed to retrieve logs: ${err.message}`);
        }
      }
      console.error(`${'='.repeat(80)}\n`);

      // Publish task logs to message bus for visibility in zeroshot logs
      agent._publish({
        topic: 'AGENT_ERROR',
        receiver: 'broadcast',
        content: {
          text: `Task logs for ${taskId} (last 100 lines)`,
          data: {
            taskId,
            logs: taskLogs,
            logsPreview: taskLogs.split('\n').slice(-20).join('\n'), // Last 20 lines as preview
          },
        },
      });

      throw new Error(
        `Hook uses result.* variables but result.output is empty. ` +
          `Agent: ${agent.id}, TaskID: ${taskId}, ` +
          `Iteration: ${context.result.iteration || agent.iteration}, ` +
          `Success: ${context.result.success}. ` +
          `Task logs posted to message bus.`
      );
    }
    // Parse result output - WILL THROW if no JSON block
    resultData = await agent._parseResultOutput(context.result.output);
  }

  // Helper to escape a value for JSON string substitution
  // Uses JSON.stringify for ALL escaping - no manual replace() calls
  const escapeForJsonString = (value) => {
    if (value === null || value === undefined) {
      throw new Error(`Cannot escape null/undefined value for JSON`);
    }
    // JSON.stringify handles ALL escaping (newlines, quotes, backslashes, control chars)
    // .slice(1, -1) strips the outer quotes it adds
    // For arrays/objects: stringify twice - once for JSON, once to escape for string embedding
    const stringified =
      typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(JSON.stringify(value));
    return stringified.slice(1, -1);
  };

  // Helper to escape template-like patterns in substituted values
  // This prevents content containing "{{result.foo}}" from being flagged as unsubstituted variables
  // Uses Unicode escape for first brace: {{ -> \u007B{ (invisible to humans, breaks pattern match)
  const escapeTemplatePatterns = (str) => {
    return str.replace(/\{\{/g, '\\u007B{');
  };

  let substituted = json
    .replace(/\{\{cluster\.id\}\}/g, escapeTemplatePatterns(cluster.id))
    .replace(/\{\{cluster\.createdAt\}\}/g, String(cluster.createdAt))
    .replace(/\{\{iteration\}\}/g, String(agent.iteration))
    .replace(
      /\{\{error\.message\}\}/g,
      escapeTemplatePatterns(escapeForJsonString(context.error?.message ?? ''))
    )
    .replace(
      /\{\{result\.output\}\}/g,
      escapeTemplatePatterns(escapeForJsonString(context.result?.output ?? ''))
    );

  // Substitute ALL result.* variables dynamically from parsed resultData
  if (resultData) {
    // Generic substitution - replace {{result.fieldName}} with resultData[fieldName]
    // No hardcoded field names - works with any agent output schema
    // CRITICAL: For booleans/nulls/numbers, we need to match and remove surrounding quotes
    // to produce valid JSON (e.g., "{{result.approved}}" -> true, not "true")
    substituted = substituted.replace(/"?\{\{result\.([^}]+)\}\}"?/g, (match, fieldName) => {
      const value = resultData[fieldName];
      if (value === undefined) {
        // Missing fields should gracefully default to null or empty values
        // This allows optional schema fields without hardcoding field names
        // If a field is truly required, the schema validation will catch it
        console.warn(
          `⚠️  Agent ${agent.id}: Template variable {{result.${fieldName}}} not found in output. ` +
            `If this field is required by the schema, the agent violated its own schema. ` +
            `Defaulting to null. Agent output keys: ${Object.keys(resultData).join(', ')}`
        );
        return 'null';
      }
      // Booleans, numbers, and null should be unquoted JSON primitives
      if (typeof value === 'boolean' || typeof value === 'number' || value === null) {
        return String(value);
      }
      // Strings need to be quoted and escaped for JSON
      // Also escape any template-like patterns in the content to prevent false positives
      return escapeTemplatePatterns(JSON.stringify(value));
    });
  }

  // Check for unsubstituted KNOWN template variables only
  // KNOWN patterns: {{cluster.X}}, {{iteration}}, {{error.X}}, {{result.X}}
  // Content may contain arbitrary {{...}} patterns (React dangerouslySetInnerHTML, Mustache, etc.)
  // Those are NOT template variables - they're just content that happens to contain braces
  const KNOWN_TEMPLATE_PREFIXES = ['cluster', 'iteration', 'error', 'result'];
  const knownVariablePattern = new RegExp(
    `\\{\\{(${KNOWN_TEMPLATE_PREFIXES.join('|')})(\\.[a-zA-Z_][a-zA-Z0-9_]*)?\\}\\}`,
    'g'
  );
  const remaining = substituted.match(knownVariablePattern);
  if (remaining) {
    throw new Error(`Unsubstituted template variables: ${remaining.join(', ')}`);
  }

  // Parse and validate result
  let result;
  try {
    result = JSON.parse(substituted);
  } catch (e) {
    console.error('JSON parse failed. Substituted string:');
    console.error(substituted);
    throw new Error(`Template substitution produced invalid JSON: ${e.message}`);
  }

  return result;
}

/**
 * Evaluate hook logic script to get config overrides
 * Similar to trigger logic, but returns an object to merge into config
 * @param {Object} params - Evaluation parameters
 * @param {Object} params.logic - Logic configuration { engine, script }
 * @param {Object} params.resultData - Parsed agent result data
 * @param {Object} params.agent - Agent instance
 * @param {Object} params.context - Execution context
 * @returns {Object|null} Config overrides to merge, or null if none
 */
function evaluateHookLogic(params) {
  const { logic, resultData, agent, context } = params;

  if (!logic || !logic.script) {
    return null;
  }

  if (logic.engine !== 'javascript') {
    throw new Error(`Unsupported hook logic engine: ${logic.engine}`);
  }

  // Build sandbox context - similar to LogicEngine but focused on result data
  const sandbox = {
    // The parsed result from agent output - this is the main input
    result: resultData || {},

    // Agent context
    agent: {
      id: agent.id,
      role: agent.role,
      iteration: agent.iteration || 0,
    },

    // Triggering message (if available)
    message: context.triggeringMessage || null,

    // Safe built-ins
    Set,
    Map,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Math,
    Date,
    JSON,

    // Console for debugging (logs to agent log)
    console: {
      log: (...args) => agent._log('[hook-logic]', ...args),
      error: (...args) => console.error('[hook-logic]', ...args),
      warn: (...args) => console.warn('[hook-logic]', ...args),
    },
  };

  // Execute in VM sandbox with timeout
  const vmContext = vm.createContext(sandbox);
  const wrappedScript = `(function() { 'use strict'; ${logic.script} })()`;

  let result;
  try {
    result = vm.runInContext(wrappedScript, vmContext, { timeout: 1000 });
  } catch (err) {
    throw new Error(`Hook logic script error: ${err.message}`);
  }

  // Logic scripts can return:
  // - undefined/null: no overrides
  // - object: merge into config
  if (result === undefined || result === null) {
    return null;
  }

  if (typeof result !== 'object') {
    throw new Error(`Hook logic script must return an object or undefined, got: ${typeof result}`);
  }

  return result;
}

module.exports = {
  executeHook,
  executeTransform,
  substituteTemplate,
  evaluateHookLogic,
  deepMerge,
};
