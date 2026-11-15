import { z } from 'zod';
import { paginationQuerySchema } from '../common/pagination.js';
import { DEFECT_SEVERITIES } from '../defects/defect.contracts.js';
import { PRIORITIES } from '../requirements/requirement.contracts.js';

/**
 * Exploratory testing (S7-F5): a time-boxed session with a charter, run by one
 * tester, that records notes and findings on a timeline. Findings can become
 * defects or point at existing ones. Once completed or cancelled the session
 * is immutable history; archiving only hides it.
 *
 * planned → active ⇄ paused → completed → archived; planned, active and
 * paused can be cancelled, a planned session can be archived directly.
 */
export const EXPLORATORY_STATUSES = [
  'planned',
  'active',
  'paused',
  'completed',
  'cancelled',
  'archived',
] as const;
export type ExploratoryStatus = (typeof EXPLORATORY_STATUSES)[number];

export const EXPLORATORY_TRANSITIONS: Record<ExploratoryStatus, readonly ExploratoryStatus[]> = {
  planned: ['active', 'cancelled', 'archived'],
  active: ['paused', 'completed', 'cancelled'],
  paused: ['active', 'completed', 'cancelled'],
  completed: ['archived'],
  cancelled: ['archived'],
  archived: [],
};

export const EXPLORATORY_ACTIONS = [
  'start',
  'pause',
  'resume',
  'complete',
  'cancel',
  'archive',
] as const;
export type ExploratoryAction = (typeof EXPLORATORY_ACTIONS)[number];

export const EXPLORATORY_ACTION_TARGET: Record<ExploratoryAction, ExploratoryStatus> = {
  start: 'active',
  pause: 'paused',
  resume: 'active',
  complete: 'completed',
  cancel: 'cancelled',
  archive: 'archived',
};

/** `start` only leaves `planned`, `resume` only leaves `paused`. */
export function canRunExploratoryAction(
  from: ExploratoryStatus,
  action: ExploratoryAction,
): boolean {
  if (action === 'start' && from !== 'planned') {
    return false;
  }
  if (action === 'resume' && from !== 'paused') {
    return false;
  }
  return EXPLORATORY_TRANSITIONS[from].includes(EXPLORATORY_ACTION_TARGET[action]);
}

/** Planned, active and paused sessions can still be edited. */
export function isOpenExploratory(status: ExploratoryStatus): boolean {
  return status === 'planned' || status === 'active' || status === 'paused';
}

/** Notes and findings are recorded while the session is running or paused. */
export function isRecordingExploratory(status: ExploratoryStatus): boolean {
  return status === 'active' || status === 'paused';
}

export const FINDING_KINDS = ['bug', 'risk', 'question', 'improvement'] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];
export type FindingSeverity = (typeof DEFECT_SEVERITIES)[number];

export const EXPLORATORY_EVENT_TYPES = [
  'created',
  'updated',
  'started',
  'paused',
  'resumed',
  'completed',
  'cancelled',
  'archived',
  'note',
  'finding',
  'defect_created',
  'defect_linked',
  'defect_unlinked',
  'work_item_linked',
  'work_item_unlinked',
] as const;
export type ExploratoryEventType = (typeof EXPLORATORY_EVENT_TYPES)[number];

const idSchema = z.string().min(1).max(64);

/** Attachment or link metadata only: the file itself lives elsewhere. */
export const sessionLinkSchema = z.object({
  label: z.string().trim().min(1).max(120),
  url: z
    .string()
    .trim()
    .url()
    .max(2000)
    .refine((value) => /^https?:\/\//i.test(value), 'Only http and https links'),
  kind: z.enum(['link', 'attachment']).default('link'),
});
export type SessionLinkInput = z.infer<typeof sessionLinkSchema>;

export const createExploratorySessionSchema = z.object({
  projectId: idSchema,
  title: z.string().trim().min(3).max(160),
  charter: z.string().trim().min(1).max(5000),
  /** Defaults to the creator. */
  ownerId: idSchema.nullish(),
  environmentId: idSchema.nullish(),
  releaseId: idSchema.nullish(),
  testPlanId: idSchema.nullish(),
  testCycleId: idSchema.nullish(),
  timeboxMinutes: z.number().int().min(5).max(480).nullish(),
  links: z.array(sessionLinkSchema).max(20).default([]),
});
export type CreateExploratorySessionInput = z.infer<typeof createExploratorySessionSchema>;

export const updateExploratorySessionSchema = z
  .object({
    title: z.string().trim().min(3).max(160).optional(),
    charter: z.string().trim().min(1).max(5000).optional(),
    notes: z.string().trim().max(50_000).nullish(),
    risks: z.string().trim().max(20_000).nullish(),
    ownerId: idSchema.optional(),
    environmentId: idSchema.nullish(),
    releaseId: idSchema.nullish(),
    testPlanId: idSchema.nullish(),
    testCycleId: idSchema.nullish(),
    timeboxMinutes: z.number().int().min(5).max(480).nullish(),
    links: z.array(sessionLinkSchema).max(20).optional(),
    version: z.number().int().min(1).optional(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== 'version'), 'Nothing to update');
export type UpdateExploratorySessionInput = z.infer<typeof updateExploratorySessionSchema>;

export const exploratoryActionSchema = z.object({ version: z.number().int().min(1).optional() });
export type ExploratoryActionInput = z.infer<typeof exploratoryActionSchema>;

export const addSessionNoteSchema = z.object({ body: z.string().trim().min(1).max(5000) });
export type AddSessionNoteInput = z.infer<typeof addSessionNoteSchema>;

export const createFindingSchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(10_000).nullish(),
  kind: z.enum(FINDING_KINDS).default('bug'),
  severity: z.enum(DEFECT_SEVERITIES).default('major'),
});
export type CreateFindingInput = z.infer<typeof createFindingSchema>;

