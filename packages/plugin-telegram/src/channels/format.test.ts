import { describe, it, expect } from 'vitest';
import { markdownToTelegramHtml } from './format.js';

describe('markdownToTelegramHtml', () => {
  // ─── Bold ────────────────────────────────────────────────────────────

  it('converts **bold** to <b>', () => {
    expect(markdownToTelegramHtml('**hello**')).toBe('<b>hello</b>');
  });

  it('converts __bold__ to <b>', () => {
    expect(markdownToTelegramHtml('__hello__')).toBe('<b>hello</b>');
  });

  it('handles multiple bold spans', () => {
    expect(markdownToTelegramHtml('**a** and **b**')).toBe('<b>a</b> and <b>b</b>');
  });

  // ─── Italic ──────────────────────────────────────────────────────────

  it('converts *italic* to <i>', () => {
    expect(markdownToTelegramHtml('*hello*')).toBe('<i>hello</i>');
  });

  it('converts _italic_ to <i>', () => {
    expect(markdownToTelegramHtml('_hello_')).toBe('<i>hello</i>');
  });

  // ─── Mixed Bold + Italic ─────────────────────────────────────────────

  it('handles bold and italic together', () => {
    const result = markdownToTelegramHtml('**bold** and *italic*');
    expect(result).toBe('<b>bold</b> and <i>italic</i>');
  });

  // ─── Links ───────────────────────────────────────────────────────────

  it('converts markdown links to <a> tags', () => {
    expect(markdownToTelegramHtml('[click](https://example.com)')).toBe(
      '<a href="https://example.com">click</a>'
    );
  });

  // ─── Inline Code ─────────────────────────────────────────────────────

  it('converts inline code to <code>', () => {
    expect(markdownToTelegramHtml('use `console.log`')).toBe('use <code>console.log</code>');
  });

  it('escapes HTML inside inline code', () => {
    expect(markdownToTelegramHtml('`<div>`')).toBe('<code>&lt;div&gt;</code>');
  });

  it('does not apply formatting inside inline code', () => {
    expect(markdownToTelegramHtml('`**not bold**`')).toBe('<code>**not bold**</code>');
  });

  // ─── Code Blocks ─────────────────────────────────────────────────────

  it('converts fenced code blocks to <pre>', () => {
    const input = '```\nconst x = 1;\n```';
    expect(markdownToTelegramHtml(input)).toBe('<pre>const x = 1;</pre>');
  });

  it('strips language identifier from fenced code blocks', () => {
    const input = '```js\nconst x = 1;\n```';
    expect(markdownToTelegramHtml(input)).toBe('<pre>const x = 1;</pre>');
  });

  it('escapes HTML inside code blocks', () => {
    const input = '```\n<script>alert("xss")</script>\n```';
    expect(markdownToTelegramHtml(input)).toBe(
      '<pre>&lt;script&gt;alert("xss")&lt;/script&gt;</pre>'
    );
  });

  it('does not apply formatting inside code blocks', () => {
    const input = '```\n**not bold** and *not italic*\n```';
    expect(markdownToTelegramHtml(input)).toBe(
      '<pre>**not bold** and *not italic*</pre>'
    );
  });

  // ─── HTML Entity Escaping ────────────────────────────────────────────

  it('escapes & in text', () => {
    expect(markdownToTelegramHtml('A & B')).toBe('A &amp; B');
  });

  it('escapes < and > in text', () => {
    expect(markdownToTelegramHtml('a < b > c')).toBe('a &lt; b &gt; c');
  });

  it('does not double-escape code block content', () => {
    const input = '```\na & b\n```';
    expect(markdownToTelegramHtml(input)).toBe('<pre>a &amp; b</pre>');
  });

  // ─── Plain Text ──────────────────────────────────────────────────────

  it('returns plain text unchanged (except HTML escaping)', () => {
    expect(markdownToTelegramHtml('hello world')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(markdownToTelegramHtml('')).toBe('');
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

    const result = markdownToTelegramHtml(input);

    // Bold converted
    expect(result).toContain('<b>Summary:</b>');
    // Inline code converted with escaping
    expect(result).toContain('<code>parser.ts</code>');
    expect(result).toContain('<code>&lt;input&gt;</code>');
    // Code block preserved
    expect(result).toContain('<pre>');
    expect(result).toContain('function parse');
    // Ampersand inside code block is escaped
    expect(result).toContain('&amp;amp;');
    // Link converted
    expect(result).toContain('<a href="https://example.com">the docs</a>');
  });

  it('handles multiple code blocks', () => {
    const input = '```\nfirst\n```\ntext\n```\nsecond\n```';
    const result = markdownToTelegramHtml(input);
    expect(result).toContain('<pre>first</pre>');
    expect(result).toContain('<pre>second</pre>');
    expect(result).toContain('text');
  });
});
