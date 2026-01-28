/**
 * Tests for conductor-bootstrap.json template
 * Ensures conductor prompts don't contain unresolved placeholders
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

describe('conductor-bootstrap template', function () {
  let template;

  before(function () {
    const templatePath = path.join(__dirname, '../../cluster-templates/conductor-bootstrap.json');
    template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  });

  describe('junior-conductor', function () {
    let juniorConductor;

    before(function () {
      juniorConductor = template.agents.find((a) => a.id === 'junior-conductor');
    });

    it('exists in template', function () {
      assert.ok(juniorConductor, 'junior-conductor agent should exist');
    });

    it('prompt has no unresolved ISSUE_OPENED placeholders', function () {
      const prompt = juniorConductor.prompt.system;
      assert.ok(
        !prompt.includes('{{ISSUE_OPENED'),
        'Prompt should not contain unresolved {{ISSUE_OPENED placeholder - ' +
          'TemplateResolver only handles simple {{word}} patterns, not nested paths'
      );
    });

    it('prompt references ISSUE_OPENED message for context', function () {
      const prompt = juniorConductor.prompt.system;
      assert.ok(
        prompt.includes('ISSUE_OPENED'),
        'Prompt should reference ISSUE_OPENED message (via contextStrategy)'
      );
    });

    it('has contextStrategy that includes ISSUE_OPENED', function () {
      const sources = juniorConductor.contextStrategy?.sources || [];
      const hasIssueOpened = sources.some((s) => s.topic === 'ISSUE_OPENED');
      assert.ok(
        hasIssueOpened,
        'contextStrategy should include ISSUE_OPENED source for task context'
      );
    });
  });

  describe('senior-conductor', function () {
    let seniorConductor;

    before(function () {
      seniorConductor = template.agents.find((a) => a.id === 'senior-conductor');
    });

    it('exists in template', function () {
      assert.ok(seniorConductor, 'senior-conductor agent should exist');
    });

    it('prompt has no unresolved ISSUE_OPENED placeholders', function () {
      const prompt = seniorConductor.prompt.system;
      assert.ok(
        !prompt.includes('{{ISSUE_OPENED'),
        'Prompt should not contain unresolved {{ISSUE_OPENED placeholder'
      );
    });

    it('has contextStrategy that includes ISSUE_OPENED', function () {
      const sources = seniorConductor.contextStrategy?.sources || [];
      const hasIssueOpened = sources.some((s) => s.topic === 'ISSUE_OPENED');
      assert.ok(
        hasIssueOpened,
        'contextStrategy should include ISSUE_OPENED source for task context'
      );
    });
  });
});