export const convertFindingSchema = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  priority: z.enum(PRIORITIES).default('medium'),
});
export type ConvertFindingInput = z.infer<typeof convertFindingSchema>;

export const linkSessionDefectSchema = z.object({ defectId: idSchema });
export type LinkSessionDefectInput = z.infer<typeof linkSessionDefectSchema>;

export const linkSessionWorkItemSchema = z.object({ workItemId: idSchema });
export type LinkSessionWorkItemInput = z.infer<typeof linkSessionWorkItemSchema>;

export const listExploratorySessionsQuerySchema = paginationQuerySchema.extend({
  projectId: idSchema,
  status: z.enum(EXPLORATORY_STATUSES).optional(),
  ownerId: idSchema.optional(),
  environmentId: idSchema.optional(),
  releaseId: idSchema.optional(),
  testPlanId: idSchema.optional(),
  testCycleId: idSchema.optional(),
});
export type ListExploratorySessionsQuery = z.infer<typeof listExploratorySessionsQuerySchema>;

/**
 * Active testing time in seconds: from start to end (or `now`) minus the time
 * spent paused, including a pause that is still running. `null` before start.
 */
export function sessionDurationSeconds(
  session: {
    startedAt: Date | string | null;
    endedAt: Date | string | null;
    pausedAt: Date | string | null;
    pausedSeconds: number;
  },
  now: Date = new Date(),
): number | null {
  if (session.startedAt === null) {
    return null;
  }
  const time = (value: Date | string) => new Date(value).getTime();
  const end = session.endedAt === null ? now.getTime() : time(session.endedAt);
  const runningPause =
    session.pausedAt === null || session.endedAt !== null
      ? 0
      : Math.max(0, end - time(session.pausedAt));
  const seconds = Math.floor((end - time(session.startedAt) - runningPause) / 1000);
  return Math.max(0, seconds - session.pausedSeconds);
}

export interface FindingMetricsInput {
  kind: FindingKind;
  severity: FindingSeverity;
  defectId: string | null;
  defectCreated: boolean;
}

export interface ExploratoryMetrics {
  durationSeconds: number | null;
  timeboxMinutes: number | null;
  findings: number;
  byKind: Record<FindingKind, number>;
  bySeverity: Record<FindingSeverity, number>;
  defectsCreated: number;
  /** Distinct defects related through findings or directly to the session. */
  defectsLinked: number;
  notes: number;
}

export function summarizeFindings(
  findings: readonly FindingMetricsInput[],
  sessionDefectIds: readonly string[] = [],
): Pick<
  ExploratoryMetrics,
  'findings' | 'byKind' | 'bySeverity' | 'defectsCreated' | 'defectsLinked'
> {
  const byKind = Object.fromEntries(FINDING_KINDS.map((kind) => [kind, 0])) as Record<
    FindingKind,
    number
  >;
  const bySeverity = Object.fromEntries(
    DEFECT_SEVERITIES.map((severity) => [severity, 0]),
  ) as Record<FindingSeverity, number>;
  const defects = new Set(sessionDefectIds);
  let defectsCreated = 0;
  for (const finding of findings) {
    byKind[finding.kind] += 1;
    bySeverity[finding.severity] += 1;
    if (finding.defectId !== null) {
      defects.add(finding.defectId);
      if (finding.defectCreated) {
        defectsCreated += 1;
      }
    }
  }
  return {
    findings: findings.length,
    byKind,
    bySeverity,
    defectsCreated,
    defectsLinked: defects.size,
  };
}

export interface ExploratoryDefectRef {
  id: string;
  key: string;
  title: string;
  severity: string;
  status: string;
}

export interface ExploratoryFindingView {
  id: string;
  title: string;
  description: string | null;
  kind: FindingKind;
  severity: FindingSeverity;
  defect: ExploratoryDefectRef | null;
  defectCreated: boolean;
  createdBy: { id: string; fullName: string } | null;
  createdAt: string;
}

export interface ExploratoryEventView {
  id: string;
  type: ExploratoryEventType;
  body: string | null;
  findingId: string | null;
  actor: { id: string; fullName: string } | null;
  createdAt: string;
}

export interface ExploratorySessionView {
  id: string;
  projectId: string;
  title: string;
  charter: string;
  status: ExploratoryStatus;
  owner: { id: string; fullName: string } | null;
  environment: { id: string; name: string } | null;
  release: { id: string; name: string; version: string } | null;
  testPlan: { id: string; name: string } | null;
  testCycle: { id: string; name: string } | null;
  timeboxMinutes: number | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  findingCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ExploratorySessionDetailView extends ExploratorySessionView {
  notes: string | null;
  risks: string | null;
  links: Array<{ label: string; url: string; kind: 'link' | 'attachment' }>;
  findings: ExploratoryFindingView[];
  timeline: ExploratoryEventView[];
  workItems: Array<{ id: string; key: string; title: string; status: string }>;
  defects: Array<ExploratoryDefectRef & { source: 'finding' | 'session' }>;
  metrics: ExploratoryMetrics;
}
