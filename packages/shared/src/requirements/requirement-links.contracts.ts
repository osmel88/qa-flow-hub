import { z } from 'zod';
import type { WorkItemStatus, WorkItemType } from '../work-items/work-item.contracts.js';
import type {
  ImplementationState,
  RequirementImplementation,
  RequirementStatus,
} from './requirement.contracts.js';

export type { RequirementImplementation } from './requirement.contracts.js';

/** The semantic of a requirement ↔ work item link. Only `implements` for now. */
export const REQUIREMENT_LINK_TYPES = ['implements'] as const;
export type RequirementLinkType = (typeof REQUIREMENT_LINK_TYPES)[number];

const idSchema = z.string().trim().min(1).max(64);

export const linkWorkItemSchema = z.object({
  workItemId: idSchema,
  linkType: z.enum(REQUIREMENT_LINK_TYPES).default('implements'),
});
export type LinkWorkItemInput = z.infer<typeof linkWorkItemSchema>;

export const linkRequirementSchema = z.object({
  requirementId: idSchema,
  linkType: z.enum(REQUIREMENT_LINK_TYPES).default('implements'),
});
export type LinkRequirementInput = z.infer<typeof linkRequirementSchema>;

export interface LinkedWorkItemView {
  linkId: string;
  linkType: RequirementLinkType;
  workItemId: string;
  key: string;
  title: string;
  type: WorkItemType;
  status: WorkItemStatus;
  releaseId: string | null;
  linkedAt: string;
}

export interface LinkedRequirementView {
  linkId: string;
  linkType: RequirementLinkType;
  requirementId: string;
  key: string;
  title: string;
  status: RequirementStatus;
  linkedAt: string;
}

export interface RequirementWorkItemsView {
  requirementId: string;
  implementation: RequirementImplementation;
  workItems: LinkedWorkItemView[];
}

/** Result of a link request: `created` is false when the link already existed. */
export interface RequirementLinkResult {
  created: boolean;
  requirementId: string;
  workItemId: string;
  linkType: RequirementLinkType;
}

/**
 * Not implemented: nothing done yet (or nothing linked). Implemented: every
 * non-cancelled implementing item is done. Partially: anything in between.
 */
export function computeImplementation(
  statuses: readonly WorkItemStatus[],
): RequirementImplementation {
  const done = statuses.filter((status) => status === 'done').length;
  const cancelled = statuses.filter((status) => status === 'cancelled').length;
  const countable = statuses.length - cancelled;
  let state: ImplementationState = 'not_implemented';
  if (countable > 0 && done === countable) {
    state = 'implemented';
  } else if (done > 0) {
    state = 'partially_implemented';
  }
  return {
    state,
    workItems: statuses.length,
    done,
    cancelled,
    progress: countable === 0 ? null : Math.round((done / countable) * 1000) / 10,
  };
}
