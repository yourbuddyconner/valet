/**
 * Per-instance step identity. See docs/specs/2026-05-23-workflow-ui-design.md.
 *
 * Path grammar: `/`-joined `<containerStepId>:<discriminator>` segments.
 * - Loop: `:i<index>`
 * - Parallel: `:b<branchIndex>`
 * - Conditional: `:then` or `:else`
 * Empty string for top-level steps.
 */

export interface IterationSegment {
  containerStepId: string;
  discriminator: string;
}

const ILLEGAL = /[/:]/;

export function appendIterationSegment(
  parent: string,
  containerStepId: string,
  discriminator: string,
): string {
  if (ILLEGAL.test(containerStepId)) {
    throw new Error(`iterationPath: containerStepId contains illegal char: ${containerStepId}`);
  }
  if (ILLEGAL.test(discriminator)) {
    throw new Error(`iterationPath: discriminator contains illegal char: ${discriminator}`);
  }
  const segment = `${containerStepId}:${discriminator}`;
  return parent ? `${parent}/${segment}` : segment;
}

export function parseIterationPath(path: string): IterationSegment[] {
  if (!path) return [];
  return path.split('/').map((seg) => {
    const idx = seg.indexOf(':');
    if (idx < 0) {
      throw new Error(`iterationPath: malformed segment: ${seg}`);
    }
    return { containerStepId: seg.slice(0, idx), discriminator: seg.slice(idx + 1) };
  });
}
