/**
 * HandoffExtractor - Extract structured handoff data from agent messages
 *
 * Extracts from multiple sources:
 * - IMPLEMENTATION_READY.summary → done items
 * - IMPLEMENTATION_READY.completionStatus.nextSteps → remaining
 * - IMPLEMENTATION_READY.completionStatus.blockers → remaining (prefixed)
 * - VALIDATION_RESULT.errors → remaining (if validation failed)
 * - AGENT_OUTPUT text matching 'td log --decision' → decisions
 * - AGENT_OUTPUT text matching 'TODO:' → remaining
 *
 * Returns: { done[], remaining[], decisions[], uncertain[] }
 */

/**
 * @typedef {Object} HandoffData
 * @property {string[]} done - Completed items
 * @property {string[]} remaining - Items still to be done
 * @property {string[]} decisions - Key decisions made
 * @property {string[]} uncertain - Uncertainties or blockers
 */

/**
 * Extract structured handoff data from ledger messages
 * @param {Array<Object>} messages - Messages from ledger.query()
 * @returns {HandoffData}
 * @throws {TypeError} If messages is not an array
 */
function extractHandoffData(messages) {
  if (!Array.isArray(messages)) {
    throw new TypeError('extractHandoffData: messages must be an array');
  }

  const data = {
    done: [],
    remaining: [],
    decisions: [],
    uncertain: [],
  };

  for (const msg of messages) {
    const topic = msg.topic;
    const content = msg.content;

    if (!content) continue;

    // Parse content if it's a string
    let parsed = content;
    if (typeof content === 'string') {
      try {
        parsed = JSON.parse(content);
      } catch {
        parsed = { text: content };
      }
    }

    switch (topic) {
      case 'IMPLEMENTATION_READY':
        extractFromImplementationReady(parsed, data);
        break;

      case 'VALIDATION_RESULT':
        extractFromValidationResult(parsed, data);
        break;

      case 'AGENT_OUTPUT':
        extractFromAgentOutput(parsed, data);
        break;

      case 'CLUSTER_COMPLETE':
        extractFromClusterComplete(parsed, data);
        break;

      case 'CLUSTER_FAILED':
        extractFromClusterFailed(parsed, data);
        break;
    }
  }

  // Deduplicate
  data.done = [...new Set(data.done)];
  data.remaining = [...new Set(data.remaining)];
  data.decisions = [...new Set(data.decisions)];
  data.uncertain = [...new Set(data.uncertain)];

  return data;
}

/**
 * Extract from IMPLEMENTATION_READY message
 */
function extractFromImplementationReady(content, data) {
  // Summary → done items
  if (content.summary) {
    data.done.push(content.summary);
  }

  // Completion status details
  if (content.completionStatus) {
    const status = content.completionStatus;

    // Next steps → remaining
    if (Array.isArray(status.nextSteps)) {
      data.remaining.push(...status.nextSteps);
    } else if (status.nextSteps) {
      data.remaining.push(status.nextSteps);
    }

    // Blockers → remaining (prefixed)
    if (Array.isArray(status.blockers)) {
      data.remaining.push(...status.blockers.map((b) => `BLOCKER: ${b}`));
      data.uncertain.push(...status.blockers);
    } else if (status.blockers) {
      data.remaining.push(`BLOCKER: ${status.blockers}`);
      data.uncertain.push(status.blockers);
    }
  }

  // Files changed can indicate work done
  if (content.filesChanged && Array.isArray(content.filesChanged)) {
    const fileCount = content.filesChanged.length;
    if (fileCount > 0) {
      data.done.push(
        `Modified ${fileCount} file(s): ${content.filesChanged.slice(0, 3).join(', ')}${fileCount > 3 ? '...' : ''}`
      );
    }
  }
}

/**
 * Extract from VALIDATION_RESULT message
 */
function extractFromValidationResult(content, data) {
  // If validation passed
  if (content.status === 'passed' || content.passed) {
    data.done.push('Validation passed');
    return;
  }

  // If validation failed, errors become remaining items
  if (content.errors && Array.isArray(content.errors)) {
    data.remaining.push(...content.errors.map((e) => `Fix: ${e}`));
  } else if (content.errors) {
    data.remaining.push(`Fix: ${content.errors}`);
  }

  // Validation feedback
  if (content.feedback) {
    data.remaining.push(content.feedback);
  }
}

/**
 * Extract from AGENT_OUTPUT message
 */
