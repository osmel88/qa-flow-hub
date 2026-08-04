import { z } from 'zod';

export const LINKABLE_ENTITIES = [
  'requirement',
  'test_case',
  'test_run',
  'test_result',
  'defect',
  'project',
  'automated_test',
] as const;
export type LinkableEntity = (typeof LINKABLE_ENTITIES)[number];

export const TRACE_LINK_TYPES = [
  'verifies',
  'covers',
  'relates_to',
  'caused_by',
  'automates',
  'blocks',
] as const;
export type TraceLinkType = (typeof TRACE_LINK_TYPES)[number];

export const createTraceLinkSchema = z
  .object({
    sourceType: z.enum(LINKABLE_ENTITIES),
    sourceId: z.string().min(1),
    targetType: z.enum(LINKABLE_ENTITIES),
    targetId: z.string().min(1),
    linkType: z.enum(TRACE_LINK_TYPES).default('relates_to'),
  })
  .refine((value) => !(value.sourceType === value.targetType && value.sourceId === value.targetId), {
    message: 'An entity cannot be linked to itself',
  });
export type CreateTraceLinkInput = z.infer<typeof createTraceLinkSchema>;

export const listTraceLinksQuerySchema = z.object({
  entityType: z.enum(LINKABLE_ENTITIES),
  entityId: z.string().min(1),
});
export type ListTraceLinksQuery = z.infer<typeof listTraceLinksQuerySchema>;

export const traceabilityMatrixQuerySchema = z.object({
  projectId: z.string().min(1),
  /** Requirements with no covering case are the point of the matrix. */
  uncoveredOnly: z.enum(['true', 'false']).default('false'),
});
export type TraceabilityMatrixQuery = z.infer<typeof traceabilityMatrixQuerySchema>;

export interface TraceLinkView {
  id: string;
  sourceType: LinkableEntity;
  sourceId: string;
  targetType: LinkableEntity;
  targetId: string;
  linkType: TraceLinkType;
  createdById: string | null;
  createdAt: string;
}

export interface MatrixCase {
  id: string;
  key: string;
  title: string;
  /** Worst outcome across every run the case took part in. */
  lastStatus: 'untested' | 'passed' | 'failed' | 'blocked' | 'skipped';
}

export interface MatrixRow {
  requirementId: string;
  key: string;
  title: string;
  status: string;
  priority: string;
  cases: MatrixCase[];
  defectIds: string[];
  covered: boolean;
  verified: boolean;
}

export interface TraceabilityMatrix {
  projectId: string;
  rows: MatrixRow[];
  summary: {
    requirements: number;
    covered: number;
    verified: number;
    /** Percentage of requirements with at least one linked case. */
    coverage: number;
    uncovered: number;
    openDefects: number;
  };
}
