import { describe, expect, it } from 'vitest';
import { formatMarkdownSelection } from './markdown-editor-utils';

describe('formatMarkdownSelection', () => {
  it('wraps a selected line as a heading', () => {
    const result = formatMarkdownSelection('Existing title', 0, 14, 'heading');

    expect(result.value).toBe('## Existing title');
    expect(result.selectionStart).toBe(3);
    expect(result.selectionEnd).toBe(17);
  });

  it('turns selected lines into a bullet list', () => {
    const result = formatMarkdownSelection('first\nsecond', 0, 12, 'bulletList');

    expect(result.value).toBe('- first\n- second');
  });

  it('inserts a fenced code block for an empty selection', () => {
    const result = formatMarkdownSelection('', 0, 0, 'codeBlock');

    expect(result.value).toBe('```ts\n\n```');
    expect(result.selectionStart).toBe(6);
    expect(result.selectionEnd).toBe(6);
  });

  it('wraps selected text as a link', () => {
    const result = formatMarkdownSelection('Valet docs', 0, 10, 'link');

    expect(result.value).toBe('[Valet docs](https://)');
    expect(result.selectionStart).toBe(13);
    expect(result.selectionEnd).toBe(21);
  });

  it('wraps selected text as inline code', () => {
    const result = formatMarkdownSelection('useSkill', 0, 8, 'inlineCode');

    expect(result.value).toBe('`useSkill`');
  });
});