function extractFromAgentOutput(content, data) {
  const text = content.text || content.output || (typeof content === 'string' ? content : '');
  if (!text) return;

  // Look for td log --decision patterns
  const decisionMatches = text.match(/td log[^"]*--decision[^"]*"([^"]+)"/g);
  if (decisionMatches) {
    for (const match of decisionMatches) {
      const extracted = match.match(/"([^"]+)"$/);
      if (extracted) {
        data.decisions.push(extracted[1]);
      }
    }
  }

  // Look for TODO: patterns
  const todoMatches = text.match(/TODO:\s*(.+?)(?:\n|$)/gi);
  if (todoMatches) {
    for (const match of todoMatches) {
      const item = match.replace(/^TODO:\s*/i, '').trim();
      if (item) {
        data.remaining.push(item);
      }
    }
  }

  // Look for FIX-ME patterns (code fix markers)
  const fixmeMatches = text.match(/FIXME:\s*(.+?)(?:\n|$)/gi);
  if (fixmeMatches) {
    for (const match of fixmeMatches) {
      const item = match.replace(/^FIXME:\s*/i, '').trim();
      if (item) {
        data.remaining.push(`FIXME: ${item}`);
      }
    }
  }

  // Look for explicit uncertainty patterns
  const uncertainMatches = text.match(/(?:uncertain|unsure|unclear|not sure)[:\s]+(.+?)(?:\n|$)/gi);
  if (uncertainMatches) {
    for (const match of uncertainMatches) {
      const item = match.replace(/^(?:uncertain|unsure|unclear|not sure)[:\s]+/i, '').trim();
      if (item) {
        data.uncertain.push(item);
      }
    }
  }
}

/**
 * Extract from CLUSTER_COMPLETE message
 */
function extractFromClusterComplete(content, data) {
  if (content.summary) {
    data.done.push(content.summary);
  }
  if (content.result) {
    data.done.push(content.result);
  }
}

/**
 * Extract from CLUSTER_FAILED message
 */
function extractFromClusterFailed(content, data) {
  if (content.error) {
    data.uncertain.push(`Failed: ${content.error}`);
  }
  if (content.reason) {
    data.uncertain.push(`Failed: ${content.reason}`);
  }
}

/**
 * Build td handoff command args (no shell parsing, safe from injection)
 * @param {string} issueId - TD issue ID
 * @param {HandoffData} data - Extracted handoff data
 * @returns {{ command: string, args: string[] }} Command and args for spawnSync
 * @throws {TypeError} If issueId is not a string or data is not a valid HandoffData object
 */
function buildHandoffCommand(issueId, data) {
  if (typeof issueId !== 'string' || !issueId) {
    throw new TypeError('buildHandoffCommand: issueId must be a non-empty string');
  }
  if (!data || typeof data !== 'object') {
    throw new TypeError('buildHandoffCommand: data must be an object');
  }
  if (
    !Array.isArray(data.done) ||
    !Array.isArray(data.remaining) ||
    !Array.isArray(data.decisions) ||
    !Array.isArray(data.uncertain)
  ) {
    throw new TypeError(
      'buildHandoffCommand: data must have done, remaining, decisions, and uncertain arrays'
    );
  }

  const args = ['handoff', issueId];

  // Add done items (max 5)
  for (const item of data.done.slice(0, 5)) {
    args.push('--done', truncateArg(item));
  }

  // Add remaining items (max 5)
  for (const item of data.remaining.slice(0, 5)) {
    args.push('--remaining', truncateArg(item));
  }

  // Add decisions (max 3)
  for (const item of data.decisions.slice(0, 3)) {
    args.push('--decision', truncateArg(item));
  }

  // Add uncertainties (max 3)
  for (const item of data.uncertain.slice(0, 3)) {
    args.push('--uncertain', truncateArg(item));
  }

  return { command: 'td', args };
}

/**
 * Truncate argument to reasonable length
 * @param {string} str - String to truncate
 * @param {number} [maxLen=100] - Maximum length
 * @returns {string} Truncated string
 */
function truncateArg(str, maxLen = 100) {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen) + '...';
}

/**
 * Check if handoff data is meaningful (has any content)
 * @param {HandoffData} data
 * @returns {boolean}
 */
function hasContent(data) {
  return (
    data.done.length > 0 ||
    data.remaining.length > 0 ||
    data.decisions.length > 0 ||
    data.uncertain.length > 0
  );
}

/**
 * Format handoff data as human-readable string
 * @param {HandoffData} data
 * @returns {string}
 */
function formatHandoffData(data) {
  const lines = [];

  if (data.done.length > 0) {
    lines.push('DONE:');
    data.done.forEach((item) => lines.push(`  - ${item}`));
  }

  if (data.remaining.length > 0) {
    lines.push('REMAINING:');
    data.remaining.forEach((item) => lines.push(`  - ${item}`));
  }

  if (data.decisions.length > 0) {
    lines.push('DECISIONS:');
    data.decisions.forEach((item) => lines.push(`  - ${item}`));
  }

  if (data.uncertain.length > 0) {
    lines.push('UNCERTAIN:');
    data.uncertain.forEach((item) => lines.push(`  - ${item}`));
  }

  return lines.join('\n');
}

