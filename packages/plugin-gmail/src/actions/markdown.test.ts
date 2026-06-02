import { describe, expect, it } from 'vitest';
import { renderMarkdownToHtml } from './markdown.js';

describe('renderMarkdownToHtml', () => {
  it('renders common markdown as semantic HTML', () => {
    const html = renderMarkdownToHtml([
      '# Status',
      '',
      'Here is **bold**, *italic*, and `inline code`.',
      '',
      '- First',
      '  - Nested',
      '- Second',
      '',
      '> Quoted text',
    ].join('\n'));

    expect(html).toContain('<h1>Status</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('>inline code</code>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>Nested</li>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<p>Quoted text</p>');
  });

  it('renders tables and fenced code blocks', () => {
    const html = renderMarkdownToHtml([
      '| Name | Value |',
      '| --- | --- |',
      '| Plan | Ship |',
      '',
      '```ts',
      "const tag = '<p>';",
      '```',
    ].join('\n'));

    expect(html).toContain('<table border="1" cellpadding="6" cellspacing="0"');
    expect(html).toContain('>Name</th>');
    expect(html).toContain('>Ship</td>');
    expect(html).toContain('<pre style="background-color: #f6f8fa;');
    expect(html).toContain('<code class="language-ts" style="font-family: monospace;">');
    expect(html).toContain("const tag = '&lt;p&gt;';");
  });

  it('adds email-safe presentation attributes for tables and code', () => {
    const html = renderMarkdownToHtml([
      '| Name | Value |',
      '| --- | --- |',
      '| Plan | Ship |',
      '',
      'Use `code` inline.',
      '',
      '```ts',
      'const ok = true;',
      '```',
    ].join('\n'));

    expect(html).toContain('<table border="1" cellpadding="6" cellspacing="0"');
    expect(html).toContain('border-collapse: collapse;');
    expect(html).toContain('<th style="border: 1px solid #d0d7de;');
    expect(html).toContain('<td style="border: 1px solid #d0d7de;');
    expect(html).toContain('<pre style="background-color: #f6f8fa;');
    expect(html).toContain('<code style="font-family: monospace;');
    expect(html).toContain('<code class="language-ts" style="font-family: monospace;');
  });

  it('linkifies bare URLs', () => {
    const html = renderMarkdownToHtml('Read https://example.com for details.');

    expect(html).toContain(
      '<a href="https://example.com">https://example.com</a>',
    );
  });

  it('escapes raw HTML and bare angle brackets', () => {
    const html = renderMarkdownToHtml([
      '<script>alert(1)</script>',
      '',
      'Latency was <100ms.',
    ].join('\n'));

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Latency was &lt;100ms.');
  });

  it('does not emphasize intraword underscores', () => {
    const html = renderMarkdownToHtml('Use my_var_name in the payload.');

    expect(html).toContain('my_var_name');
    expect(html).not.toContain('<em>var</em>');
  });
});
