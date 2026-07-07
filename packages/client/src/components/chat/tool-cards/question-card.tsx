import { ToolCardShell, ToolCardSection } from './tool-card-shell';
import { QuestionIcon } from './icons';
import type { ToolCallData, QuestionArgs, QuestionInput, QuestionOption } from './types';

export function QuestionCard({ tool }: { tool: ToolCallData }) {
  const args = (tool.args ?? {}) as QuestionArgs;
  const questions = normalizeQuestions(args);
  const resultStr = typeof tool.result === 'string' ? tool.result : null;
  const resultOutput = getResultOutput(tool.result);
  const resultTitle = getResultTitle(tool.result);
  const answersByQuestion = getAnswersByQuestion(tool.result);
  const isWaiting = tool.status === 'pending' || tool.status === 'running';
  const summaryText = questions.length > 1
    ? `Asked ${questions.length} questions`
    : questions[0]?.question || resultTitle || undefined;
  const hasContent = questions.length > 0 || !!resultOutput || (isWaiting && !summaryText);

  return (
    <ToolCardShell
      icon={<QuestionIcon className="h-3.5 w-3.5" />}
      label="question"
      status={tool.status}
      tool={tool}
      defaultExpanded
      summary={
        summaryText ? (
          <span className="text-neutral-600 dark:text-neutral-300">
            {summaryText.length > 80 ? summaryText.slice(0, 80) + '...' : summaryText}
          </span>
        ) : undefined
      }
    >
      {hasContent ? (
        <ToolCardSection>
          {isWaiting && (
            <p className="mb-2 text-[11px] text-neutral-500 dark:text-neutral-400">
              Waiting for user response.
            </p>
          )}
          {questions.map((question, i) => {
            const answerList = answersByQuestion?.[i]
              ?? (i === 0 && resultStr ? [resultStr] : []);
            const answerSet = new Set(answerList.map(canonicalize));
            const hasOptions = question.options.length > 0;
            const unmatchedAnswers = answerList.filter((ans) => {
              const normalized = canonicalize(ans);
              return !question.options.some((opt) => {
                const label = opt.label ?? opt.value ?? '';
                const value = opt.value ?? '';
                return canonicalize(label) === normalized || canonicalize(value) === normalized;
              });
            });

            return (
              <div key={i} className={i > 0 ? 'mt-3 border-t border-neutral-100 pt-3 dark:border-neutral-800' : ''}>
                {question.header && (
                  <div className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                    {question.header}
                  </div>
                )}
                <p className="mb-2 text-[12px] leading-relaxed text-neutral-700 dark:text-neutral-300">
                  {question.question}
                </p>
                {hasOptions && (
                  <div className="space-y-1">
                    {question.options.map((opt, idx) => {
                      const label = opt.label ?? opt.value ?? `Option ${idx + 1}`;
                      const value = opt.value ?? label;
                      const isSelected =
                        answerSet.has(canonicalize(label)) || answerSet.has(canonicalize(value));

                      return (
                        <div
                          key={idx}
                          className={
                            isSelected
                              ? 'flex items-start gap-2 rounded-md border border-accent/30 bg-accent/5 px-2 py-1.5 dark:border-accent/20 dark:bg-accent/5'
                              : 'flex items-start gap-2 rounded-md border border-neutral-150 px-2 py-1.5 dark:border-neutral-700/60'
                          }
                        >
                          <span className={
                            isSelected
                              ? 'mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-accent bg-accent text-white'
                              : 'mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-neutral-300 dark:border-neutral-600'
                          }>
                            {isSelected && (
                              <svg className="h-2 w-2" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="3 8 7 12 13 4" />
                              </svg>
                            )}
                          </span>
                          <div className="min-w-0">
                            <span className={
                              isSelected
                                ? 'font-mono text-[11px] font-medium text-accent'
                                : 'font-mono text-[11px] text-neutral-600 dark:text-neutral-400'
                            }>
                              {label}
                            </span>
                            {opt.description && (
                              <p className="mt-0.5 text-[10px] leading-snug text-neutral-400 dark:text-neutral-500">
                                {opt.description}
                              </p>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {(answerList.length > 0 && (!hasOptions || unmatchedAnswers.length > 0)) && (
                  <div className="mt-2 rounded-md border border-accent/20 bg-accent/5 px-2 py-1.5">
                    <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
                      {answerList.length > 1 ? 'Answers' : 'Answer'}
                    </span>
                    <p className="mt-0.5 font-mono text-[11px] text-neutral-700 dark:text-neutral-300">
                      {answerList.join(', ')}
                    </p>
                  </div>
                )}
                {question.multiple && (
                  <p className="mt-2 text-[10px] text-neutral-400 dark:text-neutral-500">
                    Multiple selections were allowed for this question.
                  </p>
                )}
              </div>
            );
          })}
          {questions.length === 0 && (resultOutput || resultStr) && (
            <p className="text-[12px] leading-relaxed text-neutral-700 dark:text-neutral-300">
              {resultOutput || resultStr}
            </p>
          )}
        </ToolCardSection>
      ) : undefined}
    </ToolCardShell>
  );
}

interface NormalizedQuestion {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiple?: boolean;
}

function normalizeQuestions(args: QuestionArgs): NormalizedQuestion[] {
  const list: QuestionInput[] = Array.isArray(args.questions) && args.questions.length > 0
    ? args.questions
    : [{ question: args.question, header: args.header, options: args.options }];

  const normalized: NormalizedQuestion[] = [];
  for (const item of list) {
    const questionText = typeof item.question === 'string' ? item.question.trim() : '';
    const header = typeof item.header === 'string' && item.header.trim()
      ? item.header.trim()
      : undefined;
    const options = normalizeOptions(item.options);
    if (!questionText && !header && options.length === 0) continue;

    normalized.push({
      question: questionText || 'Question',
      header,
      options,
      multiple: item.multiple === true,
    });
  }

  return normalized;
}

function normalizeOptions(options: QuestionInput['options']): QuestionOption[] {
  if (!Array.isArray(options)) return [];
  const normalized: QuestionOption[] = [];
  for (const opt of options) {
    if (typeof opt === 'string') {
      normalized.push({ label: opt, value: opt });
      continue;
    }
    if (!opt || typeof opt !== 'object') continue;
    const label = typeof opt.label === 'string' ? opt.label : undefined;
    const value = typeof opt.value === 'string' ? opt.value : undefined;
    const description = typeof opt.description === 'string' ? opt.description : undefined;
    if (!label && !value) continue;
    normalized.push({ label, value, description });
  }
  return normalized;
}

function getResultOutput(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const output = (result as Record<string, unknown>).output;
  return typeof output === 'string' ? output : null;
}

function getResultTitle(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const title = (result as Record<string, unknown>).title;
  return typeof title === 'string' ? title : null;
}

function getAnswersByQuestion(result: unknown): string[][] | null {
  if (!result || typeof result !== 'object') return null;
  const metadata = (result as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== 'object') return null;
  const answers = (metadata as Record<string, unknown>).answers;
  if (!Array.isArray(answers)) return null;

  const parsed = answers.map((answer) => {
    if (Array.isArray(answer)) {
      return answer.filter((item): item is string => typeof item === 'string');
    }
    if (typeof answer === 'string') return [answer];
    return [];
  });
  return parsed;
}

function canonicalize(value: string): string {
  return value.trim().toLowerCase();
}
