/**
 * Config Validator - Static analysis for zeroshot cluster configurations
 *
 * Catches logical failures that would cause clusters to:
 * - Never start (no bootstrap trigger)
 * - Never complete (no path to completion)
 * - Loop infinitely (circular dependencies)
 * - Deadlock (impossible consensus)
 * - Waste compute (orchestrator executing tasks)
 *
 * Run at config load time to fail fast before spawning agents.
 */

const { loadSettings } = require('../lib/settings');
const { VALID_PROVIDERS, normalizeProviderName } = require('../lib/provider-names');
const { getProvider } = require('./providers');
const { CAPABILITIES } = require('./providers/capabilities');

/**
 * Check if config is a conductor-bootstrap style config
 * Conductor configs dynamically spawn agents via CLUSTER_OPERATIONS
 * @param {Object} config - Cluster configuration
 * @returns {boolean}
 */
function isConductorConfig(config) {
  return config.agents?.some(
    (a) =>
      a.role === 'conductor' &&
      // Old style: static topic in config
      (a.hooks?.onComplete?.config?.topic === 'CLUSTER_OPERATIONS' ||
        // New style: topic set in transform script (check for CLUSTER_OPERATIONS in script)
        a.hooks?.onComplete?.transform?.script?.includes('CLUSTER_OPERATIONS'))
  );
}

/**
 * Validate a cluster configuration for structural correctness
 * @param {Object} config - Cluster configuration
 * @param {Number} depth - Current nesting depth (for subcluster validation)
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validateConfig(config, depth = 0) {
  const errors = [];
  const warnings = [];
  const settings = loadSettings();

  // Max nesting depth check
  const MAX_DEPTH = 5;
  if (depth > MAX_DEPTH) {
    errors.push(`Cluster nesting exceeds max depth (${MAX_DEPTH})`);
    return { valid: false, errors, warnings };
  }

  // === PHASE 1: Basic structure validation ===
  const basicResult = validateBasicStructure(config, depth);
  errors.push(...basicResult.errors);
  warnings.push(...basicResult.warnings);

  // Note: We continue to other phases even if Phase 1 has errors,
  // to collect ALL validation issues (especially semantic checks in Phase 6-9)

  // Conductor configs dynamically spawn agents - skip message flow analysis
  // The orchestrator validates the spawned config at CLUSTER_OPERATIONS execution time
  const conductorMode = isConductorConfig(config);

  // === PHASE 2: Message flow analysis (skip for conductor configs) ===
  if (!conductorMode) {
    const flowResult = analyzeMessageFlow(config);
    errors.push(...flowResult.errors);
    warnings.push(...flowResult.warnings);
  }

  // === PHASE 3: Agent-specific validation ===
  const agentResult = validateAgents(config);
  errors.push(...agentResult.errors);
  warnings.push(...agentResult.warnings);

  // === PHASE 4: Logic script validation ===
  const logicResult = validateLogicScripts(config);
  errors.push(...logicResult.errors);
  warnings.push(...logicResult.warnings);

  // === PHASE 5: Template variable validation ===
  const templateResult = validateTemplateVariables(config, depth);
  errors.push(...templateResult.errors);
  warnings.push(...templateResult.warnings);

  // === PHASE 6: Hook semantic validation ===
  const hookResult = validateHookSemantics(config);
  errors.push(...hookResult.errors);
  warnings.push(...hookResult.warnings);

  // === PHASE 7: Rule coverage validation ===
  const ruleResult = validateRuleCoverage(config);
  errors.push(...ruleResult.errors);
  warnings.push(...ruleResult.warnings);

  // === PHASE 8: N-agent cycle detection ===
  const cycleResult = detectNAgentCycles(config);
  errors.push(...cycleResult.errors);
  warnings.push(...cycleResult.warnings);

  // === PHASE 9: Configuration semantic validation ===
  const configResult = validateConfigSemantics(config);
  errors.push(...configResult.errors);
  warnings.push(...configResult.warnings);

  // === PHASE 10: Provider feature validation ===
  const providerResult = validateProviderFeatures(config, settings);
  errors.push(...providerResult.errors);
  warnings.push(...providerResult.warnings);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Phase 1: Validate basic structure (fields, types, duplicates)
 */
function validateBasicStructure(config, depth = 0) {
  const errors = [];
  const warnings = [];

  if (!config.agents || !Array.isArray(config.agents)) {
    errors.push('agents array is required');
    return { errors, warnings };
  }

  if (config.agents.length === 0) {
    errors.push('agents array cannot be empty');
    return { errors, warnings };
  }

  const seenIds = new Set();

  for (let i = 0; i < config.agents.length; i++) {
    const agent = config.agents[i];
    const prefix = `agents[${i}]`;

    // Check if this is a subcluster
    const isSubCluster = agent.type === 'subcluster';

    // Required fields
    if (!agent.id) {
      errors.push(`${prefix}.id is required`);
    } else if (typeof agent.id !== 'string') {
      errors.push(`${prefix}.id must be a string`);
    } else if (seenIds.has(agent.id)) {
      errors.push(`Duplicate agent id: "${agent.id}"`);
    } else {
      seenIds.add(agent.id);
    }

    if (!agent.role) {
      errors.push(`${prefix}.role is required`);
    }

    // Validate subclusters
    if (isSubCluster) {
      const subClusterSchema = require('./schemas/sub-cluster');
      const subResult = subClusterSchema.validateSubCluster(agent, depth);
      errors.push(...subResult.errors);
      warnings.push(...subResult.warnings);
      continue; // Skip regular agent validation
    }

    // Regular agent validation
    if (!agent.triggers || !Array.isArray(agent.triggers)) {
      errors.push(`${prefix}.triggers array is required`);
    } else if (agent.triggers.length === 0) {
      errors.push(`${prefix}.triggers cannot be empty (agent would never activate)`);
    }

    // Validate triggers structure
    if (agent.triggers) {
      for (let j = 0; j < agent.triggers.length; j++) {
        const trigger = agent.triggers[j];
        const triggerPrefix = `${prefix}.triggers[${j}]`;

        if (!trigger.topic) {
          errors.push(`${triggerPrefix}.topic is required`);
        }

        if (trigger.action && !['execute_task', 'stop_cluster'].includes(trigger.action)) {
          errors.push(
            `${triggerPrefix}.action must be 'execute_task' or 'stop_cluster', got '${trigger.action}'`
          );
        }

        if (trigger.logic) {
          if (!trigger.logic.script) {
            errors.push(`${triggerPrefix}.logic.script is required when logic is specified`);
          }
          if (trigger.logic.engine && trigger.logic.engine !== 'javascript') {
            errors.push(
              `${triggerPrefix}.logic.engine must be 'javascript', got '${trigger.logic.engine}'`
            );
          }
        }
      }
    }

    // Validate model rules if present
    if (agent.modelRules) {
      if (!Array.isArray(agent.modelRules)) {
        errors.push(`${prefix}.modelRules must be an array`);
      } else {
        for (let j = 0; j < agent.modelRules.length; j++) {
          const rule = agent.modelRules[j];
          const rulePrefix = `${prefix}.modelRules[${j}]`;

          if (!rule.iterations) {
            errors.push(`${rulePrefix}.iterations is required`);
          } else if (!isValidIterationPattern(rule.iterations)) {
            errors.push(
              `${rulePrefix}.iterations '${rule.iterations}' is invalid. Valid: "1", "1-3", "5+", "all"`
            );
          }

          if (!rule.model && !rule.modelLevel) {
            errors.push(`${rulePrefix}.model or modelLevel is required`);
          }
        }

        // Note: Detailed coverage gap checking (iteration ranges) is done in Phase 7
      }
    }
  }

  return { errors, warnings };
}

