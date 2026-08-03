import { z } from 'zod';
import { paginationQuerySchema } from '../common/pagination.js';

export const PROJECT_STATUSES = ['active', 'archived'] as const;

/**
 * The project key is the prefix of every human-readable identifier in the
 * project (`WEB-C-102`), so it is short, uppercase and immutable after
 * creation: changing it would orphan every key anybody has ever written in a
 * ticket, a chat message or a release note.
 */
export const projectKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(2)
  .max(8)
  .regex(/^[A-Z][A-Z0-9]*$/, 'Use 2 to 8 characters: letters and digits, starting with a letter');

export const createProjectSchema = z.object({
  name: z.string().trim().min(2).max(120),
  key: projectKeySchema,
  description: z.string().trim().max(2000).optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

/**
 * `status` is absent on purpose: archiving is a transition with rules (it sets
 * `archivedAt`, and an archived project rejects writes), not a field somebody
 * types. It has its own endpoints, `POST /projects/:id/archive` and
 * `/restore`, so the audit trail records the intent rather than a diff.
 */
export const updateProjectSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    description: z.string().trim().max(2000).nullish(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const listProjectsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(PROJECT_STATUSES).optional(),
  search: z.string().trim().min(1).max(120).optional(),
});
export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;

export interface ProjectView {
  id: string;
  name: string;
  key: string;
  description: string | null;
  status: (typeof PROJECT_STATUSES)[number];
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
