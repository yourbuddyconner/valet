import { describe, it, expect } from 'vitest';
import { markdownToSlackMrkdwn } from './format.js';

describe('markdownToSlackMrkdwn', () => {
  // ─── Bold ────────────────────────────────────────────────────────────

  it('converts **bold** to *bold*', () => {
    expect(markdownToSlackMrkdwn('**hello**')).toBe('*hello*');
  });

  it('converts __bold__ to *bold*', () => {
    expect(markdownToSlackMrkdwn('__hello__')).toBe('*hello*');
  });

  it('handles multiple bold spans', () => {
    expect(markdownToSlackMrkdwn('**a** and **b**')).toBe('*a* and *b*');
  });

  // ─── Italic ──────────────────────────────────────────────────────────

  it('converts *italic* to _italic_', () => {
    expect(markdownToSlackMrkdwn('*hello*')).toBe('_hello_');
  });

  it('preserves _italic_ as _italic_', () => {
    expect(markdownToSlackMrkdwn('_hello_')).toBe('_hello_');
  });

  // ─── Mixed Bold + Italic ─────────────────────────────────────────────

  it('handles bold and italic together', () => {
    const result = markdownToSlackMrkdwn('**bold** and *italic*');
    expect(result).toBe('*bold* and _italic_');
  });

  // ─── Links ───────────────────────────────────────────────────────────

  it('converts markdown links to Slack format', () => {
    expect(markdownToSlackMrkdwn('[click](https://example.com)')).toBe(
      '<https://example.com|click>'
    );
  });

  it('handles links with bold text', () => {
    expect(markdownToSlackMrkdwn('[**bold link**](https://example.com)')).toBe(
      '<https://example.com|*bold link*>'
    );
  });

  // ─── Inline Code ─────────────────────────────────────────────────────

  it('preserves inline code', () => {
    expect(markdownToSlackMrkdwn('use `console.log`')).toBe('use `console.log`');
  });

  it('does not apply formatting inside inline code', () => {
    expect(markdownToSlackMrkdwn('`**not bold**`')).toBe('`**not bold**`');
  });

  // ─── Code Blocks ─────────────────────────────────────────────────────

  it('preserves fenced code blocks', () => {
    const input = '```\nconst x = 1;\n```';
    expect(markdownToSlackMrkdwn(input)).toBe('```const x = 1;```');
  });

  it('strips language identifier from fenced code blocks', () => {
    const input = '```js\nconst x = 1;\n```';
    expect(markdownToSlackMrkdwn(input)).toBe('```const x = 1;```');
  });

  it('does not apply formatting inside code blocks', () => {
    const input = '```\n**not bold** and *not italic*\n```';
    expect(markdownToSlackMrkdwn(input)).toBe(
      '```**not bold** and *not italic*```'
    );
  });

  // ─── Blockquotes ─────────────────────────────────────────────────────

  it('preserves blockquotes', () => {
    expect(markdownToSlackMrkdwn('> quoted text')).toBe('> quoted text');
  });

  // ─── Plain Text ──────────────────────────────────────────────────────

  it('returns plain text unchanged', () => {
    expect(markdownToSlackMrkdwn('hello world')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(markdownToSlackMrkdwn('')).toBe('');
  });

  // ─── Complex / Mixed ─────────────────────────────────────────────────

  it('handles a realistic agent response', () => {
    const input = [
      '**Summary:** I found the bug.',
      '',
      'The issue is in `parser.ts` where `<input>` tags are not escaped:',
      '',
      '```ts',
      'function parse(html: string) {',
      '  return html.replace(/&/g, "&amp;");',
      '}',
      '```',
      '',
      'See [the docs](https://example.com) for more.',
    ].join('\n');

    const result = markdownToSlackMrkdwn(input);

    // Bold converted
    expect(result).toContain('*Summary:*');
    // Inline code preserved
    expect(result).toContain('`parser.ts`');
    expect(result).toContain('`<input>`');
    // Code block preserved
    expect(result).toContain('```');
    expect(result).toContain('function parse');
    // Link converted
    expect(result).toContain('<https://example.com|the docs>');
  });

  it('handles multiple code blocks', () => {
    const input = '```\nfirst\n```\ntext\n```\nsecond\n```';
    const result = markdownToSlackMrkdwn(input);
    expect(result).toContain('```first```');
    expect(result).toContain('```second```');
    expect(result).toContain('text');
  });
});
