/**
 * Test: HandoffExtractor
 *
 * Tests the extraction of structured handoff data from agent messages.
 */

const assert = require('assert');
const {
  extractHandoffData,
  extractWithSummarization,
  buildHandoffCommand,
  truncateArg,
  hasContent,
  formatHandoffData,
  buildConversationText,
  parseSummaryResult,
  mergeHandoffData,
  SUMMARIZATION_PROMPT,
} = require('../../src/td/handoff-extractor');

describe('HandoffExtractor', function () {
  describe('extractHandoffData()', function () {
    it('should return empty structure for empty messages', function () {
      const result = extractHandoffData([]);
      assert.deepStrictEqual(result, {
        done: [],
        remaining: [],
        decisions: [],
        uncertain: [],
      });
    });

    it('should extract from IMPLEMENTATION_READY summary', function () {
      const messages = [
        {
          topic: 'IMPLEMENTATION_READY',
          content: { summary: 'Implemented feature X' },
        },
      ];
      const result = extractHandoffData(messages);
      assert.ok(result.done.includes('Implemented feature X'));
    });

    it('should extract nextSteps from IMPLEMENTATION_READY', function () {
      const messages = [
        {
          topic: 'IMPLEMENTATION_READY',
          content: {
            completionStatus: {
              nextSteps: ['Add tests', 'Update docs'],
            },
          },
        },
      ];
      const result = extractHandoffData(messages);
      assert.ok(result.remaining.includes('Add tests'));
      assert.ok(result.remaining.includes('Update docs'));
    });

    it('should extract blockers from IMPLEMENTATION_READY', function () {
      const messages = [
        {
          topic: 'IMPLEMENTATION_READY',
          content: {
            completionStatus: {
              blockers: ['Need API key'],
            },
          },
        },
      ];
      const result = extractHandoffData(messages);
      assert.ok(result.remaining.some((r) => r.includes('BLOCKER: Need API key')));
      assert.ok(result.uncertain.includes('Need API key'));
    });

    it('should extract files changed count', function () {
      const messages = [
        {
          topic: 'IMPLEMENTATION_READY',
          content: {
            filesChanged: ['src/foo.js', 'src/bar.js', 'src/baz.js'],
          },
        },
      ];
      const result = extractHandoffData(messages);
      assert.ok(result.done.some((d) => d.includes('Modified 3 file(s)')));
    });

    it('should extract from VALIDATION_RESULT passed', function () {
      const messages = [
        {
          topic: 'VALIDATION_RESULT',
          content: { status: 'passed' },
        },
      ];
      const result = extractHandoffData(messages);
      assert.ok(result.done.includes('Validation passed'));
    });

    it('should extract errors from VALIDATION_RESULT failed', function () {
      const messages = [
        {
          topic: 'VALIDATION_RESULT',
          content: {
            status: 'failed',
            errors: ['Type error in line 10', 'Missing import'],
          },
        },
      ];
      const result = extractHandoffData(messages);
      assert.ok(result.remaining.includes('Fix: Type error in line 10'));
      assert.ok(result.remaining.includes('Fix: Missing import'));
    });

    it('should extract TODO: patterns from AGENT_OUTPUT', function () {
      const messages = [
        {
          topic: 'AGENT_OUTPUT',
          content: { text: 'Making progress.\nTODO: Add error handling\nDone for now.' },
        },
      ];
      const result = extractHandoffData(messages);
      assert.ok(result.remaining.includes('Add error handling'));
    });

    it('should extract td log --decision patterns', function () {
      const messages = [
        {
          topic: 'AGENT_OUTPUT',
          content: { text: 'Running td log --decision "Used async/await over callbacks"' },
        },
      ];
      const result = extractHandoffData(messages);
      assert.ok(result.decisions.includes('Used async/await over callbacks'));
    });

    it('should extract FIXME: patterns', function () {
      const messages = [
        {
          topic: 'AGENT_OUTPUT',
          content: { text: 'FIXME: Handle edge case with empty input' },
        },
      ];
      const result = extractHandoffData(messages);
      assert.ok(result.remaining.some((r) => r.includes('FIXME:')));
    });

    it('should extract from CLUSTER_COMPLETE', function () {
      const messages = [
        {
          topic: 'CLUSTER_COMPLETE',
          content: { summary: 'Feature fully implemented' },
        },
      ];
      const result = extractHandoffData(messages);
      assert.ok(result.done.includes('Feature fully implemented'));
    });

    it('should extract from CLUSTER_FAILED', function () {
      const messages = [
        {
          topic: 'CLUSTER_FAILED',
          content: { error: 'Out of context' },
        },
      ];
      const result = extractHandoffData(messages);
      assert.ok(result.uncertain.some((u) => u.includes('Failed: Out of context')));
    });

    it('should handle string content', function () {
      const messages = [
        {
          topic: 'AGENT_OUTPUT',
          content: 'TODO: Review this later',
        },
      ];
      const result = extractHandoffData(messages);
      assert.ok(result.remaining.includes('Review this later'));
    });

    it('should handle JSON string content', function () {
      const messages = [
        {
          topic: 'IMPLEMENTATION_READY',
          content: JSON.stringify({ summary: 'Completed task' }),
        },
      ];
      const result = extractHandoffData(messages);
      assert.ok(result.done.includes('Completed task'));
    });

    it('should deduplicate items', function () {
      const messages = [
        { topic: 'CLUSTER_COMPLETE', content: { summary: 'Done' } },
        { topic: 'CLUSTER_COMPLETE', content: { summary: 'Done' } },
      ];
      const result = extractHandoffData(messages);
      assert.strictEqual(result.done.filter((d) => d === 'Done').length, 1);
    });

    it('should handle null content gracefully', function () {
      const messages = [{ topic: 'IMPLEMENTATION_READY', content: null }];
      const result = extractHandoffData(messages);
      assert.deepStrictEqual(result.done, []);
    });
  });

  describe('buildHandoffCommand()', function () {
    it('should return command and args object', function () {
      const data = {
        done: ['Implemented feature'],
        remaining: [],
        decisions: [],
        uncertain: [],
      };
      const result = buildHandoffCommand('td-abc123', data);
      assert.strictEqual(result.command, 'td');
      assert.ok(Array.isArray(result.args));
      assert.strictEqual(result.args[0], 'handoff');
      assert.strictEqual(result.args[1], 'td-abc123');
    });

    it('should include --done flag with value as separate args', function () {
      const data = {
        done: ['Implemented feature'],
        remaining: [],
        decisions: [],
        uncertain: [],
      };
      const result = buildHandoffCommand('td-abc123', data);
      const doneIdx = result.args.indexOf('--done');
      assert.ok(doneIdx >= 0, 'Should have --done flag');
      assert.strictEqual(result.args[doneIdx + 1], 'Implemented feature');
    });

    it('should include all flag types', function () {
      const data = {
        done: ['Task 1'],
        remaining: ['Task 2'],
        decisions: ['Choice A'],
        uncertain: ['Question X'],
      };
      const result = buildHandoffCommand('td-xyz', data);
      assert.ok(result.args.includes('--done'));
      assert.ok(result.args.includes('--remaining'));
      assert.ok(result.args.includes('--decision'));
      assert.ok(result.args.includes('--uncertain'));
    });

    it('should limit items to 5 done, 5 remaining, 3 decisions, 3 uncertain', function () {
      const data = {
        done: ['1', '2', '3', '4', '5', '6', '7'],
        remaining: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
        decisions: ['x', 'y', 'z', 'w'],
        uncertain: ['i', 'j', 'k', 'l'],
      };
      const result = buildHandoffCommand('td-test', data);
      // Count occurrences
      const doneCount = result.args.filter((a) => a === '--done').length;
      const remainingCount = result.args.filter((a) => a === '--remaining').length;
      const decisionCount = result.args.filter((a) => a === '--decision').length;
      const uncertainCount = result.args.filter((a) => a === '--uncertain').length;

      assert.strictEqual(doneCount, 5);
      assert.strictEqual(remainingCount, 5);
      assert.strictEqual(decisionCount, 3);
      assert.strictEqual(uncertainCount, 3);
    });
  });

  describe('truncateArg()', function () {
    it('should return short strings unchanged', function () {
      assert.strictEqual(truncateArg('hello'), 'hello');
    });

    it('should truncate strings over 100 chars by default', function () {
      const long = 'a'.repeat(150);
      const result = truncateArg(long);
      assert.strictEqual(result.length, 103); // 100 + '...'
      assert.ok(result.endsWith('...'));
    });

    it('should respect custom maxLen', function () {
      const long = 'a'.repeat(50);
      const result = truncateArg(long, 20);
      assert.strictEqual(result.length, 23); // 20 + '...'
    });
  });

  describe('hasContent()', function () {
    it('should return false for empty data', function () {
      const data = { done: [], remaining: [], decisions: [], uncertain: [] };
      assert.strictEqual(hasContent(data), false);
    });

    it('should return true if any field has content', function () {
      assert.strictEqual(
        hasContent({ done: ['x'], remaining: [], decisions: [], uncertain: [] }),
        true
      );
      assert.strictEqual(
        hasContent({ done: [], remaining: ['x'], decisions: [], uncertain: [] }),
        true
      );
      assert.strictEqual(
        hasContent({ done: [], remaining: [], decisions: ['x'], uncertain: [] }),
        true
      );
      assert.strictEqual(
        hasContent({ done: [], remaining: [], decisions: [], uncertain: ['x'] }),
        true
      );
    });
  });

  describe('formatHandoffData()', function () {
    it('should format all sections', function () {
      const data = {
        done: ['Task 1', 'Task 2'],
        remaining: ['Todo 1'],
        decisions: ['Choice A'],
        uncertain: ['Question'],
      };
      const result = formatHandoffData(data);
      assert.ok(result.includes('DONE:'));
      assert.ok(result.includes('- Task 1'));
      assert.ok(result.includes('REMAINING:'));
      assert.ok(result.includes('DECISIONS:'));
      assert.ok(result.includes('UNCERTAIN:'));
    });

    it('should skip empty sections', function () {
      const data = {
        done: ['Only done'],
        remaining: [],
        decisions: [],
        uncertain: [],
      };
      const result = formatHandoffData(data);
      assert.ok(result.includes('DONE:'));
      assert.ok(!result.includes('REMAINING:'));
      assert.ok(!result.includes('DECISIONS:'));
      assert.ok(!result.includes('UNCERTAIN:'));
    });
  });

  describe('extractWithSummarization()', function () {
    it('should return basic extraction when not enabled', async function () {
      const messages = [{ topic: 'CLUSTER_COMPLETE', content: { summary: 'Task done' } }];
      const result = await extractWithSummarization(messages, { enabled: false });
      assert.ok(result.done.includes('Task done'));
    });

    it('should return basic extraction when no summarizer provided', async function () {
      const messages = [{ topic: 'CLUSTER_COMPLETE', content: { summary: 'Task done' } }];
      const result = await extractWithSummarization(messages, { enabled: true });
      assert.ok(result.done.includes('Task done'));
    });

    it('should call summarizer when enabled', async function () {
      let called = false;
      const mockSummarizer = () => {
        called = true;
        return Promise.resolve('DONE:\n- LLM extracted this');
      };
      const messages = [{ topic: 'AGENT_OUTPUT', content: { text: 'Some work happened' } }];
      await extractWithSummarization(messages, {
        enabled: true,
        summarizer: mockSummarizer,
      });
      assert.ok(called, 'Summarizer should be called');
    });

    it('should merge LLM results with basic extraction', async function () {
      const mockSummarizer = () => Promise.resolve('DONE:\n- LLM found this done');
      const messages = [
        { topic: 'CLUSTER_COMPLETE', content: { summary: 'Basic extraction' } },
        { topic: 'AGENT_OUTPUT', content: { text: 'Some conversation' } },
      ];
      const result = await extractWithSummarization(messages, {
        enabled: true,
        summarizer: mockSummarizer,
      });
      assert.ok(result.done.includes('Basic extraction'));
      assert.ok(result.done.includes('LLM found this done'));
    });

    it('should fall back to basic on summarizer failure', async function () {
      const mockSummarizer = () => Promise.reject(new Error('LLM failed'));
      const messages = [
        { topic: 'CLUSTER_COMPLETE', content: { summary: 'Basic works' } },
        { topic: 'AGENT_OUTPUT', content: { text: 'Some text' } },
      ];
      const result = await extractWithSummarization(messages, {
        enabled: true,
        summarizer: mockSummarizer,
      });
      assert.ok(result.done.includes('Basic works'));
    });
  });

  describe('buildConversationText()', function () {
    it('should build text from messages', function () {
      const messages = [
        { topic: 'AGENT_OUTPUT', content: { text: 'Hello world' } },
        { topic: 'IMPLEMENTATION_READY', content: { summary: 'Done' } },
      ];
      const result = buildConversationText(messages);
      assert.ok(result.includes('[AGENT_OUTPUT] Hello world'));
      assert.ok(result.includes('[IMPLEMENTATION_READY] Done'));
    });

    it('should handle string content', function () {
      const messages = [{ topic: 'AGENT_OUTPUT', content: 'Plain string' }];
      const result = buildConversationText(messages);
      assert.ok(result.includes('Plain string'));
    });

    it('should truncate long text', function () {
      const longText = 'a'.repeat(1000);
      const messages = [{ topic: 'AGENT_OUTPUT', content: { text: longText } }];
      const result = buildConversationText(messages);
      assert.ok(result.length < 600); // 500 + overhead
    });
  });

  describe('parseSummaryResult()', function () {
    it('should parse DONE section', function () {
      const result = parseSummaryResult('DONE:\n- Item 1\n- Item 2');
      assert.deepStrictEqual(result.done, ['Item 1', 'Item 2']);
    });

    it('should parse REMAINING section', function () {
      const result = parseSummaryResult('REMAINING:\n1. Todo 1\n2. Todo 2');
      assert.deepStrictEqual(result.remaining, ['Todo 1', 'Todo 2']);
    });

    it('should parse DECISIONS section', function () {
      const result = parseSummaryResult('DECISIONS:\n* Choice A');
      assert.deepStrictEqual(result.decisions, ['Choice A']);
    });

    it('should parse QUESTIONS as uncertain', function () {
      const result = parseSummaryResult('QUESTIONS:\n- What about X?');
      assert.deepStrictEqual(result.uncertain, ['What about X?']);
    });

    it('should handle mixed sections', function () {
      const text = `DONE:
- Task 1
REMAINING:
- Task 2
DECISIONS:
- Choice A`;
      const result = parseSummaryResult(text);
      assert.ok(result.done.includes('Task 1'));
      assert.ok(result.remaining.includes('Task 2'));
      assert.ok(result.decisions.includes('Choice A'));
    });
  });

  describe('mergeHandoffData()', function () {
    it('should merge and deduplicate', function () {
      const base = { done: ['A', 'B'], remaining: ['X'], decisions: [], uncertain: [] };
      const llm = { done: ['B', 'C'], remaining: ['Y'], decisions: ['D'], uncertain: [] };
      const result = mergeHandoffData(base, llm);
      assert.deepStrictEqual(result.done, ['A', 'B', 'C']);
      assert.deepStrictEqual(result.remaining, ['X', 'Y']);
      assert.deepStrictEqual(result.decisions, ['D']);
    });
  });

  describe('SUMMARIZATION_PROMPT', function () {
    it('should contain key sections', function () {
      assert.ok(SUMMARIZATION_PROMPT.includes('DONE'));
      assert.ok(SUMMARIZATION_PROMPT.includes('REMAINING'));
      assert.ok(SUMMARIZATION_PROMPT.includes('DECISIONS'));
      assert.ok(SUMMARIZATION_PROMPT.includes('QUESTIONS'));
    });
  });

  describe('buildHandoffCommand() shell injection security', function () {
    it('should preserve $(malicious) verbatim in args without execution', function () {
      const data = {
        done: ['$(whoami)'],
        remaining: ['$(rm -rf /)'],
        decisions: [],
        uncertain: [],
      };
      const result = buildHandoffCommand('td-sec1', data);
      const doneIdx = result.args.indexOf('--done');
      const remainingIdx = result.args.indexOf('--remaining');
      assert.strictEqual(result.args[doneIdx + 1], '$(whoami)');
      assert.strictEqual(result.args[remainingIdx + 1], '$(rm -rf /)');
    });

    it('should preserve semicolon injection payload verbatim in args', function () {
      const data = {
        done: ['task done; rm -rf /'],
        remaining: ['; cat /etc/passwd'],
        decisions: [],
        uncertain: [],
      };
      const result = buildHandoffCommand('td-sec2', data);
      const doneIdx = result.args.indexOf('--done');
      const remainingIdx = result.args.indexOf('--remaining');
      assert.strictEqual(result.args[doneIdx + 1], 'task done; rm -rf /');
      assert.strictEqual(result.args[remainingIdx + 1], '; cat /etc/passwd');
    });

    it('should preserve backtick injection payload verbatim in args', function () {
      const data = {
        done: ['`whoami`'],
        remaining: ['task `id`'],
        decisions: ['`cat /etc/passwd`'],
        uncertain: [],
      };
      const result = buildHandoffCommand('td-sec3', data);
      const doneIdx = result.args.indexOf('--done');
      const remainingIdx = result.args.indexOf('--remaining');
      const decisionIdx = result.args.indexOf('--decision');
      assert.strictEqual(result.args[doneIdx + 1], '`whoami`');
      assert.strictEqual(result.args[remainingIdx + 1], 'task `id`');
      assert.strictEqual(result.args[decisionIdx + 1], '`cat /etc/passwd`');
    });

    it('should handle mixed injection payloads in all fields', function () {
      const data = {
        done: ['$(malicious)'],
        remaining: ['; rm -rf /'],
        decisions: ['`whoami`'],
        uncertain: ['$(id) && cat /etc/shadow'],
      };
      const result = buildHandoffCommand('td-sec4', data);
      // Verify args array contains the payloads as literal strings
      assert.ok(result.args.includes('$(malicious)'));
      assert.ok(result.args.includes('; rm -rf /'));
      assert.ok(result.args.includes('`whoami`'));
      assert.ok(result.args.includes('$(id) && cat /etc/shadow'));
    });
  });

  describe('input validation', function () {
    describe('extractHandoffData()', function () {
      it('should throw TypeError when messages is not an array', function () {
        assert.throws(() => extractHandoffData(null), TypeError);
        assert.throws(() => extractHandoffData(undefined), TypeError);
        assert.throws(() => extractHandoffData('string'), TypeError);
        assert.throws(() => extractHandoffData({}), TypeError);
        assert.throws(() => extractHandoffData(123), TypeError);
      });

      it('should include function name in error message', function () {
        try {
          extractHandoffData(null);
          assert.fail('Should have thrown');
        } catch (e) {
          assert.ok(e.message.includes('extractHandoffData'));
        }
      });
    });

    describe('buildHandoffCommand()', function () {
      it('should throw TypeError when issueId is not a string', function () {
        const validData = { done: [], remaining: [], decisions: [], uncertain: [] };
        assert.throws(() => buildHandoffCommand(null, validData), TypeError);
        assert.throws(() => buildHandoffCommand(undefined, validData), TypeError);
        assert.throws(() => buildHandoffCommand(123, validData), TypeError);
        assert.throws(() => buildHandoffCommand({}, validData), TypeError);
      });

      it('should throw TypeError when issueId is empty string', function () {
        const validData = { done: [], remaining: [], decisions: [], uncertain: [] };
        assert.throws(() => buildHandoffCommand('', validData), TypeError);
      });

      it('should throw TypeError when data is not an object', function () {
        assert.throws(() => buildHandoffCommand('td-123', null), TypeError);
        assert.throws(() => buildHandoffCommand('td-123', undefined), TypeError);
        assert.throws(() => buildHandoffCommand('td-123', 'string'), TypeError);
        assert.throws(() => buildHandoffCommand('td-123', 123), TypeError);
      });

      it('should throw TypeError when data is missing required arrays', function () {
        assert.throws(() => buildHandoffCommand('td-123', {}), TypeError);
        assert.throws(() => buildHandoffCommand('td-123', { done: [] }), TypeError);
        assert.throws(() => buildHandoffCommand('td-123', { done: [], remaining: [] }), TypeError);
        assert.throws(
          () => buildHandoffCommand('td-123', { done: [], remaining: [], decisions: [] }),
          TypeError
        );
      });

      it('should throw TypeError when arrays are not arrays', function () {
        assert.throws(
          () =>
            buildHandoffCommand('td-123', {
              done: 'not array',
              remaining: [],
              decisions: [],
              uncertain: [],
            }),
          TypeError
        );
      });

      it('should include function name in error message', function () {
        try {
          buildHandoffCommand(null, {});
          assert.fail('Should have thrown');
        } catch (e) {
          assert.ok(e.message.includes('buildHandoffCommand'));
        }
      });
    });

    describe('extractWithSummarization()', function () {
      it('should throw TypeError when messages is not an array', async function () {
        await assert.rejects(() => extractWithSummarization(null), TypeError);
        await assert.rejects(() => extractWithSummarization(undefined), TypeError);
        await assert.rejects(() => extractWithSummarization('string'), TypeError);
        await assert.rejects(() => extractWithSummarization({}), TypeError);
      });

      it('should include function name in error message', async function () {
        try {
          await extractWithSummarization(null);
          assert.fail('Should have thrown');
        } catch (e) {
          assert.ok(e.message.includes('extractWithSummarization'));
        }
      });
    });
  });
});
