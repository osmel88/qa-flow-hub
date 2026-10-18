# 0017 — Project visibility through grants, enforced in services

Status: accepted
Date: 2026-11-01
Related: [0006](0006-multi-tenancy-strategy.md),
[0013](0013-row-level-security-with-non-owning-role.md)

## Context

Until S3-F2 a project grant changed what a member could _do_ in a project, not
whether they could _see_ it: every member of an organization discovered every
project name (debt 22). A customer hosting two client teams in one organization
cannot accept that.

## Options evaluated

| Option                                               | What hides a project                      | Cost                                                                |
| ---------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------- |
| New `visibility` column per project (public/private) | A flag plus grants for private projects   | Migration, a product decision per project, two rules to explain     |
| **Grants are required below admin**                  | The absence of a `project_members` row    | No migration; existing grants keep working; `role: null` = org role |
| Per-user RLS policy on every project-scoped table    | PostgreSQL, joined with `project_members` | Migration over every policy, a sub-select on every read             |

## Decision

1. **Owners and admins see every project; every other role sees only projects
   it holds a grant in.** A grant may carry a role or `null` (the organization
   role applies).
2. **A hidden project is answered like a missing one.** `effectiveRole()`
   throws `NotFoundError(resource)`, so `GET /projects/:id`, entity routes and
   errors match a made-up id byte for byte (bar the request id). Lists that take
   a `projectId` return the same empty page for both.
3. **Lists are filtered in the query**, before search and pagination, so totals
   do not count hidden projects. Aggregates go through `projectsAllowing()`,
   which excludes projects without a grant.
4. **Enforced in services, not RLS.** RLS stays the organization boundary
   (ADR 0013). The visibility rule lives in `ProjectAccessService`, already
   called once per project-scoped request and checked by
   `ProjectScopeContractInterceptor`.

## Consequences

- Existing members below admin lose the projects they had no grant in. The
  project access page lists them with "No access" and gives access in one click.
- Revoking a grant drops the overrides of that member in that project.
- Assigning work requires the assignee to see the project, so notifications
  never name a hidden project.
- A missed visibility check in a new service is not caught by the database
  (debt 39); the integration suite compares every project read against a
  made-up id to catch it.
