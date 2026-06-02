import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import type { RenderRule } from 'markdown-it/lib/renderer.mjs';

const TABLE_STYLE = 'border-collapse: collapse; margin: 12px 0;';
const CELL_STYLE = 'border: 1px solid #d0d7de; padding: 6px 8px; text-align: left; vertical-align: top;';
const HEADER_CELL_STYLE = `${CELL_STYLE} background-color: #f6f8fa; font-weight: 600;`;
const PRE_STYLE =
  'background-color: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; padding: 10px; overflow-x: auto; white-space: pre-wrap;';
const INLINE_CODE_STYLE =
  'font-family: monospace; background-color: #f6f8fa; border-radius: 4px; padding: 1px 4px;';
const BLOCK_CODE_STYLE = 'font-family: monospace;';

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  breaks: false,
  xhtmlOut: false,
});

function styledOpen(attrs: Array<[string, string]>): RenderRule {
  return (tokens, idx, options, _env, self) => {
    for (const [name, value] of attrs) tokens[idx].attrSet(name, value);
    return self.renderToken(tokens, idx, options);
  };
}

function renderCodeBlock(token: Token, classAttr = ''): string {
  return `<pre style="${PRE_STYLE}"><code${classAttr} style="${BLOCK_CODE_STYLE}">${markdown.utils.escapeHtml(token.content)}</code></pre>\n`;
}

markdown.renderer.rules.table_open = styledOpen([
  ['border', '1'],
  ['cellpadding', '6'],
  ['cellspacing', '0'],
  ['style', TABLE_STYLE],
]);
markdown.renderer.rules.th_open = styledOpen([['style', HEADER_CELL_STYLE]]);
markdown.renderer.rules.td_open = styledOpen([['style', CELL_STYLE]]);
markdown.renderer.rules.code_inline = (tokens, idx) =>
  `<code style="${INLINE_CODE_STYLE}">${markdown.utils.escapeHtml(tokens[idx].content)}</code>`;
markdown.renderer.rules.code_block = (tokens, idx) => renderCodeBlock(tokens[idx]);
markdown.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  const language = token.info.trim().split(/\s+/)[0];
  const classAttr = /^[A-Za-z0-9_-]+$/.test(language) ? ` class="language-${language}"` : '';
  return renderCodeBlock(token, classAttr);
};

export function renderMarkdownToHtml(body: string): string {
  return markdown.render(body);
}