/**
 * Phase 2: Analyze message flow for structural problems
 */
function analyzeMessageFlow(config) {
  const errors = [];
  const warnings = [];

  // Build topic graph
  const topicProducers = new Map(); // topic -> [agentIds that produce it]
  const topicConsumers = new Map(); // topic -> [agentIds that consume it]
  const agentOutputTopics = new Map(); // agentId -> [topics it produces]
  const agentInputTopics = new Map(); // agentId -> [topics it consumes]

  // System always produces ISSUE_OPENED
  topicProducers.set('ISSUE_OPENED', ['system']);

  for (const agent of config.agents) {
    agentInputTopics.set(agent.id, []);
    agentOutputTopics.set(agent.id, []);

    // Track what topics this agent consumes (triggers)
    for (const trigger of agent.triggers || []) {
      const topic = trigger.topic;
      if (!topicConsumers.has(topic)) {
        topicConsumers.set(topic, []);
      }
      topicConsumers.get(topic).push(agent.id);
      agentInputTopics.get(agent.id).push(topic);
    }

    // Track what topics this agent produces (hooks)
    const outputTopic = agent.hooks?.onComplete?.config?.topic;
    if (outputTopic) {
      if (!topicProducers.has(outputTopic)) {
        topicProducers.set(outputTopic, []);
      }
      topicProducers.get(outputTopic).push(agent.id);
      agentOutputTopics.get(agent.id).push(outputTopic);
    }

    // Also extract topics that could be dynamically produced by hook logic scripts
    const hookLogicScript = agent.hooks?.onComplete?.logic?.script;
    if (hookLogicScript && typeof hookLogicScript === 'string') {
      // Scan for { topic: 'TOPIC_NAME' } or { topic: "TOPIC_NAME" } patterns
      const topicMatches = hookLogicScript.match(/topic:\s*['"]([A-Z_]+)['"]/g) || [];
      for (const match of topicMatches) {
        const dynamicTopic = match.match(/['"]([A-Z_]+)['"]/)?.[1];
        if (dynamicTopic && dynamicTopic !== outputTopic) {
          if (!topicProducers.has(dynamicTopic)) {
            topicProducers.set(dynamicTopic, []);
          }
          // Mark as dynamic producer (append * to indicate it's conditional)
          if (!topicProducers.get(dynamicTopic).includes(agent.id)) {
            topicProducers.get(dynamicTopic).push(`${agent.id}*`);
          }
          if (!agentOutputTopics.get(agent.id).includes(dynamicTopic)) {
            agentOutputTopics.get(agent.id).push(dynamicTopic);
          }
        }
      }
    }
  }

  // === CHECK 1: No bootstrap trigger ===
  const issueOpenedConsumers = topicConsumers.get('ISSUE_OPENED') || [];
  if (issueOpenedConsumers.length === 0) {
    errors.push(
      'No agent triggers on ISSUE_OPENED. Cluster will never start. ' +
        'Add a trigger: { "topic": "ISSUE_OPENED", "action": "execute_task" }'
    );
  }

  // === CHECK 2: No completion handler ===
  const completionHandlers = config.agents.filter(
    (a) =>
      a.triggers?.some((t) => t.action === 'stop_cluster') ||
      a.id === 'completion-detector' ||
      a.id === 'git-pusher' ||
      a.hooks?.onComplete?.config?.topic === 'CLUSTER_COMPLETE'
  );
  const isTemplateConfig = config.params && Object.keys(config.params).length > 0;

  if (completionHandlers.length === 0) {
    const message =
      'No completion handler found. Cluster will run until idle timeout (2 min). ' +
      'Add an agent with trigger action: "stop_cluster"';
    if (isTemplateConfig) {
      warnings.push(`${message} (template will rely on orchestrator injection)`);
    } else {
      errors.push(message);
    }
  } else if (completionHandlers.length > 1) {
    errors.push(
      `Multiple completion handlers: [${completionHandlers.map((a) => a.id).join(', ')}]. ` +
        'This causes race conditions. Keep only one.'
    );
  }

  // === CHECK 3: Orphan topics (produced but never consumed) ===
  for (const [topic, producers] of topicProducers) {
    if (topic === 'CLUSTER_COMPLETE') continue; // System handles this
    const consumers = topicConsumers.get(topic) || [];
    if (consumers.length === 0) {
      warnings.push(
        `Topic '${topic}' is produced by [${producers.join(', ')}] but never consumed. Dead end.`
      );
    }
  }

  // === CHECK 4: Waiting for topics that are never produced ===
  for (const [topic, consumers] of topicConsumers) {
    if (topic === 'ISSUE_OPENED' || topic === 'CLUSTER_RESUMED') continue; // System produces
    if (topic.endsWith('*')) continue; // Wildcard pattern
    const producers = topicProducers.get(topic) || [];
    if (producers.length === 0) {
      errors.push(
        `Topic '${topic}' consumed by [${consumers.join(', ')}] but never produced. ` +
          'These agents will never trigger.'
      );
    }
  }

  // === CHECK 5: Self-triggering agents (instant infinite loop) ===
  // Skip if trigger or hook has logic block (conditional self-trigger is allowed)
  for (const agent of config.agents) {
    const inputs = agentInputTopics.get(agent.id) || [];
    const outputs = agentOutputTopics.get(agent.id) || [];
    const selfTrigger = inputs.find((t) => outputs.includes(t));
    if (selfTrigger) {
      // Check if the self-trigger is conditional (has logic block on trigger or hook)
      const triggerHasLogic = agent.triggers?.some(
        (t) => t.topic === selfTrigger && t.logic?.script
      );
      const hookHasLogic = agent.hooks?.onComplete?.logic?.script;

      if (!triggerHasLogic && !hookHasLogic) {
        errors.push(
          `Agent '${agent.id}' triggers on '${selfTrigger}' and produces '${selfTrigger}'. ` +
            'Instant infinite loop.'
        );
      }
      // If either has logic, it's a controlled self-trigger pattern (e.g., progress updates)
    }
  }

  // === CHECK 6: Two-agent circular dependency ===
  for (const agentA of config.agents) {
    const outputsA = agentOutputTopics.get(agentA.id) || [];
    for (const agentB of config.agents) {
      if (agentA.id === agentB.id) continue;
      const inputsB = agentInputTopics.get(agentB.id) || [];
      const outputsB = agentOutputTopics.get(agentB.id) || [];
      const inputsA = agentInputTopics.get(agentA.id) || [];

      // A produces what B consumes, AND B produces what A consumes
      const aToB = outputsA.some((t) => inputsB.includes(t));
      const bToA = outputsB.some((t) => inputsA.includes(t));

      if (aToB && bToA) {
        // This might be intentional (rejection loop), check if there's an escape
        const hasEscapeLogic =
          agentA.triggers?.some((t) => t.logic) || agentB.triggers?.some((t) => t.logic);
        if (!hasEscapeLogic) {
          warnings.push(
            `Circular dependency: '${agentA.id}' ↔ '${agentB.id}'. ` +
              'Add logic conditions to prevent infinite loop, or ensure maxIterations is set.'
          );
        }
      }
    }
  }

  // === CHECK 7: Validator without worker re-trigger ===
  const validators = config.agents.filter((a) => a.role === 'validator');
  const workers = config.agents.filter((a) => a.role === 'implementation');

  if (validators.length > 0 && workers.length > 0) {
    for (const worker of workers) {
      const triggersOnValidation = worker.triggers?.some(
        (t) => t.topic === 'VALIDATION_RESULT' || t.topic.includes('VALIDATION')
      );
      if (!triggersOnValidation) {
        errors.push(
          `Worker '${worker.id}' has validators but doesn't trigger on VALIDATION_RESULT. ` +
            'Rejections will be ignored. Add trigger: { "topic": "VALIDATION_RESULT", "logic": {...} }'
        );
      }
    }
  }

  // === CHECK 8: Context strategy missing trigger topics ===
  for (const agent of config.agents) {
    if (!agent.contextStrategy?.sources) continue;

    const triggerTopics = (agent.triggers || []).map((t) => t.topic);
    const contextTopics = agent.contextStrategy.sources.map((s) => s.topic);

    for (const triggerTopic of triggerTopics) {
      if (triggerTopic === 'ISSUE_OPENED' || triggerTopic === 'CLUSTER_RESUMED') continue;
      if (triggerTopic.endsWith('*')) continue;

      if (!contextTopics.includes(triggerTopic)) {
        warnings.push(
          `Agent '${agent.id}' triggers on '${triggerTopic}' but doesn't include it in contextStrategy. ` +
            'Agent may not see what triggered it.'
        );
      }
    }
  }

  return { errors, warnings };
}

/**
 * Phase 3: Validate agent-specific configurations
 */
function validateAgents(config) {
  const errors = [];
  const warnings = [];

  const roles = new Map(); // role -> [agentIds]

  for (const agent of config.agents) {
    // Track roles
    if (!roles.has(agent.role)) {
      roles.set(agent.role, []);
    }
    roles.get(agent.role).push(agent.id);

    // Orchestrator should not execute tasks
    if (agent.role === 'orchestrator') {
      const executesTask = agent.triggers?.some(
        (t) => t.action === 'execute_task' || (!t.action && !t.logic)
      );
      if (executesTask) {
        warnings.push(
          `Orchestrator '${agent.id}' has execute_task triggers. ` +
            'Orchestrators typically use action: "stop_cluster". This may waste API calls.'
        );
      }
    }

    // Check for git operations in validator prompts (unreliable in agents)
    if (agent.role === 'validator') {
      const prompt = typeof agent.prompt === 'string' ? agent.prompt : agent.prompt?.system;
      const gitPatterns = ['git diff', 'git status', 'git log', 'git show'];
      for (const pattern of gitPatterns) {
        if (prompt?.includes(pattern)) {
          errors.push(
            `Validator '${agent.id}' uses '${pattern}' - git state is unreliable in agents`
          );
        }
      }
    }

    // JSON output without schema
    if (agent.outputFormat === 'json' && !agent.jsonSchema) {
      warnings.push(
        `Agent '${agent.id}' has outputFormat: 'json' but no jsonSchema. ` +
          'Output parsing may be unreliable.'
      );
    }

    // Very high maxIterations
    if (agent.maxIterations && agent.maxIterations > 50) {
      warnings.push(
        `Agent '${agent.id}' has maxIterations: ${agent.maxIterations}. ` +
          'This may consume significant API credits if stuck in a loop.'
      );
    }

    // No maxIterations on implementation agent (unbounded retries)
    if (agent.role === 'implementation' && !agent.maxIterations) {
      warnings.push(
        `Implementation agent '${agent.id}' has no maxIterations. ` +
          'Defaults to 30, but consider setting explicitly.'
      );
    }

    // FORBIDDEN: Direct model specification in configs
    // Use modelLevel (level1/level2/level3) for provider-agnostic model selection
    if (agent.model) {
      errors.push(
        `Agent '${agent.id}' uses 'model: "${agent.model}"'. ` +
          `Use 'modelLevel: "level1|level2|level3"' instead for provider-agnostic model selection.`
      );
    }
  }

  // Check for role references in logic scripts
  // IMPORTANT: Changed from error to warning because some triggers are designed to be
  // no-ops when the referenced role doesn't exist (e.g., worker's VALIDATION_RESULT
  // trigger returns false when validators.length === 0)
  for (const agent of config.agents) {
    for (const trigger of agent.triggers || []) {
      if (trigger.logic?.script) {
        const script = trigger.logic.script;
        const roleMatch = script.match(/getAgentsByRole\(['"](\w+)['"]\)/g);
        if (roleMatch) {
          for (const match of roleMatch) {
            const role = match.match(/['"](\w+)['"]/)[1];
            if (!roles.has(role)) {
              warnings.push(
                `Agent '${agent.id}' logic references role '${role}' but no agent has that role. ` +
                  `Trigger may be a no-op. Available roles: [${Array.from(roles.keys()).join(', ')}]`
              );
            }
          }
        }
      }
    }
  }

  return { errors, warnings };
}

/**
 * Phase 4: Validate logic scripts (syntax only, not semantics)
 */
function validateLogicScripts(config) {
  const errors = [];
  const warnings = [];

  const vm = require('vm');

  for (const agent of config.agents) {
    for (const trigger of agent.triggers || []) {
      if (!trigger.logic?.script) continue;

      const script = trigger.logic.script;

      // Syntax check
      try {
        const wrappedScript = `(function() { ${script} })()`;
        new vm.Script(wrappedScript);
      } catch (syntaxError) {
        errors.push(`Agent '${agent.id}' has invalid logic script: ${syntaxError.message}`);
        continue;
      }

      // Check for common mistakes - only flag if script is JUST "return false" or "return true"
      // Complex scripts with conditionals should not trigger this
      const trimmedScript = script.trim().replace(/\s+/g, ' ');
      const isSimpleReturnFalse = /^return\s+false;?$/.test(trimmedScript);
      const isSimpleReturnTrue = /^return\s+true;?$/.test(trimmedScript);

      if (isSimpleReturnFalse) {
        warnings.push(
          `Agent '${agent.id}' logic is just 'return false'. Agent will never trigger.`
        );
      }

      if (isSimpleReturnTrue) {
        warnings.push(
          `Agent '${agent.id}' logic is just 'return true'. Consider adding conditions or removing the logic block.`
        );
      }

      // Check for undefined variable access (common typos)
      const knownVars = [
        'ledger',
        'cluster',
        'message',
        'agent',
        'helpers',
        'Set',
        'Map',
        'Array',
        'Object',
        'JSON',
        'Date',
        'Math',
      ];
      const varPattern = /\b([a-zA-Z_]\w*)\s*\./g;
      let match;
      while ((match = varPattern.exec(script)) !== null) {
        const varName = match[1];
        if (
          !knownVars.includes(varName) &&
          !script.includes(`const ${varName}`) &&
          !script.includes(`let ${varName}`)
        ) {
          warnings.push(
            `Agent '${agent.id}' logic uses '${varName}' which may be undefined. ` +
              `Available: [${knownVars.join(', ')}]`
          );
          break; // Only warn once per agent
        }
      }
    }
  }

  return { errors, warnings };
}

/**
 * Phase 5: Validate template variables against jsonSchema
 * Ensures {{result.*}} references in hooks match defined schema properties
 *
 * Issue #14 - Gap 3:
 * - Gap 3: Template variables don't exist (line 582-656)
 *
 */
function validateTemplateVariables(config, depth = 0) {
  const errors = [];
  const warnings = [];

  if (!config.agents || !Array.isArray(config.agents)) {
    return { errors, warnings };
  }

  const prefix = depth > 0 ? `Sub-cluster (depth ${depth}): ` : '';

  for (const agent of config.agents) {
    // Skip subclusters - they have their own validation
    if (agent.type === 'subcluster') {
      // Recursively validate subcluster config
      if (agent.config?.agents) {
        const subResult = validateTemplateVariables(agent.config, depth + 1);
        // Prefix sub-cluster errors with agent ID
        errors.push(...subResult.errors.map((e) => `Sub-cluster '${agent.id}': ${e}`));
        warnings.push(...subResult.warnings.map((w) => `Sub-cluster '${agent.id}': ${w}`));
      }
      continue;
    }

    const result = validateAgentTemplateVariables(agent, agent.id);
    errors.push(...result.errors.map((e) => `${prefix}${e}`));
    warnings.push(...result.warnings.map((w) => `${prefix}${w}`));
  }

  return { errors, warnings };
}

/**
 * Validate template variables for a single agent
 * @param {Object} agent - Agent configuration
 * @param {String} agentId - Agent ID for error messages
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateAgentTemplateVariables(agent, agentId) {
  const errors = [];
  const warnings = [];

  // Extract schema properties (null if non-JSON output or text output)
  const schemaProps = extractSchemaProperties(agent);

  // If schemaProps is null, this agent doesn't use JSON output - skip validation
  if (schemaProps === null) {
    return { errors, warnings };
  }

  // Extract template variables from hooks
  const templateVars = extractTemplateVariables(agent);

  // Check for undefined references (ERROR)
  for (const varName of templateVars) {
    if (!schemaProps.has(varName)) {
      const availableProps = Array.from(schemaProps).join(', ');
      errors.push(
        `Agent '${agentId}': Template uses '{{result.${varName}}}' but '${varName}' is not defined in jsonSchema. ` +
          `Available properties: [${availableProps}]`
      );
    }
  }

  // Check for unused schema properties (WARNING)
  for (const prop of schemaProps) {
    if (!templateVars.has(prop)) {
      warnings.push(
        `Agent '${agentId}': Schema property '${prop}' is defined but never referenced in hooks. ` +
          `Consider removing it to save tokens.`
      );
    }
  }

  return { errors, warnings };
}

/**
 * Extract all template variables ({{result.*}}) from agent hooks
 * Searches hooks.onComplete.config (recursive) and hooks.onComplete.transform.script
 * Also searches triggers[].onComplete patterns
 * @param {Object} agent - Agent configuration
 * @returns {Set<string>} Set of variable names referenced
 */
function extractTemplateVariables(agent) {
  const variables = new Set();

  // Regex patterns - reset lastIndex before each use to avoid state pollution
  const mustachePattern = /\{\{result\.([^}]+)\}\}/g;
  const directPattern = /\bresult\.([a-zA-Z_][a-zA-Z0-9_]*)/g;

  /**
   * Recursively traverse an object/array and extract template variables from strings
   */
  function traverseAndExtract(obj) {
    if (obj === null || obj === undefined) {
      return;
    }

    if (typeof obj === 'string') {
      // Extract mustache-style {{result.field}}
      mustachePattern.lastIndex = 0;
      let match;
      while ((match = mustachePattern.exec(obj)) !== null) {
        variables.add(match[1]);
      }
      return;
    }

    if (Array.isArray(obj)) {
      for (const item of obj) {
        traverseAndExtract(item);
      }
      return;
    }

    if (typeof obj === 'object') {
      for (const value of Object.values(obj)) {
        traverseAndExtract(value);
      }
    }
  }

  /**
   * Extract variables from transform script (direct result.field access)
   */
  function extractFromScript(script) {
    if (typeof script !== 'string') {
      return;
    }

    directPattern.lastIndex = 0;
    let match;
    while ((match = directPattern.exec(script)) !== null) {
      variables.add(match[1]);
    }
  }

  // Extract from hooks.onComplete.config
  if (agent.hooks?.onComplete?.config) {
    traverseAndExtract(agent.hooks.onComplete.config);
  }

  // Extract from hooks.onComplete.transform.script
  if (agent.hooks?.onComplete?.transform?.script) {
    extractFromScript(agent.hooks.onComplete.transform.script);
  }

  // Extract from triggers[].onComplete (some agents define hooks per-trigger)
  if (agent.triggers && Array.isArray(agent.triggers)) {
    for (const trigger of agent.triggers) {
      if (trigger.onComplete?.config) {
        traverseAndExtract(trigger.onComplete.config);
      }
      if (trigger.onComplete?.transform?.script) {
        extractFromScript(trigger.onComplete.transform.script);
      }
    }
  }

  return variables;
}

/**
 * Extract schema properties from agent's jsonSchema
 * @param {Object} agent - Agent configuration
 * @returns {Set<string>|null} Set of property names, or null if agent doesn't use JSON output
 */
function extractSchemaProperties(agent) {
  // Non-JSON agents don't need validation
  // Both 'json' and 'stream-json' use jsonSchema and need validation
  if (!['json', 'stream-json'].includes(agent.outputFormat)) {
    return null;
  }

  // If explicit schema is provided, use its properties
  if (agent.jsonSchema?.properties) {
    return new Set(Object.keys(agent.jsonSchema.properties));
  }

  // Default schema when outputFormat is 'json' but no explicit schema
  // See: agent-config.js:62-69
  return new Set(['summary', 'result']);
}

/**
 * Check if iteration pattern is valid
 */
function isValidIterationPattern(pattern) {
  if (pattern === 'all') return true;
  if (/^\d+$/.test(pattern)) return true; // "1"
  if (/^\d+-\d+$/.test(pattern)) return true; // "1-3"
  if (/^\d+\+$/.test(pattern)) return true; // "5+"
  return false;
}

/**
 * Format validation result for CLI output
 */
function formatValidationResult(result) {
  const lines = [];

  if (result.valid) {
    lines.push('✅ Configuration is valid');
  } else {
    lines.push('❌ Configuration has errors');
  }

  if (result.errors.length > 0) {
    lines.push('\nErrors:');
    for (const error of result.errors) {
      lines.push(`  ❌ ${error}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push('\nWarnings:');
    for (const warning of result.warnings) {
      lines.push(`  ⚠️  ${warning}`);
    }
  }

  return lines.join('\n');
}

/**
 * Phase 6: Hook semantic validation
 * Catches runtime failures in hook execution (agent-hook-executor.js)
 *
 * Issue #14 - Gaps 1, 2, 7:
 * - Gap 1: Hook action field missing (line 837-842)
 * - Gap 2: Transform script output shape (line 846-866)
 * - Gap 7: Conductor CLUSTER_OPERATIONS payload (line 869-888)
 *
 * @param {Object} config - Cluster configuration
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateHookSemantics(config) {
  const errors = [];
  const warnings = [];

  if (!config.agents || !Array.isArray(config.agents)) {
    return { errors, warnings };
  }

  for (const agent of config.agents) {
    // Skip subclusters - they have their own validation
    if (agent.type === 'subcluster') {
      continue;
    }

    const hooks = agent.hooks || {};
    const hookTypes = ['onComplete', 'onFailure', 'onTimeout'];

    for (const hookType of hookTypes) {
      const hook = hooks[hookType];
      if (!hook) continue;

      const prefix = `Agent '${agent.id}' hooks.${hookType}`;

      // === GAP 1: Hook action field missing ===
      // Causes runtime crash at agent-hook-executor.js:66
      if (!hook.action) {
        errors.push(
          `[Gap 1] ${prefix}: Missing 'action' field. ` +
            `Fix: Add "action": "publish_message" or "action": "execute_system_command"`
        );
      }

      // === GAP 2: Transform script output shape validation ===
      // Causes runtime crash at agent-hook-executor.js:148
      if (hook.transform?.script) {
        const script = hook.transform.script;

        // Check if script returns an object with topic and content
        // Simple heuristic: look for return statement with object
        const hasReturnTopic = /return\s*\{[^}]*topic\s*:/i.test(script);
        const hasReturnContent = /return\s*\{[^}]*content\s*:/i.test(script);

        if (!hasReturnTopic) {
          errors.push(
            `[Gap 2] ${prefix}: Transform script must return object with 'topic' property. ` +
              `Fix: return { topic: "TOPIC_NAME", content: {...} }`
          );
        }

        if (!hasReturnContent) {
          errors.push(
            `[Gap 2] ${prefix}: Transform script must return object with 'content' property. ` +
              `Fix: return { topic: "...", content: { data: result } }`
          );
        }
      }

      // === GAP 7: CLUSTER_OPERATIONS payload validation ===
      // Causes runtime crash at orchestrator.js:722
      if (
        agent.role === 'conductor' &&
        (hook.config?.topic === 'CLUSTER_OPERATIONS' ||
          hook.transform?.script?.includes('CLUSTER_OPERATIONS'))
      ) {
        // Check if operations field is valid JSON structure
        if (hook.transform?.script) {
          const script = hook.transform.script;
          // Look for operations field in return statement
          const hasOperations = /operations\s*:/i.test(script);
          if (!hasOperations) {
            errors.push(
              `[Gap 7] ${prefix}: CLUSTER_OPERATIONS message must include 'operations' field. ` +
                `Fix: return { topic: "CLUSTER_OPERATIONS", content: { data: { operations: JSON.stringify([...]) } } }`
            );
          }
        }
      }

      // === Logic block validation ===
      // Logic blocks allow conditional config overrides (like trigger logic)
      if (hook.logic) {
        if (hook.logic.engine && hook.logic.engine !== 'javascript') {
          errors.push(
            `${prefix}: Hook logic engine must be 'javascript', got: '${hook.logic.engine}'`
          );
        }

        if (!hook.logic.script) {
          errors.push(`${prefix}: Hook logic must have a 'script' property`);
        } else if (typeof hook.logic.script !== 'string') {
          errors.push(`${prefix}: Hook logic script must be a string`);
        } else {
          // Validate script syntax
          try {
            const vm = require('vm');
            const wrappedScript = `(function() { 'use strict'; ${hook.logic.script} })()`;
            new vm.Script(wrappedScript);
          } catch (syntaxError) {
            errors.push(`${prefix}: Hook logic script has syntax error: ${syntaxError.message}`);
          }
        }

        // Logic blocks require config (they modify config, not replace it)
        if (!hook.config && !hook.transform) {
          errors.push(
            `${prefix}: Hook with logic block must also have 'config' or 'transform'. ` +
              `Logic provides overrides, not the full message.`
          );
        }
      }
    }
  }

  return { errors, warnings };
}

/**
 * Phase 7: Rule coverage validation
 * Catches gaps in model rules and prompt rules that cause runtime failures
 *
 * Issue #14 - Gaps 4, 5:
 * - Gap 4: Model rule iteration gaps (line 916-963)
 * - Gap 5: Prompt rule iteration gaps (line 965-1014)
 *
 * @param {Object} config - Cluster configuration
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateRuleCoverage(config) {
  const errors = [];
  const warnings = [];

  if (!config.agents || !Array.isArray(config.agents)) {
    return { errors, warnings };
  }

  for (const agent of config.agents) {
    if (agent.type === 'subcluster') {
      continue;
    }

    const maxIterations = agent.maxIterations || 30;

    // === GAP 4: Model rule iteration gaps ===
    // Causes runtime crash at agent-wrapper.js:154
    if (agent.modelRules && Array.isArray(agent.modelRules)) {
      const coveredIterations = new Set();

      for (const rule of agent.modelRules) {
        const pattern = rule.iterations;

        if (pattern === 'all') {
          // Covers all iterations
          for (let i = 1; i <= maxIterations; i++) {
            coveredIterations.add(i);
          }
        } else if (/^\d+$/.test(pattern)) {
          // Single iteration: "5"
          coveredIterations.add(parseInt(pattern));
        } else if (/^\d+-\d+$/.test(pattern)) {
          // Range: "1-3"
          const [start, end] = pattern.split('-').map((n) => parseInt(n));
          for (let i = start; i <= end; i++) {
            coveredIterations.add(i);
          }
        } else if (/^\d+\+$/.test(pattern)) {
          // Open-ended: "5+"
          const start = parseInt(pattern);
          for (let i = start; i <= maxIterations; i++) {
            coveredIterations.add(i);
          }
        }
      }

      // Find gaps
      const uncoveredIterations = [];
      for (let i = 1; i <= maxIterations; i++) {
        if (!coveredIterations.has(i)) {
          uncoveredIterations.push(i);
        }
      }

      if (uncoveredIterations.length > 0) {
        // Group consecutive iterations for readability
        const ranges = groupConsecutive(uncoveredIterations);
        errors.push(
          `[Gap 4] Agent '${agent.id}': Model rules have gaps at iterations ${ranges.join(', ')}. ` +
            `Fix: Add catch-all rule { "iterations": "all", "model": "sonnet" } or extend existing ranges.`
        );
      }
    }

    // === GAP 5: Prompt rule iteration gaps ===
    // Causes runtime crash at agent-wrapper.js:222
    if (
      agent.promptConfig &&
      agent.promptConfig.type === 'rules' &&
      agent.promptConfig.rules &&
      Array.isArray(agent.promptConfig.rules)
    ) {
      const coveredIterations = new Set();

      for (const rule of agent.promptConfig.rules) {
        const pattern = rule.iterations;

        if (pattern === 'all') {
          for (let i = 1; i <= maxIterations; i++) {
            coveredIterations.add(i);
          }
        } else if (/^\d+$/.test(pattern)) {
          coveredIterations.add(parseInt(pattern));
        } else if (/^\d+-\d+$/.test(pattern)) {
          const [start, end] = pattern.split('-').map((n) => parseInt(n));
          for (let i = start; i <= end; i++) {
            coveredIterations.add(i);
          }
        } else if (/^\d+\+$/.test(pattern)) {
          const start = parseInt(pattern);
          for (let i = start; i <= maxIterations; i++) {
            coveredIterations.add(i);
          }
        }
      }

      const uncoveredIterations = [];
      for (let i = 1; i <= maxIterations; i++) {
        if (!coveredIterations.has(i)) {
          uncoveredIterations.push(i);
        }
      }

      if (uncoveredIterations.length > 0) {
        const ranges = groupConsecutive(uncoveredIterations);
        errors.push(
          `[Gap 5] Agent '${agent.id}': Prompt rules have gaps at iterations ${ranges.join(', ')}. ` +
            `Fix: Add catch-all rule { "iterations": "all", "prompt": "..." } or extend existing ranges.`
        );
      }
    }
  }

  return { errors, warnings };
}

/**
 * Helper: Group consecutive numbers into ranges for readable output
 * Example: [1, 2, 3, 5, 7, 8, 9] -> ["1-3", "5", "7-9"]
 */
function groupConsecutive(numbers) {
  if (numbers.length === 0) return [];

  const sorted = [...numbers].sort((a, b) => a - b);
  const ranges = [];
  let rangeStart = sorted[0];
  let rangeEnd = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === rangeEnd + 1) {
      rangeEnd = sorted[i];
    } else {
      // End of range
      if (rangeStart === rangeEnd) {
        ranges.push(`${rangeStart}`);
      } else {
        ranges.push(`${rangeStart}-${rangeEnd}`);
      }
      rangeStart = sorted[i];
      rangeEnd = sorted[i];
    }
  }

  // Add final range
  if (rangeStart === rangeEnd) {
    ranges.push(`${rangeStart}`);
  } else {
    ranges.push(`${rangeStart}-${rangeEnd}`);
  }

  return ranges;
}

/**
 * Phase 8: N-agent cycle detection
 * Detects circular dependencies with 3+ agents using DFS
 *
 * Issue #14 - Gap 6:
 * - Gap 6: 3+ agent circular dependencies (line 1060-1165)
 *
 * @param {Object} config - Cluster configuration
 * @returns {{ errors: string[], warnings: string[] }}
 */
function detectNAgentCycles(config) {
  const errors = [];
  const warnings = [];

  if (!config.agents || !Array.isArray(config.agents)) {
    return { errors, warnings };
  }

  // Build agent dependency graph: agent -> [agents it depends on]
  const agentGraph = new Map();
  const topicProducers = new Map(); // topic -> [agentIds]

  // Initialize graph
  for (const agent of config.agents) {
    if (agent.type === 'subcluster') continue;
    agentGraph.set(agent.id, []);

    // Track what topics this agent produces
    const outputTopic = agent.hooks?.onComplete?.config?.topic;
    if (outputTopic) {
      if (!topicProducers.has(outputTopic)) {
        topicProducers.set(outputTopic, []);
      }
      topicProducers.get(outputTopic).push(agent.id);
    }
  }

  // Build dependencies: agent consumes topic -> depends on agents that produce it
  for (const agent of config.agents) {
    if (agent.type === 'subcluster') continue;

    const dependencies = new Set();

    for (const trigger of agent.triggers || []) {
      const topic = trigger.topic;
      if (topic === 'ISSUE_OPENED' || topic === 'CLUSTER_RESUMED') continue;
      if (topic.endsWith('*')) continue; // Skip wildcards

      const producers = topicProducers.get(topic) || [];
      for (const producer of producers) {
        if (producer !== agent.id) {
          dependencies.add(producer);
        }
      }
    }

    agentGraph.set(agent.id, Array.from(dependencies));
  }

  // === GAP 6: Detect cycles with DFS ===
  const visited = new Set();
  const recursionStack = new Set();

  function dfs(agentId, path) {
    visited.add(agentId);
    recursionStack.add(agentId);

    const dependencies = agentGraph.get(agentId) || [];
    for (const nextAgent of dependencies) {
      if (recursionStack.has(nextAgent)) {
        // Cycle detected - return the full cycle path
        const cycleStartIndex = path.indexOf(nextAgent);
        const cyclePath = [...path.slice(cycleStartIndex), nextAgent];
        return cyclePath;
      }

      if (!visited.has(nextAgent)) {
        const cycle = dfs(nextAgent, [...path, nextAgent]);
        if (cycle) return cycle;
      }
    }

    recursionStack.delete(agentId);
    return null;
  }

  // Check all agents as starting points
  for (const agentId of agentGraph.keys()) {
    if (!visited.has(agentId)) {
      const cycle = dfs(agentId, [agentId]);
      if (cycle) {
        // Check if cycle has escape logic (any agent in cycle has trigger logic)
        const hasEscapeLogic = cycle.some((id) => {
          const agent = config.agents.find((a) => a.id === id);
          return agent?.triggers?.some((t) => t.logic);
        });

        const cycleStr = cycle.join(' → ');
        if (!hasEscapeLogic) {
          errors.push(
            `[Gap 6] Circular dependency detected: ${cycleStr}. ` +
              `Fix: Add logic conditions to break the loop, or set maxIterations on involved agents.`
          );
        } else {
          warnings.push(
            `Circular dependency detected: ${cycleStr}. ` +
              `Has escape logic in triggers, but verify maxIterations is set to prevent infinite loops.`
          );
        }
        // Only report first cycle to avoid noise
        break;
      }
    }
  }

  return { errors, warnings };
}

/**
 * Phase 9: Configuration semantic validation
 * Validates configuration fields that can cause runtime failures
 *
 * Issue #14 - Gaps 8-15:
 * - Gap 8: JSON schema structurally invalid (line 1219-1237)
 * - Gap 9: Context sources never produced (line 1240-1283)
 * - Gap 10: Isolation config invalid (line 1286-1312)
 * - Gap 11: Agent ID conflicts across subclusters (line 1185-1212)
 * - Gap 12: Load config file paths don't exist (line 1315-1323)
 * - Gap 13: Task executor config invalid (line 1326-1352)
 * - Gap 14: Context source format invalid (line 1270-1282)
 * - Gap 15: Role references in logic (stricter) (line 1354-1383)
 *
 * @param {Object} config - Cluster configuration
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateConfigSemantics(config) {
  const errors = [];
  const warnings = [];

  if (!config.agents || !Array.isArray(config.agents)) {
    return { errors, warnings };
  }

  const fs = require('fs');
  const path = require('path');

  // === GAP 11: Agent ID conflicts across subclusters ===
  // Collect all agent IDs recursively (including subclusters)
  const allAgentIds = new Map(); // Map of agentId -> depth where first seen

  function collectAgentIds(agents, depth = 0) {
    if (!agents) return;

    for (const agent of agents) {
      if (!agent.id) continue; // Skip agents without IDs (caught in Phase 1)

      if (allAgentIds.has(agent.id)) {
        const firstSeenDepth = allAgentIds.get(agent.id);
        errors.push(
          `[Gap 11] Duplicate agent ID '${agent.id}' found across cluster hierarchy ` +
            `(first at depth ${firstSeenDepth}, duplicate at depth ${depth}). ` +
            `Fix: Ensure all agent IDs are unique across the entire cluster.`
        );
      } else {
        allAgentIds.set(agent.id, depth);
      }

      if (agent.type === 'subcluster' && agent.config?.agents) {
        collectAgentIds(agent.config.agents, depth + 1);
      }
    }
  }

  collectAgentIds(config.agents);

  for (const agent of config.agents) {
    if (agent.type === 'subcluster') continue;

    const prefix = `Agent '${agent.id}'`;

    // === GAP 8: JSON schema structurally invalid ===
    if (agent.jsonSchema) {
      try {
        // Check if schema can be stringified (basic structural check)
        JSON.stringify(agent.jsonSchema);

        // Check required fields for JSON schema
        if (typeof agent.jsonSchema !== 'object') {
          errors.push(
            `[Gap 8] ${prefix}: jsonSchema must be an object, got ${typeof agent.jsonSchema}. ` +
              `Fix: Use valid JSON Schema format with 'type' and 'properties' fields.`
          );
        }
      } catch (e) {
        errors.push(
          `[Gap 8] ${prefix}: jsonSchema is not valid JSON: ${e.message}. ` +
            `Fix: Ensure schema is a valid JSON object.`
        );
      }
    }

    // === GAP 9: Context sources never produced (enhanced check) ===
    // Already partially covered in Phase 2, but add stricter checks
    if (agent.contextStrategy?.sources) {
      const topicProducers = new Map();

      // Build topic producers map
      for (const a of config.agents) {
        if (a.type === 'subcluster') continue;
        const outputTopic = a.hooks?.onComplete?.config?.topic;
        if (outputTopic) {
          if (!topicProducers.has(outputTopic)) {
            topicProducers.set(outputTopic, []);
          }
          topicProducers.get(outputTopic).push(a.id);
        }
      }

      for (const source of agent.contextStrategy.sources) {
        const topic = source.topic;
        if (topic === 'ISSUE_OPENED' || topic === 'CLUSTER_RESUMED') continue;
        if (topic.endsWith('*')) continue;

        const producers = topicProducers.get(topic) || [];
        if (producers.length === 0) {
          warnings.push(
            `[Gap 9] ${prefix}: Context source topic '${topic}' is never produced. ` +
              `Agent will get empty context for this source.`
          );
        }

        // === GAP 14: Context source format invalid ===
        if (source.amount === undefined) {
          warnings.push(
            `[Gap 14] ${prefix}: Context source for topic '${topic}' missing 'amount' field. ` +
              `Defaults may not be what you expect.`
          );
        }
        if (source.strategy && !['latest', 'all', 'oldest'].includes(source.strategy)) {
          errors.push(
            `[Gap 14] ${prefix}: Context source strategy '${source.strategy}' is invalid. ` +
              `Fix: Use 'latest', 'all', or 'oldest'.`
          );
        }
      }
    }

    // === GAP 10: Isolation config invalid ===
    if (agent.isolation) {
      if (agent.isolation.type === 'docker') {
        if (!agent.isolation.image) {
          errors.push(
            `[Gap 10] ${prefix}: Docker isolation requires 'image' field. ` +
              `Fix: Add "image": "zeroshot-runner" or custom image name.`
          );
        }

        // Check mount paths are absolute
        if (agent.isolation.mounts) {
          for (const mount of agent.isolation.mounts) {
            if (mount.host && !path.isAbsolute(mount.host)) {
              warnings.push(
                `[Gap 10] ${prefix}: Docker mount host path '${mount.host}' is not absolute. ` +
                  `May cause runtime errors.`
              );
            }
          }
        }
      } else if (agent.isolation.type && agent.isolation.type !== 'worktree') {
        errors.push(
          `[Gap 10] ${prefix}: Unknown isolation type '${agent.isolation.type}'. ` +
            `Fix: Use 'docker' or 'worktree'.`
        );
      }
    }

    // === GAP 12: Load config file paths don't exist ===
    if (agent.loadConfig) {
      const configPath = agent.loadConfig.path;
      if (configPath && !fs.existsSync(configPath)) {
        errors.push(
          `[Gap 12] ${prefix}: Load config file '${configPath}' does not exist. ` +
            `Fix: Check file path or remove loadConfig.`
        );
      }
    }

    // === GAP 13: Task executor config invalid ===
    if (agent.taskExecutor) {
      if (agent.taskExecutor.command === undefined) {
        errors.push(
          `[Gap 13] ${prefix}: Task executor missing 'command' field. ` +
            `Fix: Add "command": "claude" or custom command.`
        );
      }

      if (agent.taskExecutor.retries !== undefined) {
        if (typeof agent.taskExecutor.retries !== 'number' || agent.taskExecutor.retries < 0) {
          errors.push(
            `[Gap 13] ${prefix}: Task executor 'retries' must be a non-negative number, got ${agent.taskExecutor.retries}. ` +
              `Fix: Use a positive integer or 0.`
          );
        }
      }

      if (agent.taskExecutor.timeout !== undefined) {
        if (typeof agent.taskExecutor.timeout !== 'number' || agent.taskExecutor.timeout <= 0) {
          errors.push(
            `[Gap 13] ${prefix}: Task executor 'timeout' must be a positive number, got ${agent.taskExecutor.timeout}. ` +
              `Fix: Use a positive number in milliseconds.`
          );
        }
      }
    }

    // === GAP 15: Stricter role reference validation ===
    // Upgrade from WARNING to ERROR when role is used in critical logic
    const roles = new Set(config.agents.filter((a) => a.type !== 'subcluster').map((a) => a.role));

    for (const trigger of agent.triggers || []) {
      if (trigger.logic?.script) {
        const script = trigger.logic.script;
        const roleMatches = script.match(/getAgentsByRole\(['"](\w+)['"]\)/g);

        if (roleMatches) {
          for (const match of roleMatches) {
            const role = match.match(/['"](\w+)['"]/)[1];
            if (!roles.has(role)) {
              // Check if the logic depends on this role for critical decisions
              const isCritical =
                /\.length\s*[><=!]/.test(script) || // Checking count
                /allResponded/.test(script) || // Waiting for responses
                /hasConsensus/.test(script); // Consensus check

              // Check if logic has a valid "zero length" fallback pattern
              // e.g., "if (validators.length === 0) return true" handles missing role gracefully
              const hasZeroLengthFallback =
                /\.length\s*===?\s*0\s*\)\s*return/.test(script) || // length === 0) return
                /\.length\s*[<]=\s*0/.test(script); // length <= 0 or length < 1

              if (isCritical && !hasZeroLengthFallback) {
                errors.push(
                  `[Gap 15] ${prefix}: Logic references role '${role}' which doesn't exist. ` +
                    `This will cause logic to fail. Fix: Add agent with role '${role}' or update logic.`
                );
              }
            }
          }
        }
      }
    }
  }

  return { errors, warnings };
}

function resolveProviderName(agent, config, settings) {
  const resolved =
    config.forceProvider ||
    agent.provider ||
    config.defaultProvider ||
    settings.defaultProvider ||
    'claude';
  return normalizeProviderName(resolved) || 'claude';
}

function validateProviderLevel(provider, requestedLevel, minLevel, maxLevel) {
  const providerModule = getProvider(provider);
  const levels = providerModule.getLevelMapping();
  const rank = (level) => levels[level]?.rank;

  if (!levels[requestedLevel]) {
    throw new Error(`Invalid level "${requestedLevel}" for provider "${provider}"`);
  }

  if (minLevel && !levels[minLevel]) {
    throw new Error(`Invalid minLevel "${minLevel}" for provider "${provider}"`);
  }

  if (maxLevel && !levels[maxLevel]) {
    throw new Error(`Invalid maxLevel "${maxLevel}" for provider "${provider}"`);
  }

  if (minLevel && maxLevel && rank(minLevel) > rank(maxLevel)) {
    throw new Error(
      `minLevel "${minLevel}" exceeds maxLevel "${maxLevel}" for provider "${provider}"`
    );
  }

  if (maxLevel && rank(requestedLevel) > rank(maxLevel)) {
    throw new Error(
      `Level "${requestedLevel}" exceeds maxLevel "${maxLevel}" for provider "${provider}"`
    );
  }

  if (minLevel && rank(requestedLevel) < rank(minLevel)) {
    throw new Error(
      `Level "${requestedLevel}" is below minLevel "${minLevel}" for provider "${provider}"`
    );
  }

  return requestedLevel;
}

function validateProviderSettings(provider, providerSettings) {
  const providerModule = getProvider(provider);
  const levels = providerModule.getLevelMapping();
  const settings = providerSettings || {};

  const minLevel = settings.minLevel || providerModule.getDefaultMinLevel?.();
  const maxLevel = settings.maxLevel || providerModule.getDefaultMaxLevel?.();
  const defaultLevel = settings.defaultLevel || providerModule.getDefaultLevel();

  validateProviderLevel(provider, defaultLevel, minLevel, maxLevel);

  for (const [level, override] of Object.entries(settings.levelOverrides || {})) {
    if (!levels[level]) {
      throw new Error(`Unknown level "${level}" in overrides for provider "${provider}"`);
    }
    if (override?.model && (typeof override.model !== 'string' || !override.model.trim())) {
      throw new Error(
        `Invalid model override (must be non-empty string) for provider "${provider}"`
      );
    }
    if (override?.reasoningEffort && !['codex', 'opencode'].includes(provider)) {
      throw new Error(`reasoningEffort overrides are only supported for Codex and Opencode`);
    }
    if (
      override?.reasoningEffort &&
      !['low', 'medium', 'high', 'xhigh'].includes(override.reasoningEffort)
    ) {
      throw new Error(
        `Invalid reasoningEffort "${override.reasoningEffort}" (low|medium|high|xhigh)`
      );
    }
  }
}

function validateProviderFeatures(config, settings) {
  const errors = [];
  const warnings = [];

  const providersToValidate = VALID_PROVIDERS;

  for (const provider of providersToValidate) {
    try {
      validateProviderSettings(provider, settings.providerSettings?.[provider]);
    } catch (err) {
      errors.push(err.message);
    }
  }

  if (!config.agents || !Array.isArray(config.agents)) {
    return { errors, warnings };
  }

  for (const agent of config.agents) {
    if (agent.type === 'subcluster') {
      continue;
    }

    const provider = resolveProviderName(agent, config, settings);
    if (!VALID_PROVIDERS.includes(provider)) {
      errors.push(`Agent "${agent.id}" references unknown provider "${provider}"`);
      continue;
    }

    const providerModule = getProvider(provider);
    const levels = providerModule.getLevelMapping();
    const catalog = providerModule.getModelCatalog();
    const providerSettings = settings.providerSettings?.[provider] || {};
    const minLevel = providerSettings.minLevel;
    const maxLevel = providerSettings.maxLevel;
    const rank = (level) => levels[level]?.rank;

    if (agent.jsonSchema) {
      const cap = CAPABILITIES[provider]?.jsonSchema;
      if (cap === 'experimental') {
        warnings.push(
          `Agent "${agent.id}" uses jsonSchema with ${provider} provider - ` +
            `this feature is experimental and may not work reliably`
        );
      } else if (!cap) {
        warnings.push(
          `Agent "${agent.id}" uses jsonSchema but ${provider} provider doesn't support it`
        );
      }
    }

    if (agent.modelLevel && !levels[agent.modelLevel]) {
      warnings.push(
        `Agent "${agent.id}" uses modelLevel "${agent.modelLevel}" which is not valid for ${provider}`
      );
    }

    if (agent.model) {
      if (!catalog[agent.model]) {
        warnings.push(
          `Agent "${agent.id}" uses model "${agent.model}" which is not valid for ${provider}`
        );
      }
    } else if (agent.modelLevel && minLevel && maxLevel) {
      if (rank(minLevel) > rank(maxLevel)) {
        warnings.push(
          `Provider "${provider}" has minLevel "${minLevel}" above maxLevel "${maxLevel}"`
        );
      } else if (rank(agent.modelLevel) < rank(minLevel)) {
        warnings.push(
          `Agent "${agent.id}" uses modelLevel "${agent.modelLevel}" below minLevel "${minLevel}" for ${provider}`
        );
      } else if (rank(agent.modelLevel) > rank(maxLevel)) {
        warnings.push(
          `Agent "${agent.id}" uses modelLevel "${agent.modelLevel}" above maxLevel "${maxLevel}" for ${provider}`
        );
      }
    }

    if (agent.modelRules && Array.isArray(agent.modelRules)) {
      for (const rule of agent.modelRules) {
        if (rule.modelLevel && !levels[rule.modelLevel]) {
          warnings.push(
            `Agent "${agent.id}" uses modelLevel "${rule.modelLevel}" in modelRules which is not valid for ${provider}`
          );
        }
        if (rule.model && !catalog[rule.model]) {
          warnings.push(
            `Agent "${agent.id}" uses model "${rule.model}" in modelRules which is not valid for ${provider}`
          );
        }
      }
    }

    if (agent.reasoningEffort && !['codex', 'opencode'].includes(provider)) {
      warnings.push(`Agent "${agent.id}" sets reasoningEffort but ${provider} does not support it`);
    } else if (
      agent.reasoningEffort &&
      !['low', 'medium', 'high', 'xhigh'].includes(agent.reasoningEffort)
    ) {
      warnings.push(
        `Agent "${agent.id}" has invalid reasoningEffort "${agent.reasoningEffort}" (low|medium|high|xhigh)`
      );
    }
  }

  return { errors, warnings };
}

module.exports = {
  validateConfig,
  isConductorConfig,
  validateBasicStructure,
  analyzeMessageFlow,
  validateAgents,
  validateLogicScripts,
  isValidIterationPattern,
  formatValidationResult,
  // Phase 5: Template variable validation
  validateTemplateVariables,
  extractTemplateVariables,
  extractSchemaProperties,
  validateAgentTemplateVariables,
  // Phase 6-9: Semantic validation
  validateHookSemantics,
  validateRuleCoverage,
  detectNAgentCycles,
  validateConfigSemantics,
  validateProviderLevel,
  validateProviderSettings,
  validateProviderFeatures,
  groupConsecutive,
};
