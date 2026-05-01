/** Parsed step from a GitHub Actions job log. */
export interface ParsedStep {
  name: string;
  conclusion: string;
  log: string;
  truncated: boolean;
  total_lines: number;
}

export interface ParseJobLogOptions {
  failedOnly: boolean;
  stepName?: string;
  tailLines: number;
  includeTimestamps: boolean;
}

export interface StepMeta {
  name: string;
  conclusion: string | null;
}

// Matches the ISO timestamp prefix GitHub adds to every log line:
// "2024-01-15T10:30:45.0000000Z " (28 chars + space)
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z /;

// ANSI escape codes: ESC[ ... m  (SGR sequences)
const ANSI_RE = /\x1b\[[0-9;]*m/g;

// GitHub step markers
const GROUP_START_RE = /^##\[group\](.*)/;
const GROUP_END = '##[endgroup]';
const ERROR_MARKER = '##[error]';

/**
 * Parse raw GitHub Actions job log into structured steps.
 *
 * GitHub's log format uses ##[group]/##[endgroup] markers to delineate
 * sections. IMPORTANT: the group names in the log (e.g. "Run npm run lint")
 * do NOT match the step names from the jobs API (e.g. "Lint"). We determine
 * failure by checking for ##[error] markers within a section, not by matching
 * against API step metadata.
 *
 * Processing pipeline:
 * 1. Split into sections by ##[group]/##[endgroup] markers
 * 2. Classify each section: contains ##[error] → failure, otherwise success
 * 3. Filter by failedOnly / stepName
 * 4. Strip ANSI codes
 * 5. Strip timestamps (unless includeTimestamps)
 * 6. Truncate to tailLines (tail-biased), preserving ##[error] lines
 */
export function parseJobLog(
  rawLog: string,
  _steps: StepMeta[],
  options: ParseJobLogOptions,
): ParsedStep[] {
  const sections = splitIntoSections(rawLog);
  const classified = classifySections(sections);

  let filtered = classified;
  if (options.failedOnly) {
    filtered = filtered.filter((s) => s.conclusion === 'failure');
  }
  if (options.stepName) {
    const target = options.stepName.toLowerCase();
    filtered = filtered.filter((s) => s.name.toLowerCase().includes(target));
  }

  return filtered.map((s) => {
    let lines = s.lines;

    // Strip ANSI escape codes
    lines = lines.map((l) => l.replace(ANSI_RE, ''));

    // Strip timestamps unless requested
    if (!options.includeTimestamps) {
      lines = lines.map((l) => l.replace(TIMESTAMP_RE, ''));
    }

    // Truncate with tail bias, preserving ##[error] lines
    const totalLines = lines.length;
    let truncated = false;
    if (lines.length > options.tailLines) {
      const tail = lines.slice(-options.tailLines);
      // Preserve any ##[error] lines from the head that got cut
      const headErrors = lines
        .slice(0, -options.tailLines)
        .filter((l) => l.includes(ERROR_MARKER));
      truncated = true;
      lines = [
        ...headErrors,
        `[truncated ${Math.max(0, totalLines - options.tailLines - headErrors.length)} lines]`,
        ...tail,
      ];
    }

    return {
      name: s.name,
      conclusion: s.conclusion,
      log: lines.join('\n'),
      truncated,
      total_lines: totalLines,
    };
  });
}

interface RawSection {
  name: string;
  lines: string[];
}

function splitIntoSections(rawLog: string): RawSection[] {
  const sections: RawSection[] = [];
  let currentName = '(setup)';
  let currentLines: string[] = [];

  for (const line of rawLog.split('\n')) {
    // Strip timestamp for marker detection (but keep original line in output)
    const stripped = line.replace(TIMESTAMP_RE, '');

    const groupMatch = stripped.match(GROUP_START_RE);
    if (groupMatch) {
      // Save previous section if it has content
      if (currentLines.length > 0) {
        sections.push({ name: currentName, lines: currentLines });
      }
      currentName = groupMatch[1];
      currentLines = [];
      continue;
    }

    if (stripped === GROUP_END || stripped.startsWith(GROUP_END)) {
      sections.push({ name: currentName, lines: currentLines });
      currentName = '(between steps)';
      currentLines = [];
      continue;
    }

    currentLines.push(line);
  }

  // Flush remaining lines
  if (currentLines.length > 0) {
    sections.push({ name: currentName, lines: currentLines });
  }

  return sections;
}

/**
 * Classify sections by presence of ##[error] markers rather than trying to
 * match log group names to API step names (which use different naming).
 */
function classifySections(
  sections: RawSection[],
): Array<{ name: string; conclusion: string; lines: string[] }> {
  return sections.map((section) => {
    const hasError = section.lines.some((line) => {
      const stripped = line.replace(TIMESTAMP_RE, '');
      return stripped.includes(ERROR_MARKER);
    });
    return {
      name: section.name,
      conclusion: hasError ? 'failure' : 'success',
      lines: section.lines,
    };
  });
}
