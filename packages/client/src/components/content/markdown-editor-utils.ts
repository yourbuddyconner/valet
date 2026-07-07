export type MarkdownFormat =
  | 'heading'
  | 'bulletList'
  | 'numberedList'
  | 'codeBlock'
  | 'link'
  | 'inlineCode';

export interface MarkdownSelectionResult {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

function replaceSelection(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  replacement: string,
  cursorStartOffset: number,
  cursorEndOffset: number,
): MarkdownSelectionResult {
  return {
    value: `${value.slice(0, selectionStart)}${replacement}${value.slice(selectionEnd)}`,
    selectionStart: selectionStart + cursorStartOffset,
    selectionEnd: selectionStart + cursorEndOffset,
  };
}

function formatLines(text: string, formatter: (line: string, index: number) => string) {
  const source = text.length > 0 ? text : 'List item';
  return source
    .split('\n')
    .map((line, index) => formatter(line, index))
    .join('\n');
}

export function formatMarkdownSelection(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  format: MarkdownFormat,
): MarkdownSelectionResult {
  const selected = value.slice(selectionStart, selectionEnd);

  switch (format) {
    case 'heading': {
      const source = selected || 'Heading';
      const replacement = source
        .split('\n')
        .map((line) => (line.startsWith('## ') ? line : `## ${line}`))
        .join('\n');
      return replaceSelection(value, selectionStart, selectionEnd, replacement, 3, replacement.length);
    }
    case 'bulletList': {
      const replacement = formatLines(selected, (line) => `- ${line.replace(/^[-*]\s+/, '')}`);
      return replaceSelection(value, selectionStart, selectionEnd, replacement, 2, replacement.length);
    }
    case 'numberedList': {
      const replacement = formatLines(selected, (line, index) => `${index + 1}. ${line.replace(/^\d+\.\s+/, '')}`);
      return replaceSelection(value, selectionStart, selectionEnd, replacement, 3, replacement.length);
    }
    case 'codeBlock': {
      const replacement = `\`\`\`ts\n${selected}\n\`\`\``;
      return replaceSelection(value, selectionStart, selectionEnd, replacement, 6, 6 + selected.length);
    }
    case 'link': {
      const label = selected || 'Link text';
      const replacement = `[${label}](https://)`;
      const urlStart = label.length + 3;
      return replaceSelection(value, selectionStart, selectionEnd, replacement, urlStart, urlStart + 8);
    }
    case 'inlineCode': {
      const source = selected || 'code';
      const replacement = `\`${source}\``;
      return replaceSelection(value, selectionStart, selectionEnd, replacement, 1, 1 + source.length);
    }
  }
}
