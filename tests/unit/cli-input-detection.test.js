/**
 * Test: CLI Input Detection
 *
 * Verifies the input detection logic in cli/index.js
 * Tests: GitHub issue URL, issue number, org/repo#123, markdown files, plain text, TD issues
 */

const assert = require('assert');
const { detectProvider } = require('../../src/issue-providers');

// Mock the CLI input detection logic (simplified version without provider detection)
// This mirrors the ORIGINAL logic in cli/index.js for basic tests
function detectInputType(inputArg) {
  const input = {};

  // Check if it's a GitHub issue URL
  if (inputArg.match(/^https?:\/\/github\.com\/[\w-]+\/[\w-]+\/issues\/\d+/)) {
    input.issue = inputArg;
  }
  // Check if it's a GitHub issue number (just digits)
  else if (/^\d+$/.test(inputArg)) {
    input.issue = inputArg;
  }
  // Check if it's org/repo#123 format
  else if (inputArg.match(/^[\w-]+\/[\w-]+#\d+$/)) {
    input.issue = inputArg;
  }
  // Check if it's a markdown file (.md or .markdown)
  else if (/\.(md|markdown)$/i.test(inputArg)) {
    input.file = inputArg;
  }
  // Otherwise, treat as plain text
  else {
    input.text = inputArg;
  }

  return input;
}

// Full detection logic including provider registry fallback
// This mirrors the CURRENT logic in cli/index.js with TD support
function detectInputTypeWithProviders(inputArg, settings = {}) {
  const input = {};

  const isGitHubUrl = /^https?:\/\/github\.com\/[\w-]+\/[\w-]+\/issues\/\d+/.test(inputArg);
  const isGitLabUrl = /gitlab\.(com|[\w.-]+)\/[\w-]+\/[\w-]+\/-\/issues\/\d+/.test(inputArg);
  const isJiraUrl = /(atlassian\.net|jira\.[\w.-]+)\/browse\/[A-Z][A-Z0-9]+-\d+/.test(inputArg);
  const isAzureUrl =
    /dev\.azure\.com\/.*\/_workitems\/edit\/\d+/.test(inputArg) ||
    /visualstudio\.com\/.*\/_workitems\/edit\/\d+/.test(inputArg);
  const isJiraKey = /^[A-Z][A-Z0-9]+-\d+$/.test(inputArg);
  const isIssueNumber = /^\d+$/.test(inputArg);
  const isRepoIssue = /^[\w-]+\/[\w-]+#\d+$/.test(inputArg);
  const isMarkdownFile = /\.(md|markdown)$/i.test(inputArg);

  if (
    isGitHubUrl ||
    isGitLabUrl ||
    isJiraUrl ||
    isAzureUrl ||
    isJiraKey ||
    isIssueNumber ||
    isRepoIssue
  ) {
    input.issue = inputArg;
  } else if (isMarkdownFile) {
    input.file = inputArg;
  } else {
    // Check if any registered issue provider can handle this input
    if (detectProvider(inputArg, settings)) {
      input.issue = inputArg;
    } else {
      input.text = inputArg;
    }
  }
  return input;
}

describe('CLI Input Detection', function () {
  describe('GitHub issue detection', function () {
    it('should detect GitHub issue URL', function () {
      const input = detectInputType('https://github.com/owner/repo/issues/123');

      assert.strictEqual(input.issue, 'https://github.com/owner/repo/issues/123');
      assert.strictEqual(input.file, undefined);
      assert.strictEqual(input.text, undefined);
    });

    it('should detect GitHub issue number', function () {
      const input = detectInputType('123');

      assert.strictEqual(input.issue, '123');
      assert.strictEqual(input.file, undefined);
      assert.strictEqual(input.text, undefined);
    });

    it('should detect org/repo#123 format', function () {
      const input = detectInputType('owner/repo#456');

      assert.strictEqual(input.issue, 'owner/repo#456');
      assert.strictEqual(input.file, undefined);
      assert.strictEqual(input.text, undefined);
    });
  });

  describe('Markdown file detection', function () {
    it('should detect .md file', function () {
      const input = detectInputType('feature.md');

      assert.strictEqual(input.file, 'feature.md');
      assert.strictEqual(input.issue, undefined);
      assert.strictEqual(input.text, undefined);
    });

    it('should detect .markdown file', function () {
      const input = detectInputType('feature.markdown');

      assert.strictEqual(input.file, 'feature.markdown');
      assert.strictEqual(input.issue, undefined);
      assert.strictEqual(input.text, undefined);
    });

    it('should detect .MD file (uppercase)', function () {
      const input = detectInputType('README.MD');

      assert.strictEqual(input.file, 'README.MD');
      assert.strictEqual(input.issue, undefined);
      assert.strictEqual(input.text, undefined);
    });

    it('should detect relative path to markdown file', function () {
      const input = detectInputType('./docs/feature.md');

      assert.strictEqual(input.file, './docs/feature.md');
      assert.strictEqual(input.issue, undefined);
      assert.strictEqual(input.text, undefined);
    });

    it('should detect absolute path to markdown file', function () {
      const input = detectInputType('/tmp/feature.md');

      assert.strictEqual(input.file, '/tmp/feature.md');
      assert.strictEqual(input.issue, undefined);
      assert.strictEqual(input.text, undefined);
    });

    it('should detect parent directory path to markdown file', function () {
      const input = detectInputType('../feature.markdown');

      assert.strictEqual(input.file, '../feature.markdown');
      assert.strictEqual(input.issue, undefined);
      assert.strictEqual(input.text, undefined);
    });
  });

  describe('Plain text detection', function () {
    it('should treat plain text as text input', function () {
      const input = detectInputType('Implement dark mode');

      assert.strictEqual(input.text, 'Implement dark mode');
      assert.strictEqual(input.issue, undefined);
      assert.strictEqual(input.file, undefined);
    });

    it('should treat sentence with spaces as text input', function () {
      const input = detectInputType('Add user authentication to the app');

      assert.strictEqual(input.text, 'Add user authentication to the app');
      assert.strictEqual(input.issue, undefined);
      assert.strictEqual(input.file, undefined);
    });
  });

  describe('Edge cases', function () {
    it('file named "123.md" should be detected as file, not issue', function () {
      const input = detectInputType('123.md');

      // .md extension detection runs AFTER digit-only check
      // So this should be a file, not issue #123
      assert.strictEqual(input.file, '123.md');
      assert.strictEqual(input.issue, undefined);
      assert.strictEqual(input.text, undefined);
    });

    it('text containing "issue" should be plain text', function () {
      const input = detectInputType('Fix the issue with login');

      assert.strictEqual(input.text, 'Fix the issue with login');
      assert.strictEqual(input.issue, undefined);
      assert.strictEqual(input.file, undefined);
    });

    it('markdown file with spaces in path', function () {
      const input = detectInputType('./docs/Feature Request.md');

      assert.strictEqual(input.file, './docs/Feature Request.md');
      assert.strictEqual(input.issue, undefined);
      assert.strictEqual(input.text, undefined);
    });
  });

  describe('Priority order', function () {
    it('GitHub URL has highest priority', function () {
      // Even if URL contains ".md", it's still a GitHub URL
      const input = detectInputType('https://github.com/owner/repo/issues/123');

      assert.strictEqual(input.issue, 'https://github.com/owner/repo/issues/123');
    });

    it('Issue number has priority over text', function () {
      const input = detectInputType('42');

      assert.strictEqual(input.issue, '42');
      assert.strictEqual(input.text, undefined);
    });

    it('File extension has priority over plain text', function () {
      const input = detectInputType('feature.md');

      assert.strictEqual(input.file, 'feature.md');
      assert.strictEqual(input.text, undefined);
    });
  });

  describe('TD issue detection (with provider registry)', function () {
    it('should detect td-XXXXXX format as issue', function () {
      const input = detectInputTypeWithProviders('td-abc123', {});

      assert.strictEqual(input.issue, 'td-abc123');
      assert.strictEqual(input.file, undefined);
      assert.strictEqual(input.text, undefined);
    });

    it('should detect TD-XXXXXX format (uppercase) as issue', function () {
      const input = detectInputTypeWithProviders('TD-ABC123', {});

      assert.strictEqual(input.issue, 'TD-ABC123');
      assert.strictEqual(input.file, undefined);
      assert.strictEqual(input.text, undefined);
    });

    it('should detect bare hex as issue when defaultIssueSource is td', function () {
      const input = detectInputTypeWithProviders('abc123', { defaultIssueSource: 'td' });

      assert.strictEqual(input.issue, 'abc123');
      assert.strictEqual(input.file, undefined);
      assert.strictEqual(input.text, undefined);
    });

    it('should NOT detect bare hex as issue when defaultIssueSource is not td', function () {
      const input = detectInputTypeWithProviders('abc123', { defaultIssueSource: 'github' });

      assert.strictEqual(input.text, 'abc123');
      assert.strictEqual(input.issue, undefined);
      assert.strictEqual(input.file, undefined);
    });

    it('plain text should remain as text even with provider check', function () {
      const input = detectInputTypeWithProviders('implement dark mode', {});

      assert.strictEqual(input.text, 'implement dark mode');
      assert.strictEqual(input.issue, undefined);
      assert.strictEqual(input.file, undefined);
    });

    it('GitHub URL should still be detected before provider fallback', function () {
      const input = detectInputTypeWithProviders('https://github.com/owner/repo/issues/123', {
        defaultIssueSource: 'td',
      });

      assert.strictEqual(input.issue, 'https://github.com/owner/repo/issues/123');
      assert.strictEqual(input.file, undefined);
      assert.strictEqual(input.text, undefined);
    });

    it('markdown file should still be detected before provider fallback', function () {
      const input = detectInputTypeWithProviders('feature.md', { defaultIssueSource: 'td' });

      assert.strictEqual(input.file, 'feature.md');
      assert.strictEqual(input.issue, undefined);
      assert.strictEqual(input.text, undefined);
    });
  });
});
