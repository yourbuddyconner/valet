import type { WorkflowStep } from '@/api/workflows';

// A short random hex suffix keeps step IDs unique even when the user adds
// several steps of the same kind in a row. We avoid crypto.randomUUID() so the
// IDs stay short and human-readable (e.g. "bash_4f1a").
function shortHex(): string {
  return Math.random().toString(16).slice(2, 6);
}

function uniqueId(prefix: string, existingIds: ReadonlySet<string>): string {
  let candidate = `${prefix}_${shortHex()}`;
  while (existingIds.has(candidate)) {
    candidate = `${prefix}_${shortHex()}`;
  }
  return candidate;
}

const DEFAULT_NAMES: Record<WorkflowStep['type'], string> = {
  bash: 'Run command',
  tool: 'Call tool',
  agent_prompt: 'Ask agent',
  notify: 'Notify',
  conditional: 'If',
  parallel: 'In parallel',
  loop: 'For each',
  approval: 'Approval',
};

/**
 * Build a fresh WorkflowStep of the given type with sensible empty defaults.
 * The caller passes the set of existing IDs across the whole workflow tree so
 * we never collide.
 */
export function makeStepOfType(
  type: WorkflowStep['type'],
  existingIds: ReadonlySet<string>,
): WorkflowStep {
  const id = uniqueId(type, existingIds);
  const base: WorkflowStep = {
    id,
    name: DEFAULT_NAMES[type],
    type,
  };
  switch (type) {
    case 'bash':
      return { ...base, command: '' };
    case 'tool':
      return { ...base, tool: '', arguments: {} };
    case 'agent_prompt':
      return { ...base, prompt: '', thread: 'main' };
    case 'notify':
      return { ...base, content: '' };
    case 'conditional':
      return { ...base, condition: '', then: [], else: [] };
    case 'parallel':
      return { ...base, steps: [] };
    case 'loop':
      // `over` is the foreach source expression; `itemVar` is the per-iteration
      // binding name. Both empty so the inspector form can guide the user.
      return { ...base, over: '', itemVar: 'item', steps: [] };
    case 'approval':
      return { ...base, prompt: '' };
  }
}

/** Recursively walk the tree, inserting newStep right after targetId. */
export function insertAfter(
  steps: WorkflowStep[],
  targetId: string,
  newStep: WorkflowStep,
): WorkflowStep[] {
  const out: WorkflowStep[] = [];
  let inserted = false;
  for (const step of steps) {
    const rewritten = recurseIntoContainers(step, (children) =>
      insertAfter(children, targetId, newStep),
    );
    out.push(rewritten);
    if (!inserted && step.id === targetId) {
      out.push(newStep);
      inserted = true;
    }
  }
  return out;
}

/** Recursively find a container by id and append newStep to its slot. */
export function insertInto(
  steps: WorkflowStep[],
  containerId: string,
  slot: 'then' | 'else' | 'steps',
  newStep: WorkflowStep,
): WorkflowStep[] {
  return steps.map((step) => {
    if (step.id === containerId) {
      // Guard: only append to the slot when the container's type matches.
      // `then`/`else` only on conditional; `steps` only on parallel/loop.
      if (slot === 'then' && step.type === 'conditional') {
        return { ...step, then: [...(step.then ?? []), newStep] };
      }
      if (slot === 'else' && step.type === 'conditional') {
        return { ...step, else: [...(step.else ?? []), newStep] };
      }
      if (slot === 'steps' && (step.type === 'parallel' || step.type === 'loop')) {
        return { ...step, steps: [...(step.steps ?? []), newStep] };
      }
      return step;
    }
    return recurseIntoContainers(step, (children) =>
      insertInto(children, containerId, slot, newStep),
    );
  });
}

/** Recursively remove a step by id from anywhere in the tree. */
export function removeStep(steps: WorkflowStep[], stepId: string): WorkflowStep[] {
  const out: WorkflowStep[] = [];
  for (const step of steps) {
    if (step.id === stepId) continue;
    out.push(
      recurseIntoContainers(step, (children) => removeStep(children, stepId)),
    );
  }
  return out;
}

/** Collect every step ID in the tree — used to seed `makeStepOfType` uniqueness. */
export function collectAllStepIds(steps: WorkflowStep[]): Set<string> {
  const out = new Set<string>();
  function walk(list: WorkflowStep[]): void {
    for (const s of list) {
      out.add(s.id);
      if (s.then) walk(s.then);
      if (s.else) walk(s.else);
      if (s.steps) walk(s.steps);
    }
  }
  walk(steps);
  return out;
}

// Apply `fn` to whichever container children a step has, leaving non-containers
// untouched. Keeps the four insert/remove helpers small.
function recurseIntoContainers(
  step: WorkflowStep,
  fn: (children: WorkflowStep[]) => WorkflowStep[],
): WorkflowStep {
  let next: WorkflowStep = step;
  if (step.then) next = { ...next, then: fn(step.then) };
  if (step.else) next = { ...next, else: fn(step.else) };
  if (step.steps) next = { ...next, steps: fn(step.steps) };
  return next;
}