/**
 * Extract handoff data with optional LLM summarization
 *
 * Uses a fast model (haiku/level1) to generate richer handoff summaries
 * from the full agent conversation when LLM is available.
 *
 * @param {Array<Object>} messages - Messages from ledger.query()
 * @param {Object} [options] - Options
 * @param {Function} [options.summarizer] - LLM summarization function (async)
 * @param {boolean} [options.enabled=false] - Whether to use LLM summarization
 * @returns {Promise<HandoffData>}
 * @throws {TypeError} If messages is not an array
 */
async function extractWithSummarization(messages, options = {}) {
  if (!Array.isArray(messages)) {
    throw new TypeError('extractWithSummarization: messages must be an array');
  }

  // Always start with basic extraction
  const basicData = extractHandoffData(messages);

  // If summarization not enabled or no summarizer provided, return basic
  if (!options.enabled || !options.summarizer) {
    return basicData;
  }

  try {
    // Build conversation text for summarization
    const conversationText = buildConversationText(messages);
    if (!conversationText) {
      return basicData;
    }

    // Call the summarizer
    const summaryResult = await options.summarizer(conversationText);
    if (!summaryResult) {
      return basicData;
    }

    // Merge LLM summary with basic extraction
    return mergeHandoffData(basicData, parseSummaryResult(summaryResult));
  } catch {
    // On any LLM failure, fall back to basic extraction
    return basicData;
  }
}

/**
 * Build conversation text for LLM summarization
 * @param {Array<Object>} messages
 * @returns {string}
 */
function buildConversationText(messages) {
  const lines = [];

  for (const msg of messages) {
    const topic = msg.topic;
    const content = msg.content;

    if (!content) continue;

    let text = '';
    if (typeof content === 'string') {
      try {
        const parsed = JSON.parse(content);
        text = parsed.text || parsed.summary || JSON.stringify(parsed);
      } catch {
        text = content;
      }
    } else if (content.text) {
      text = content.text;
    } else if (content.summary) {
      text = content.summary;
    }

    if (text) {
      lines.push(`[${topic}] ${text.substring(0, 500)}`);
    }
  }

  return lines.join('\n');
}

/**
 * Parse LLM summary result into HandoffData format
 * @param {string} result - LLM response text
 * @returns {HandoffData}
 */
function parseSummaryResult(result) {
  const data = {
    done: [],
    remaining: [],
    decisions: [],
    uncertain: [],
  };

  // Parse sections from LLM response
  const sections = {
    DONE: 'done',
    REMAINING: 'remaining',
    DECISIONS: 'decisions',
    QUESTIONS: 'uncertain',
    UNCERTAIN: 'uncertain',
  };

  let currentSection = null;

  for (const line of result.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check for section headers
    let isHeader = false;
    for (const [header, field] of Object.entries(sections)) {
      if (trimmed.toUpperCase().startsWith(header)) {
        currentSection = field;
        isHeader = true;
        break;
      }
    }

    // Skip header lines, only add content
    if (isHeader) continue;

    // Add content to current section
    if (currentSection) {
      const content = trimmed.replace(/^[-*•]\s*/, '').replace(/^\d+\.\s*/, '');
      if (content) {
        data[currentSection].push(content);
      }
    }
  }

  return data;
}

/**
 * Merge two HandoffData objects, deduplicating
 * @param {HandoffData} base - Base extraction
 * @param {HandoffData} llm - LLM extraction
 * @returns {HandoffData}
 */
function mergeHandoffData(base, llm) {
  return {
    done: [...new Set([...base.done, ...llm.done])],
    remaining: [...new Set([...base.remaining, ...llm.remaining])],
    decisions: [...new Set([...base.decisions, ...llm.decisions])],
    uncertain: [...new Set([...base.uncertain, ...llm.uncertain])],
  };
}

/**
 * Default summarization prompt for LLM
 */
const SUMMARIZATION_PROMPT = `Summarize this agent conversation into:
1. DONE: What was completed
2. REMAINING: What still needs work
3. DECISIONS: Key choices made and why
4. QUESTIONS: Uncertainties or blockers

Be concise. Use bullet points.`;

module.exports = {
  extractHandoffData,
  extractWithSummarization,
  buildHandoffCommand,
  truncateArg,
  hasContent,
  formatHandoffData,
  // For testing
  buildConversationText,
  parseSummaryResult,
  mergeHandoffData,
  SUMMARIZATION_PROMPT,
};
