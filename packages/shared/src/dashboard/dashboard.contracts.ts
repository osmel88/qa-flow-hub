import { z } from 'zod';
import { paginationQuerySchema } from '../common/pagination.js';

export const dashboardQuerySchema = z.object({
  /** Omitted, the dashboard covers every project in the organization. */
  projectId: z.string().min(1).optional(),
});
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

export const AUDIT_ACTIONS = [
  'create',
  'update',
  'delete',
  'archive',
  'restore',
  'login',
  'logout',
  'invite',
  'accept_invite',
  'revoke_invite',
  'role_change',
  'execute',
  'export',
] as const;
export type AuditActionName = (typeof AUDIT_ACTIONS)[number];

export const listAuditQuerySchema = paginationQuerySchema.extend({
  action: z.enum(AUDIT_ACTIONS).optional(),
  entityType: z.string().trim().min(1).max(60).optional(),
  entityId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type ListAuditQuery = z.infer<typeof listAuditQuerySchema>;

export interface AuditEntryView {
  id: string;
  userId: string | null;
  action: AuditActionName;
  entityType: string;
  entityId: string | null;
  summary: string | null;
  changes: unknown;
  ipAddress: string | null;
  requestId: string | null;
  createdAt: string;
}

export interface DashboardSummary {
  projects: { active: number; archived: number };
  requirements: { total: number; byStatus: Record<string, number> };
  testCases: { total: number; byStatus: Record<string, number> };
  runs: {
    active: number;
    completed: number;
    recent: Array<{
      id: string;
      name: string;
      status: string;
      completion: number;
      startedAt: string | null;
    }>;
  };
  results: Record<string, number>;
  defects: { open: number; bySeverity: Record<string, number> };
  coverage: { requirements: number; covered: number; percentage: number };
}
