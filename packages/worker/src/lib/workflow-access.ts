/**
 * Workflow access control.
 *
 * Single helper called by every workflow API endpoint
 * (read/draft/publish/test-run/cancel/approve/restore/etc) before doing
 * work. All three roles (viewer/editor/publisher) are satisfied by
 * ownership of `workflows.user_id`. The signature accommodates future
 * additions: org sharing, reviewer/approver splits.
 */

import { eq, or, and } from 'drizzle-orm';
import { workflows } from './schema/workflows.js';
import type { AppDb } from './drizzle.js';

export type WorkflowRole = 'viewer' | 'editor' | 'publisher';

export interface AccessedWorkflow {
  id: string;
  userId: string;
}

/**
 * Throw NotFoundError if the user lacks the requested role on the
 * workflow. Returns a lightweight workflow stub on success. Accepts ID
 * or slug — same form as the existing getWorkflowByIdOrSlug helper.
 */
export async function assertWorkflowAccess(
  db: AppDb,
  user: { id: string },
  workflowIdOrSlug: string,
  // Role is accepted but not used in MVP — owner satisfies all three.
  // Kept so call sites declare intent and post-MVP can add real role
  // gating without changing them.
  _role: WorkflowRole = 'viewer',
): Promise<AccessedWorkflow> {
  const row = await db
    .select({ id: workflows.id, userId: workflows.userId })
    .from(workflows)
    .where(and(
      or(eq(workflows.id, workflowIdOrSlug), eq(workflows.slug, workflowIdOrSlug)),
      eq(workflows.userId, user.id),
    ))
    .get();

  if (!row) {
    const { NotFoundError } = await import('@valet/shared');
    throw new NotFoundError('Workflow', workflowIdOrSlug);
  }
  return { id: row.id, userId: row.userId };
}
