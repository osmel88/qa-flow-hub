import { z } from 'zod';
import { DEFECT_STATUSES, DefectStatus } from '../defects/defect.contracts.js';

// ---------------------------------------------------------------------------
// Defect workflow
// ---------------------------------------------------------------------------

export const CLOSING_DEFECT_STATUSES: readonly DefectStatus[] = ['closed', 'rejected'];

/** Who may perform a transition, on top of `defects.create` for the route. */
export const WORKFLOW_TRANSITION_PERMISSIONS = ['defects.create', 'defects.manage'] as const;
export type WorkflowTransitionPermission = (typeof WORKFLOW_TRANSITION_PERMISSIONS)[number];

export const workflowTransitionSchema = z.object({
  from: z.enum(DEFECT_STATUSES),
  to: z.enum(DEFECT_STATUSES),
  permission: z.enum(WORKFLOW_TRANSITION_PERMISSIONS).default('defects.create'),
  /** Defect custom fields that must hold a value for the move to happen. */
  requiredFieldIds: z.array(z.string().min(1).max(40)).max(20).default([]),
});
export type WorkflowTransitionInput = z.infer<typeof workflowTransitionSchema>;

export interface WorkflowTransition {
  from: DefectStatus;
  to: DefectStatus;
  permission: WorkflowTransitionPermission;
  requiredFieldIds: string[];
}

/**
 * The built-in graph, unchanged from before S3-F7. A project without a stored
 * workflow uses it, so nothing changes until somebody customises it.
 */
export const DEFAULT_DEFECT_TRANSITIONS: readonly WorkflowTransition[] = (
  [
    ['open', ['triaged', 'in_progress', 'rejected']],
    ['triaged', ['in_progress', 'rejected', 'open']],
    ['in_progress', ['resolved', 'triaged', 'rejected']],
    ['resolved', ['closed', 'reopened']],
    ['closed', ['reopened']],
    ['rejected', ['reopened']],
    ['reopened', ['triaged', 'in_progress', 'rejected']],
  ] as const
).flatMap(([from, targets]) =>
  targets.map((to) => ({
    from,
    to,
    permission: 'defects.create' as const,
    requiredFieldIds: [],
  })),
);

/**
 * Structural rules for a workflow; field references are checked by the server.
 * Every status must still be able to reach a closing status, so no defect —
 * including one already sitting in a status nobody enters any more — can be
 * trapped by a configuration change.
 */
export function workflowProblems(transitions: readonly WorkflowTransitionInput[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const transition of transitions) {
    const id = `${transition.from}->${transition.to}`;
    if (transition.from === transition.to) problems.push(`${id} does not change the status`);
    if (seen.has(id)) problems.push(`${id} is listed twice`);
    seen.add(id);
  }
  for (const status of DEFECT_STATUSES) {
    if (CLOSING_DEFECT_STATUSES.includes(status)) continue;
    const reached = new Set<DefectStatus>([status]);
    const queue: DefectStatus[] = [status];
    while (queue.length > 0) {
      const current = queue.shift() as DefectStatus;
      for (const transition of transitions) {
        if (transition.from === current && !reached.has(transition.to)) {
          reached.add(transition.to);
          queue.push(transition.to);
        }
      }
    }
    if (!CLOSING_DEFECT_STATUSES.some((closing) => reached.has(closing))) {
      problems.push(`A defect in ${status} could never be closed or rejected`);
    }
  }
  return problems;
}

export const updateDefectWorkflowSchema = z
  .object({
    projectId: z.string().min(1),
    /** Optimistic concurrency: the version the editor started from. */
    version: z.number().int().min(0),
    transitions: z
      .array(workflowTransitionSchema)
      .min(1)
      .max(DEFECT_STATUSES.length ** 2),
  })
  .superRefine((value, ctx) => {
    for (const problem of workflowProblems(value.transitions)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['transitions'], message: problem });
    }
  });
export type UpdateDefectWorkflowInput = z.infer<typeof updateDefectWorkflowSchema>;

export const defectWorkflowQuerySchema = z.object({ projectId: z.string().min(1) });
export type DefectWorkflowQuery = z.infer<typeof defectWorkflowQuerySchema>;

export interface DefectWorkflowView {
  projectId: string;
  /** 0 while the project uses the built-in workflow. */
  version: number;
  customized: boolean;
  transitions: WorkflowTransition[];
  updatedAt: string | null;
}
