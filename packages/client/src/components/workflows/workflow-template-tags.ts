import type { WorkflowOutputSource } from './workflow-editor-model';

export interface TemplateCompletionContext {
  start: number;
  end: number;
  query: string;
}

export interface TemplateInsertion {
  value: string;
  cursor: number;
}

export interface TemplateValidationIssue {
  code: 'empty_template' | 'unclosed_template' | 'unknown_template';
  message: string;
  expression?: string;
}

const TEMPLATE_TAG_PATTERN = /\{\{([\s\S]*?)\}\}/g;

export const TEMPLATE_SUGGESTION_POPOVER_CLASS =
  'absolute left-0 top-full z-50 mt-1 max-h-72 min-w-full w-[min(28rem,calc(100vw-2rem))] overflow-auto rounded-md border border-neutral-200 bg-white p-1 shadow-xl dark:border-neutral-700 dark:bg-neutral-950';

export const TEMPLATE_SUGGESTION_LABEL_CLASS =
  'min-w-0 whitespace-normal break-words font-medium text-neutral-800 dark:text-neutral-100';

export const TEMPLATE_SUGGESTION_EXPRESSION_CLASS =
  'mt-0.5 block whitespace-normal break-all font-mono text-neutral-500';

export function getTemplateCompletionContext(
  value: string,
  cursor: number,
): TemplateCompletionContext | null {
  const beforeCursor = value.slice(0, cursor);
  const openIndex = beforeCursor.lastIndexOf('{{');
  if (openIndex === -1) return null;

  const closeBeforeOpen = beforeCursor.lastIndexOf('}}');
  if (closeBeforeOpen > openIndex) return null;

  const closeAfterCursor = value.indexOf('}}', cursor);
  const end = closeAfterCursor === -1 ? cursor : closeAfterCursor + 2;
  return {
    start: openIndex,
    end,
    query: value.slice(openIndex + 2, cursor),
  };
}

export function insertTemplateExpression(input: {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  expression: string;
}): TemplateInsertion {
  const context = getTemplateCompletionContext(input.value, input.selectionStart);
  const start = context?.start ?? input.selectionStart;
  const end = context?.end ?? input.selectionEnd;
  const value = `${input.value.slice(0, start)}${input.expression}${input.value.slice(end)}`;
  return {
    value,
    cursor: start + input.expression.length,
  };
}

export function filterTemplateSuggestions(
  sources: WorkflowOutputSource[],
  query: string,
): WorkflowOutputSource[] {
  const normalizedQuery = normalizeSearchText(stripTemplateBraces(query));
  if (normalizedQuery.length === 0) return sources;

  return sources.filter((source) =>
    normalizeSearchText([
      source.label,
      source.expression,
      stripTemplateBraces(source.expression),
      source.nodeId,
      source.nodeLabel,
      source.actionName,
      source.valueType,
    ].join(' ')).includes(normalizedQuery),
  );
}

export function validateTemplateTags(
  value: string,
  sources: WorkflowOutputSource[],
): TemplateValidationIssue[] {
  const issues: TemplateValidationIssue[] = [];
  const knownExpressions = new Set(sources.map((source) => stripTemplateBraces(source.expression)));
  const openCount = countOccurrences(value, '{{');
  const closeCount = countOccurrences(value, '}}');

  if (openCount > closeCount) {
    issues.push({
      code: 'unclosed_template',
      message: 'Template tag is missing closing braces.',
    });
  }

  for (const match of value.matchAll(TEMPLATE_TAG_PATTERN)) {
    const expression = stripTemplateBraces(match[0] ?? '').trim();
    if (!expression) {
      issues.push({
        code: 'empty_template',
        message: 'Template tag is empty.',
      });
      continue;
    }

    if (knownExpressions.size > 0 && !knownExpressions.has(expression)) {
      issues.push({
        code: 'unknown_template',
        message: `Unknown template variable: ${expression}`,
        expression,
      });
    }
  }

  return issues;
}

export function stripTemplateBraces(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('{{') && trimmed.endsWith('}}')
    ? trimmed.slice(2, -2).trim()
    : trimmed;
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function countOccurrences(value: string, token: string): number {
  let count = 0;
  let index = value.indexOf(token);
  while (index !== -1) {
    count += 1;
    index = value.indexOf(token, index + token.length);
  }
  return count;
}
